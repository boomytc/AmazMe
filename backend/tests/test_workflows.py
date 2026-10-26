"""Workflows keep an independent verdict, a bounded correction, and isolated child context."""

import json
import shutil
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from pydantic import BaseModel, SecretStr
from session_test_support import session_database_owner, session_state

from amazme_backend.agent.driver import Worker
from amazme_backend.agent.model import stream
from amazme_backend.ai.types import Auth
from amazme_backend.bootstrap.worker import create_worker
from amazme_backend.contracts import (
    BackendError,
    Cleanup,
    CreateSession,
    HostFence,
    Lease,
    Message,
    ProcessLease,
    ProviderConfig,
    Submit,
    ToolResult,
    WorkspaceGrantRequest,
)
from amazme_backend.contracts.ipc.worker import SessionOp, SessionOpResult
from amazme_backend.host.service import Host
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.ipc import Peer
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sessions.client import SessionRelay
from amazme_backend.sessions.persistence.records import load_run
from amazme_backend.sessions.policy.projection import correction_text
from amazme_backend.sessions.service import SessionStore, run_session_op
from amazme_backend.sessions.types import (
    Action,
    CloseEpoch,
    Completion,
    Continue,
    EpochClosed,
    EpochOpened,
    Failed,
    ModelInvocation,
    ModelReturned,
    OpenEpoch,
    Park,
    ToolInvocation,
    ToolReturned,
)

SESSION = "a" * 32
SECRET = "父会话秘密"
CHECK = "只检查这一句"
KEY = "sk-test-not-real"


class SessionOpPeer(Peer):
    """Keep child execution under Driver while HTTP uses the typed worker protocol."""

    def __init__(self, access: WorkerSessions, session: str):
        self.lifecycle = access.lifecycle
        self.session = session

    async def call[T: BaseModel](
        self, method: str, path: str, response: type[T], body: BaseModel | None = None,
    ) -> T:
        assert method == "POST" and path == "/session-ops" and response is SessionOpResult
        assert isinstance(body, SessionOp)
        operation = SessionOp.model_validate_json(body.model_dump_json())
        database = session_database(self.lifecycle.profile.path, self.session)
        database.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        store = SessionStore(database, self.session, build=self.lifecycle.build,
                             config=self.lifecycle.profile.config.provider,
                             approval_policy=self.lifecycle.profile.config.approval_policy)
        try:
            await store.initialize()
            payload = await run_session_op(store, operation.name, operation.payload)
            return response.model_validate_json(SessionOpResult(payload=payload).model_dump_json())
        finally:
            await store.close()

    async def close(self) -> None:
        pass


@pytest.fixture(autouse=True)
def session_ipc(monkeypatch: pytest.MonkeyPatch) -> None:
    async def worker(access: WorkerSessions, session: str) -> Peer:
        return SessionOpPeer(access, session)

    @asynccontextmanager
    async def maintenance(access: WorkerSessions, session: str, *,
                          closing: bool = False, allow_business: bool = False) -> AsyncIterator[SessionRelay]:
        yield SessionRelay(SessionOpPeer(access, session))

    monkeypatch.setattr(WorkerSessions, "worker", worker)
    monkeypatch.setattr(WorkerSessions, "maintenance", maintenance)


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "flow", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:12345"
    return host


class Driver:
    def __init__(self, store: SessionStore):
        self.store = store
        self.models: list[ModelInvocation] = []
        self.epoch = 0

    async def next(self) -> Action:
        for _ in range(100):
            action = await self.store.advance()
            if not isinstance(action, Continue):
                return action
        pytest.fail("driver made no observable progress")

    async def respond(self, action: Action) -> None:
        if isinstance(action, ModelInvocation):
            self.models.append(action)
            async for item in stream(action.config, action.messages, auth=Auth(api_key=action.config.api_key, auth_type=action.config.auth_type)):
                if not isinstance(item, str):
                    await self.store.advance(ModelReturned(action, item))
        elif isinstance(action, OpenEpoch):
            self.epoch += 1
            await self.store.advance(EpochOpened(action.request_id, Lease(
                session_id=self.store.session_id, worker_id=session_state(self.store).instance, build_id=session_state(self.store).build,
                supervisor_id="supervisor", execution_epoch=self.epoch)))
        elif isinstance(action, ToolInvocation):
            await self.store.advance(ToolReturned(action, ToolResult(
                call_id=action.step_id, exit_code=0, stdout="ok", stderr="")))
        elif isinstance(action, CloseEpoch):
            await self.store.advance(EpochClosed(action.request_id, action.lease, Cleanup(
                session_id=self.store.session_id, execution_epoch=action.lease.execution_epoch,
                state="clean", resources=[], proof_id="proof")))
        else:
            pytest.fail(f"unexpected action {type(action).__name__}")

    async def until(self, expected: type[Action]) -> Action:
        for _ in range(100):
            action = await self.next()
            if isinstance(action, expected):
                return action
            await self.respond(action)
        pytest.fail(f"{expected.__name__} never arrived")

    async def drain(self) -> Park:
        action = await self.until(Park)
        assert isinstance(action, Park)
        return action


async def _seed(host: Host) -> None:
    path = session_database(host.lifecycle.profile.path, SESSION)
    path.parent.mkdir(parents=True, mode=0o700)
    store = SessionStore(path, SESSION, build=host.lifecycle.build, approval_policy="auto")
    await store.initialize()
    try:
        await store.accept(Submit(request_id="secret", text=SECRET), HostFence(host_epoch=0, build_id=host.lifecycle.build))
        assert (await Driver(store).drain()).reason == "idle"
    finally:
        await store.close()


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
        "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
    })


async def _attach(client: httpx.AsyncClient) -> None:
    attached = await client.post(f"/api/v1/sessions/{SESSION}/attachments")
    assert attached.status_code == 201
    client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]


def _open_body(workflow_id: str, check: str = CHECK, limit: int = 1) -> dict[str, object]:
    return {"workflow_id": workflow_id, "check": check, "correction_limit": limit}


async def test_workflow_isolates_child_context_and_stops_corrections(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="工作流"))
    await _seed(host)
    workflow_id = "c" * 32
    try:
        async with _client(host) as client:
            await _attach(client)
            opened = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body(workflow_id))
            assert opened.status_code == 200
            view = opened.json()
            check_id = view["children"][0]["request_id"]
            assert view["stage"] == "check" and view["parent_status"] == "waiting_children"
            assert view["children"] == [{
                "request_id": check_id, "role": "check", "text": CHECK, "status": "queued"}]
            secret_hits = await client.get(f"/api/v1/sessions/{SESSION}/search", params={"q": SECRET})
            check_hits = await client.get(f"/api/v1/sessions/{SESSION}/search", params={"q": CHECK})
            assert {hit["request_id"] for hit in secret_hits.json()["hits"]} == {"secret"}
            assert {hit["request_id"] for hit in check_hits.json()["hits"]} == {check_id}
            store = SessionStore(session_database(tmp_path, SESSION), SESSION, build=host.lifecycle.build,
                                 approval_policy="auto", require_existing=True)
            await store.initialize()
            try:
                driver = Driver(store)
                action = await driver.until(ModelInvocation)
                assert isinstance(action, ModelInvocation)
                assert action.request_id == check_id
                assert [f"{item.role}:{item.content}" for item in action.messages] == [f"user:{CHECK}"]
                assert await store.messages(view["parent_id"]) == []
                await driver.respond(action)
                assert (await driver.drain()).reason == "children"
                assert len(driver.models) == 1
                assert await store.messages(view["parent_id"]) == []
            finally:
                await store.close()
            again = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body(workflow_id))
            assert again.status_code == 200
            assert again.json()["children"][0]["request_id"] == check_id
            assert again.json()["children"][0]["status"] == "succeeded"
            failed = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{workflow_id}/verdicts",
                                       json={"verdict_id": "fail-1", "passed": False})
            assert failed.status_code == 200
            corrected = failed.json()
            assert corrected["stage"] == "correction" and corrected["attempts"] == 1
            assert [item["role"] for item in corrected["children"]] == ["check", "correction"]
            fix = corrected["children"][1]
            assert fix["text"] == correction_text(1)
            assert CHECK not in fix["text"] and SECRET not in fix["text"]
            repeated = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{workflow_id}/verdicts",
                                         json={"verdict_id": "fail-1", "passed": False})
            assert repeated.status_code == 200
            assert [item["request_id"] for item in repeated.json()["children"]] == [
                item["request_id"] for item in corrected["children"]]
            store = SessionStore(session_database(tmp_path, SESSION), SESSION, build=host.lifecycle.build,
                                 approval_policy="auto", require_existing=True)
            await store.initialize()
            try:
                driver = Driver(store)
                action = await driver.until(ModelInvocation)
                assert isinstance(action, ModelInvocation)
                assert action.request_id == fix["request_id"]
                assert [item.content for item in action.messages] == [fix["text"]]
                assert all(SECRET not in item.content and CHECK not in item.content for item in action.messages)
                await driver.respond(action)
                await driver.drain()
            finally:
                await store.close()
            exhausted = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{workflow_id}/verdicts",
                                          json={"verdict_id": "fail-2", "passed": False})
            assert exhausted.status_code == 200
            done = exhausted.json()
            assert done["stage"] == "exhausted" and done["attempts"] == 1
            assert [item["request_id"] for item in done["children"]] == [
                item["request_id"] for item in corrected["children"]]
            assert done["parent_status"] == "failed"
            resumed = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{workflow_id}/resume")
            assert resumed.status_code == 200
            assert resumed.json()["stage"] == "exhausted"
            assert [item["request_id"] for item in resumed.json()["children"]] == [
                item["request_id"] for item in done["children"]]
            passed_open = await client.post(
                f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("b" * 32, "通过检查"))
            assert passed_open.status_code == 200
            passed_child = passed_open.json()["children"][0]["request_id"]
            store = SessionStore(session_database(tmp_path, SESSION), SESSION, build=host.lifecycle.build,
                                 approval_policy="auto", require_existing=True)
            await store.initialize()
            try:
                driver = Driver(store)
                action = await driver.until(ModelInvocation)
                assert isinstance(action, ModelInvocation) and action.request_id == passed_child
                assert [item.content for item in action.messages] == ["通过检查"]
                await driver.respond(action)
                await driver.drain()
            finally:
                await store.close()
            passed = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'b' * 32}/verdicts",
                                       json={"verdict_id": "ok", "passed": True})
            assert passed.status_code == 200
            assert passed.json()["stage"] == "passed" and passed.json()["parent_status"] == "succeeded"
            assert [item["role"] for item in passed.json()["children"]] == ["check"]
        reopened = SessionStore(session_database(tmp_path, SESSION), SESSION, build=host.lifecycle.build, require_existing=True)
        await reopened.initialize()
        try:
            restored = await reopened.resume_workflow(workflow_id)
            assert restored.stage == "exhausted" and restored.attempts == 1
            assert [child.request_id for child in restored.children] == [
                item["request_id"] for item in done["children"]]
            before = len((await reopened.snapshot()).requests)
            assert (await reopened.resume_workflow(workflow_id)).children == restored.children
            assert len((await reopened.snapshot()).requests) == before
        finally:
            await reopened.close()
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_workflow_cancel_parent_cancels_children_only(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="取消"))
    try:
        async with _client(host) as client:
            await _attach(client)
            opened = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("d" * 32, "检查甲"))
            assert opened.status_code == 200
            child_id = opened.json()["children"][0]["request_id"]
            cancelled = await client.post(
                f"/api/v1/sessions/{SESSION}/workflows/{'d' * 32}/children/{child_id}/cancel")
            assert cancelled.status_code == 200
            body = cancelled.json()
            assert body["stage"] == "check" and body["parent_status"] == "waiting_children"
            assert len(body["children"]) == 1 and body["children"][0]["status"] == "cancelled"
            resumed = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'d' * 32}/resume")
            assert resumed.status_code == 200 and len(resumed.json()["children"]) == 1
            parent = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("e" * 32, "检查乙"))
            assert parent.status_code == 200
            stopped = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'e' * 32}/cancel")
            assert stopped.status_code == 200
            stopped_body = stopped.json()
            assert stopped_body["stage"] == "cancelled" and stopped_body["parent_status"] == "cancelled"
            assert stopped_body["children"][0]["status"] == "cancelled"
            rejected = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'e' * 32}/verdicts",
                                         json={"verdict_id": "late", "passed": False})
            assert rejected.status_code == 409 and rejected.json()["code"] == "workflow_settled"
            listed = await client.get(f"/api/v1/sessions/{SESSION}/workflows/{'e' * 32}")
            assert len(listed.json()["children"]) == 1
            third = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("f" * 32, "检查丙"))
            assert third.status_code == 200
            await host.sessions.archive_session(SESSION, True)
            archived = await client.get(f"/api/v1/sessions/{SESSION}/workflows/{'f' * 32}")
            assert archived.status_code == 200
            assert archived.json()["stage"] == "cancelled"
            assert archived.json()["parent_status"] == "cancelled"
            assert archived.json()["children"][0]["status"] == "cancelled"
            refused = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("1" * 32, "检查丁"))
            assert refused.status_code == 409 and refused.json()["code"] == "session_archived"
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_workflow_rejects_conflicts_and_a_second_open_correction(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="冲突"))
    try:
        async with _client(host) as client:
            await _attach(client)
            opened = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("9" * 32, "检查", 2))
            assert opened.status_code == 200
            changed = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("9" * 32, "另一检查", 2))
            assert changed.status_code == 409 and changed.json()["code"] == "workflow_conflict"
            kept = await client.get(f"/api/v1/sessions/{SESSION}/workflows/{'9' * 32}")
            assert kept.json()["check"] == "检查" and len(kept.json()["children"]) == 1
            passed = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'9' * 32}/verdicts",
                                       json={"verdict_id": "same", "passed": True})
            assert passed.status_code == 200 and passed.json()["stage"] == "passed"
            assert [item["role"] for item in passed.json()["children"]] == ["check"]
            flipped = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'9' * 32}/verdicts",
                                        json={"verdict_id": "same", "passed": False})
            assert flipped.status_code == 409 and flipped.json()["code"] == "verdict_conflict"
            later = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'9' * 32}/verdicts",
                                      json={"verdict_id": "other", "passed": False})
            assert later.status_code == 409 and later.json()["code"] == "workflow_settled"
            busy = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("8" * 32, "忙", 2))
            assert busy.status_code == 200
            first = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'8' * 32}/verdicts",
                                      json={"verdict_id": "one", "passed": False})
            assert first.status_code == 200 and first.json()["attempts"] == 1
            second = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'8' * 32}/verdicts",
                                       json={"verdict_id": "two", "passed": False})
            assert second.status_code == 409 and second.json()["code"] == "workflow_busy"
            still = await client.get(f"/api/v1/sessions/{SESSION}/workflows/{'8' * 32}")
            assert still.json()["attempts"] == 1 and len(still.json()["children"]) == 2
            bounded = await client.post(f"/api/v1/sessions/{SESSION}/workflows", json=_open_body("7" * 32, "零次", 0))
            assert bounded.status_code == 200
            none = await client.post(f"/api/v1/sessions/{SESSION}/workflows/{'7' * 32}/verdicts",
                                     json={"verdict_id": "zero", "passed": False})
            assert none.status_code == 200
            assert none.json()["stage"] == "exhausted" and none.json()["attempts"] == 0
            assert [item["role"] for item in none.json()["children"]] == ["check"]
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_workflow_check_does_not_store_the_provider_secret(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.lifecycle.profile.save_provider(host.lifecycle.profile.config.provider.model_copy(update={"api_key": SecretStr(KEY)}))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    created = await host.sessions.create_session(CreateSession(title="检查"))
    try:
        async with _client(host) as client:
            await _attach_session(client, created.session_id)
            rejected = await client.post(
                f"/api/v1/sessions/{created.session_id}/workflows", json=_open_body("a" * 32, f"检查 {KEY}"))
            assert rejected.status_code == 409 and rejected.json()["code"] == "workflow_secret"
            assert KEY not in rejected.text
            assert not session_database(tmp_path, created.session_id).parent.exists()
            opened = await client.post(
                f"/api/v1/sessions/{created.session_id}/workflows", json=_open_body("b" * 32, "只检查这一句"))
            assert opened.status_code == 200 and len(opened.json()["children"]) == 1
            conflict = await client.post(
                f"/api/v1/sessions/{created.session_id}/workflows", json=_open_body("b" * 32, f"另一句 {KEY}"))
            assert conflict.status_code == 409 and conflict.json()["code"] == "workflow_conflict"
            assert KEY not in conflict.text
            listed = await client.get(f"/api/v1/sessions/{created.session_id}/workflows/{'b' * 32}")
            assert listed.json()["check"] == "只检查这一句"
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_queued_workflow_check_is_not_sent_with_the_provider_secret(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path)
    host.lifecycle.profile.save_provider(host.lifecycle.profile.config.provider.model_copy(update={"api_key": SecretStr(KEY)}))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="检查"))
    captured: list[list[Message]] = []

    async def fake_stream(config: ProviderConfig, messages: list[Message], offers=None, plugins=None, *, auth: Auth):
        del config, offers
        captured.append(messages)
        yield Completion(message=Message(role="assistant", content="ok"), response_id="faux")

    async def empty_offers(self: Worker, request_id: str = "") -> list[object]:
        del self, request_id
        return []

    monkeypatch.setattr("amazme_backend.agent.driver.stream", fake_stream)
    monkeypatch.setattr(Worker, "_mcp_offers", empty_offers)
    monkeypatch.setattr(Worker, "_plugin_offers", empty_offers)
    session_database(tmp_path, SESSION).parent.mkdir(parents=True, mode=0o700)
    worker = create_worker(host.lifecycle.profile, SESSION, "worker-flow")
    await worker.store.initialize()
    worker.storage_ready = True
    fence = HostFence(host_epoch=0, build_id=session_state(worker.store).build)
    try:
        with pytest.raises(BackendError, match="resource_secret"):
            await worker.store.accept(Submit(request_id="typed", text=f"我说 {KEY}"), fence)
        assert not captured
        before = len(captured)
        opened = await worker.store.open_workflow("c" * 32, f"检查 {KEY}", 1)
        assert opened.check == f"检查 {KEY}"
        action = await _next_model(worker)
        with pytest.raises(BackendError) as raised:
            await worker.perform(action)
        assert raised.value.code == "workflow_secret" and KEY not in str(raised.value)
        await worker.store.advance(Failed(action, "workflow_secret"))
        parked = await _run_until_park(worker)
        assert parked.reason == "children"
        assert len(captured) == before
        view = await worker.store.workflow("c" * 32)
        assert view.check == f"检查 {KEY}"
        assert view.children[0].status == "unknown"
        receipt = await worker.store.get(view.children[0].request_id)
        assert receipt.error == "workflow_secret" and KEY not in receipt.error
    finally:
        await worker.store.close()
        await worker.supervisor.close()
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def _next_model(worker: Worker) -> ModelInvocation:
    for _ in range(20):
        action = await worker.store.advance()
        if isinstance(action, ModelInvocation):
            return action
        if isinstance(action, Park):
            pytest.fail(action.reason)
    pytest.fail("model call never started")


async def _run_until_park(worker: Worker) -> Park:
    for _ in range(20):
        action = await worker.store.advance()
        if isinstance(action, Continue):
            continue
        if isinstance(action, Park):
            return action
        if isinstance(action, ModelInvocation):
            await worker.store.advance(await worker.perform(action))
            continue
        pytest.fail(type(action).__name__)
    pytest.fail("session did not park")


def _request_count(profile: Path, session: str) -> int:
    connection = sqlite3.connect(session_database(profile, session))
    try:
        row = connection.execute("SELECT count(*) FROM requests").fetchone()
    finally:
        connection.close()
    assert row is not None
    return int(row[0])


async def _attach_session(client: httpx.AsyncClient, session: str) -> None:
    attached = await client.post(f"/api/v1/sessions/{session}/attachments")
    assert attached.status_code == 201
    client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]


async def test_removed_grant_does_not_open_a_workflow_or_correction(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    grant = tmp_path.parent / f"flow-{tmp_path.name}"
    grant.mkdir()
    (grant / "kept.txt").write_text("stay", encoding="utf-8")
    try:
        await host.workspaces.add_workspace(WorkspaceGrantRequest(name="docs", host_path=str(grant)))
        docs = await host.sessions.create_session(CreateSession(title="授予", workspace="docs"))
        untouched = await host.sessions.create_session(CreateSession(title="未打开", workspace="docs"))
        home = await host.sessions.create_session(CreateSession(title="主目录"))
        async with _client(host) as client:
            await _attach_session(client, docs.session_id)
            opened = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows", json=_open_body("a" * 32, "检查", 2))
            assert opened.status_code == 200 and len(opened.json()["children"]) == 1
            failed = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows/{'a' * 32}/verdicts",
                json={"verdict_id": "fail-1", "passed": False})
            assert failed.status_code == 200 and len(failed.json()["children"]) == 2
            store = SessionStore(session_database(tmp_path, docs.session_id), docs.session_id,
                                 build=host.lifecycle.build, approval_policy="auto", require_existing=True)
            await store.initialize()
            try:
                assert (await Driver(store).drain()).reason == "children"
            finally:
                await store.close()
            settle = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows", json=_open_body("b" * 32, "收尾", 1))
            assert settle.status_code == 200
            await host.workspaces.remove_workspace("docs")
            await _attach_session(client, untouched.session_id)
            refused = await client.post(
                f"/api/v1/sessions/{untouched.session_id}/workflows", json=_open_body("c" * 32, "不要"))
            assert refused.status_code == 404 and refused.json()["code"] == "workspace_not_found"
            assert not session_database(tmp_path, untouched.session_id).parent.exists()
            await _attach_session(client, docs.session_id)
            again = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows", json=_open_body("a" * 32, "检查", 2))
            assert again.status_code == 200 and len(again.json()["children"]) == 2
            conflict = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows", json=_open_body("a" * 32, "另一检查", 2))
            assert conflict.status_code == 409 and conflict.json()["code"] == "workflow_conflict"
            passed = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows/{'b' * 32}/verdicts",
                json={"verdict_id": "ok", "passed": True})
            assert passed.status_code == 200 and passed.json()["stage"] == "passed"
            assert [item["role"] for item in passed.json()["children"]] == ["check"]
            before = _request_count(tmp_path, docs.session_id)
            replay = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows/{'a' * 32}/verdicts",
                json={"verdict_id": "fail-1", "passed": False})
            assert replay.status_code == 200 and len(replay.json()["children"]) == 2
            blocked = await client.post(
                f"/api/v1/sessions/{docs.session_id}/workflows/{'a' * 32}/verdicts",
                json={"verdict_id": "fail-2", "passed": False})
            assert blocked.status_code == 404 and blocked.json()["code"] == "workspace_not_found"
            assert _request_count(tmp_path, docs.session_id) == before
            stopped = await client.post(f"/api/v1/sessions/{docs.session_id}/workflows/{'a' * 32}/cancel")
            assert stopped.status_code == 200 and stopped.json()["stage"] == "cancelled"
            await _attach_session(client, home.session_id)
            primary = await client.post(
                f"/api/v1/sessions/{home.session_id}/workflows", json=_open_body("d" * 32, "主目录"))
            assert primary.status_code == 200 and len(primary.json()["children"]) == 1
        assert (grant / "kept.txt").read_text(encoding="utf-8") == "stay"
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()
        shutil.rmtree(grant, ignore_errors=True)




async def test_workflow_children_keep_the_accepted_provider(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "session.sqlite", SESSION, build="test", approval_policy="auto")
    await store.initialize()
    chosen = ProviderConfig(provider="deepseek", model="deepseek-flash", max_tokens=1234)
    try:
        view = await store.open_workflow("a" * 32, "检查", 2, accepted_config=chosen)
        async def captured() -> list[ProviderConfig]:
            return await session_database_owner(store).call(lambda db: [load_run(db, request_id).config
                for request_id in [view.parent_id, *(child.request_id for child in view.children)]])
        assert await captured() == [chosen, chosen]
        # A correction opened after the profile default changes inherits the original run.
        view = await store.record_verdict(view.workflow_id, "fail", False)
        assert await captured() == [chosen, chosen, chosen]
        replay = await store.open_workflow(view.workflow_id, "检查", 2,
                                          accepted_config=ProviderConfig(provider="faux"))
        assert replay.workflow_id == view.workflow_id
        assert await captured() == [chosen, chosen, chosen]
    finally:
        await store.close()
