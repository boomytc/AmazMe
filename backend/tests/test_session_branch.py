"""Session branches copy one settled turn and then diverge."""
import asyncio
import json
import shutil
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from pydantic import BaseModel, SecretStr
from session_test_support import session_database_owner, session_state

from amazme_backend.accounts.oauth.flow import OAuthCredential
from amazme_backend.agent.model import stream
from amazme_backend.ai.types import Auth
from amazme_backend.bootstrap.worker import create_worker
from amazme_backend.contracts import (
    AnswerFeedbackWrite,
    BackendError,
    BranchSession,
    Cleanup,
    CompactSession,
    CreateSession,
    HostFence,
    Lease,
    Message,
    PrepareUpdate,
    ProcessLease,
    ProviderConfig,
    RenameSession,
    ServiceInfo,
    SessionModel,
    Submit,
    SupervisorHealth,
    ToolResult,
    WebPolicy,
    WorkspaceGrantRequest,
)
from amazme_backend.contracts.accounts import ConfigureProvider, ProviderCheckRequest
from amazme_backend.contracts.ipc.supervisor import TerminalSession
from amazme_backend.contracts.ipc.worker import SessionOp, SessionOpResult
from amazme_backend.host.service import Host
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.host.store import HostStore
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.ipc import Peer
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sdk import Client
from amazme_backend.sessions.client import SessionRelay
from amazme_backend.sessions.service import SessionStore, compaction_basis, run_session_op
from amazme_backend.sessions.types import (
    Action,
    CloseEpoch,
    Continue,
    EpochClosed,
    EpochOpened,
    ModelInvocation,
    ModelReturned,
    OpenEpoch,
    Park,
    ToolInvocation,
    ToolReturned,
)

PARENT = "a" * 32
KEY = "sk-test-not-real"


class SessionOpPeer(Peer):
    """Run typed worker operations with one test writer and no business driver."""

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


def fence_for(build: str) -> HostFence:
    return HostFence(host_epoch=1, build_id=build)


async def message_payloads(store: SessionStore) -> list[str]:
    return await session_database_owner(store).call(lambda db: [
        str(row[0]) for row in db.execute("SELECT payload FROM messages ORDER BY rowid")])


async def finish(store: SessionStore, text: str, request_id: str, build: str) -> None:
    await store.accept(Submit(request_id=request_id, text=text), fence_for(build))
    assert (await Driver(store).drain()).reason == "idle"


@pytest.fixture
def lease(tmp_path: Path) -> ProcessLease:
    return ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                        path=str(tmp_path / "lease"), device=1, inode=1)


@pytest_asyncio.fixture
async def owner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, lease: ProcessLease) -> AsyncIterator[Host]:
    private_write(tmp_path / "config.json", json.dumps({
        "profile_id": "test", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    monkeypatch.setattr("amazme_backend.host.lifecycle.build_id", lambda: "a" * 64)
    value = Host(Profile(tmp_path))
    value.lifecycle.fence = fence_for(value.lifecycle.build)
    value.lifecycle.fence.host_epoch = await value.lifecycle.store.initialize(value.lifecycle.instance, value.lifecycle.build, lease)
    value.origin = "http://127.0.0.1:12345"
    await value.lifecycle.store.create_session(PARENT, CreateSession(title="原会话"))
    supervisor_id = "test-supervisor"
    await value.lifecycle.store.save_service(ServiceInfo(
        instance_id=supervisor_id, build_id=value.lifecycle.build, state="running",
        process_lease=lease.model_copy(update={"instance_id": supervisor_id, "role": "supervisor"})))

    async def ensure_supervisor(*, for_shutdown: bool = False) -> None:
        assert not for_shutdown

    async def supervisor_call[T: BaseModel](
        method: str, path: str, response: type[T], body: BaseModel | None = None,
    ) -> T:
        if method == "GET" and path == "/health" and response is SupervisorHealth:
            health = SupervisorHealth(
                identity=value.lifecycle.profile.identity(
                    supervisor_id, value.lifecycle.build, role="supervisor",
                    host_epoch=value.lifecycle.fence.host_epoch),
                registry_revision="1", workers=[], epochs=[])
            return response.model_validate_json(health.model_dump_json())
        assert method == "POST" and path == "/sessions/retire" and response is Cleanup
        assert isinstance(body, TerminalSession)
        proof = Cleanup(session_id=body.session_id, execution_epoch=0,
                        state="clean", resources=[], proof_id="test-retired")
        return response.model_validate_json(proof.model_dump_json())

    monkeypatch.setattr(value.lifecycle, "ensure_supervisor", ensure_supervisor)
    monkeypatch.setattr(value.lifecycle.supervisor, "call", supervisor_call)
    try:
        yield value
    finally:
        await value.lifecycle.supervisor.close()
        await value.lifecycle.store.db.close()


async def parent_store(owner: Host) -> SessionStore:
    path = session_database(owner.lifecycle.profile.path, PARENT)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    store = SessionStore(path, PARENT, build=owner.lifecycle.build, approval_policy="auto", instance="parent-worker")
    await store.initialize()
    await store.fence(fence_for(owner.lifecycle.build))
    return store


def test_session_database_rejects_escape(tmp_path: Path) -> None:
    with pytest.raises(BackendError, match="invalid_session"):
        session_database(tmp_path, "../escape")


async def test_branch_keeps_parent_history_and_drops_later_turns(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        await finish(parent, "beta", "r2", owner.lifecycle.build)
        preserved = await message_payloads(parent)
        created = await owner.sessions.branch_session(PARENT, BranchSession(request_id="r1"))
        assert created.parent_id == PARENT and created.fork_request_id == "r1"
        assert created.title == "分支：原会话"
        child = SessionStore(session_database(owner.lifecycle.profile.path, created.session_id), created.session_id,
                             build=owner.lifecycle.build, approval_policy="auto", instance="child-worker",
                             require_existing=True)
        await child.initialize()
        await child.fence(fence_for(owner.lifecycle.build))
        try:
            assert [item.request_id for item in (await child.snapshot()).requests] == ["r1"]
            copied = (await child.snapshot()).requests[0]
            assert int(copied.revision) <= int((await child.snapshot()).seq)
            replay = await child.events(0)
            assert all(event.receipt is None or event.receipt.revision == batch.revision
                       for batch in replay.batches for event in batch.events)
            assert "beta" not in "".join(message.content for message in await child.messages("r1"))
            assert await session_database_owner(child).call(lambda db: db.execute("SELECT count(*) FROM effects").fetchone()[0]) == 0
            assert await session_database_owner(child).call(lambda db: db.execute("SELECT count(*) FROM approvals").fetchone()[0]) == 0
            await child.recover(initial_cleanup=Cleanup(
                session_id=created.session_id, execution_epoch=1, state="clean", resources=[], proof_id="proof"))
            assert (await Driver(child).drain()).reason == "idle"
            await child.accept(Submit(request_id="gamma", text="gamma"), fence_for(owner.lifecycle.build))
            action = await Driver(child).until(ModelInvocation)
            assert isinstance(action, ModelInvocation)
            context = "\n".join(message.content for message in action.messages)
            assert "alpha" in context and "gamma" in context and "beta" not in context
            with pytest.raises(BackendError, match="request_conflict"):
                await child.accept(Submit(request_id="r1", text="rewritten"), fence_for(owner.lifecycle.build))
            replayed = await child.accept(Submit(request_id="r1", text="alpha"), fence_for(owner.lifecycle.build))
            assert replayed.status == "succeeded"
            assert await message_payloads(parent) == preserved
            await parent.accept(Submit(request_id="delta", text="delta"), fence_for(owner.lifecycle.build))
            follow = await Driver(parent).until(ModelInvocation)
            assert isinstance(follow, ModelInvocation)
            parent_context = "\n".join(message.content for message in follow.messages)
            assert "beta" in parent_context and "gamma" not in parent_context
            assert any(item.request_id == "r2" and item.status == "succeeded"
                       for item in (await parent.snapshot()).requests)
        finally:
            await child.close()
    finally:
        await parent.close()


async def test_branch_keeps_session_switches_and_leaves_calls_behind(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        await parent.save_web_policy(WebPolicy(enabled=True, base_url="https://user:secret@tools.example/v1"))
        before = [item.session_id for item in (await owner.sessions.sessions()).sessions]
        with pytest.raises(BackendError, match="web_address"):
            await owner.sessions.branch_session(PARENT, BranchSession(request_id="r1"))
        assert [item.session_id for item in (await owner.sessions.sessions()).sessions] == before
        web = WebPolicy(
            enabled=True, base_url="https://tools.example/v1", count=3,
            send_original_question=False, timeout_ms=5000)
        await parent.save_web_policy(web)
        await parent.begin_web_call("paid", "search", "query")
        created = await owner.sessions.branch_session(PARENT, BranchSession(request_id="r1"))
        child = SessionStore(session_database(owner.lifecycle.profile.path, created.session_id), created.session_id,
                             build=owner.lifecycle.build, approval_policy="auto", instance="child-worker",
                             require_existing=True)
        await child.initialize()
        try:
            assert await child.web_policy() == web
            assert await session_database_owner(child).call(lambda db: db.execute("SELECT count(*) FROM web_calls").fetchone()[0]) == 0
            await child.save_web_policy(WebPolicy())
            assert await parent.web_policy() == web
        finally:
            await child.close()
    finally:
        await parent.close()


async def test_unsettled_branch_does_not_create_a_session(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await parent.accept(Submit(request_id="open", text="still running"), fence_for(owner.lifecycle.build))
        before = [item.session_id for item in (await owner.sessions.sessions()).sessions]
        with pytest.raises(BackendError, match="branch_point_unsettled"):
            await owner.sessions.branch_session(PARENT, BranchSession(request_id="open"))
        with pytest.raises(BackendError, match="branch_point_missing"):
            await owner.sessions.branch_session(PARENT, BranchSession(request_id="missing"))
        assert [item.session_id for item in (await owner.sessions.sessions()).sessions] == before
        assert (await parent.get("open")).status == "queued"
    finally:
        await parent.close()


async def test_frozen_update_rejects_a_branch(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build="b" * 64), owner.lifecycle.build)
        with pytest.raises(BackendError, match="update_frozen"):
            await owner.sessions.branch_session(PARENT, BranchSession(request_id="r1"))
        assert [item.session_id for item in (await owner.sessions.sessions()).sessions] == [PARENT]
        assert (await parent.get("r1")).status == "succeeded"
    finally:
        await parent.close()


async def test_failed_branch_keeps_the_parent_project_and_refuses_a_missing_workspace(
        owner: Host, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    parent = await parent_store(owner)
    grant = tmp_path.parent / f"branch-{tmp_path.name}"
    grant.mkdir()
    docs = None
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        await owner.workspaces.add_workspace(WorkspaceGrantRequest(name="docs", host_path=str(grant)))
        created = await owner.sessions.create_session(CreateSession(title="授予", workspace="docs"))
        path = session_database(owner.lifecycle.profile.path, created.session_id)
        path.parent.mkdir(parents=True, mode=0o700)
        docs = SessionStore(path, created.session_id, build=owner.lifecycle.build, approval_policy="auto", instance="docs-worker")
        await docs.initialize()
        await docs.fence(fence_for(owner.lifecycle.build))
        await finish(docs, "docs", "r1", owner.lifecycle.build)
        await owner.workspaces.remove_workspace("docs")
        with pytest.raises(BackendError, match="workspace_not_found"):
            await owner.sessions.branch_session(created.session_id, BranchSession(request_id="r1"))
        assert {item.session_id for item in (await owner.sessions.sessions()).sessions} == {PARENT, created.session_id}

        project = "b" * 32
        await owner.lifecycle.store.save_project(project, "项目", ["primary"])
        await owner.lifecycle.store.transaction(lambda db: db.execute(
            "INSERT INTO project_sessions(session,project) VALUES(?,?)", (PARENT, project)))

        async def fail(self: SessionStore, parent_path: Path, request_id: str) -> None:
            raise BackendError("storage_failure")

        monkeypatch.setattr(SessionStore, "import_settled_root", fail)
        with pytest.raises(BackendError, match="storage_failure"):
            await owner.sessions.branch_session(PARENT, BranchSession(request_id="r1"))
        assert {item.session_id for item in (await owner.sessions.sessions()).sessions} == {PARENT, created.session_id}
        links = await owner.lifecycle.store.db.call(lambda db: [
            str(row[0]) for row in db.execute("SELECT session FROM project_sessions")])
        assert links == [PARENT]
        assert {item.name for item in (owner.lifecycle.profile.path / "sessions").iterdir()} == {PARENT, created.session_id}
        assert "alpha" in "".join(await message_payloads(parent))
    finally:
        if docs is not None:
            await docs.close()
        await parent.close()
        shutil.rmtree(grant, ignore_errors=True)


async def test_branch_columns_keep_existing_session_rows(tmp_path: Path, lease: ProcessLease) -> None:
    path = tmp_path / "host.sqlite"
    store = HostStore(path)
    await store.initialize("host", "a" * 64, lease)
    await store.create_session(PARENT, CreateSession(title="保留"))
    await store.db.close()
    raw = sqlite3.connect(path)
    raw.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    raw.execute("ALTER TABLE sessions RENAME TO sessions_old")
    raw.execute("""CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,
        wanted INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL DEFAULT 0)""")
    raw.execute("INSERT INTO sessions(id,title,wanted,next_check) SELECT id,title,wanted,next_check FROM sessions_old")
    raw.execute("DROP TABLE sessions_old")
    raw.commit()
    raw.close()
    for suffix in ("-wal", "-shm"):
        extra = path.with_name(path.name + suffix)
        if extra.exists():
            extra.unlink()
    reopened = HostStore(path, require_existing=True)
    try:
        await reopened.initialize("host-2", "a" * 64, lease)
        listed = await reopened.sessions()
        assert [(item.session_id, item.title, item.parent_id, item.fork_request_id, item.archived)
                for item in listed.sessions] == [(PARENT, "保留", "", "", False)]
    finally:
        await reopened.db.close()


async def test_branch_route_returns_the_child_session(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
    finally:
        await parent.close()
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only", "x-amazme-build": owner.lifecycle.build,
                                           "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)}) as client:
        attached = await client.post(f"/api/v1/sessions/{PARENT}/attachments")
        assert attached.status_code == 201
        client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
        response = await client.post(f"/api/v1/sessions/{PARENT}/branches", json={"request_id": "r1"})
        assert response.status_code == 201
        body = response.json()
        assert body["parent_id"] == PARENT and body["fork_request_id"] == "r1"
        assert body["session_id"] != PARENT
        listed = await client.get("/api/v1/sessions")
        assert any(item["session_id"] == body["session_id"] and item["fork_request_id"] == "r1"
                   for item in listed.json()["sessions"])


async def test_archive_keeps_history_and_refuses_new_work(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        await parent.accept(Submit(request_id="queued", text="not started"), fence_for(owner.lifecycle.build))
        preserved = await message_payloads(parent)
        await parent.close()
        archived = await owner.sessions.archive_session(PARENT, True)
        parent = await parent_store(owner)
        assert archived.archived is True
        assert await message_payloads(parent) == preserved
        assert (await parent.get("r1")).status == "succeeded" and (await parent.get("r1")).text == "alpha"
        assert (await parent.get("queued")).status == "cancelled"
        await parent.close()
        assert (await owner.sessions.archive_session(PARENT, True)).archived is True
        with pytest.raises(BackendError, match="session_archived"):
            await owner.lifecycle.store.enqueue(PARENT, "submit", "fresh", Submit(request_id="fresh", text="later"))
        with pytest.raises(BackendError, match="session_archived"):
            await owner.sessions.branch_session(PARENT, BranchSession(request_id="r1"))
        await owner.lifecycle.store.demand(PARENT)
        assert PARENT not in await owner.lifecycle.store.due()
        assert (await owner.sessions.archive_session(PARENT, False)).archived is False
        parent = await parent_store(owner)
        await parent.accept(Submit(request_id="later", text="later"), fence_for(owner.lifecycle.build))
        action = await Driver(parent).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        context = "\n".join(message.content for message in action.messages)
        assert "alpha" in context and "later" in context
    finally:
        await parent.close()


async def test_archive_route_rejects_work_and_keeps_the_turn(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
    finally:
        await parent.close()
    pending = await owner.lifecycle.store.enqueue(PARENT, "submit", "queued", Submit(request_id="queued", text="wait"))
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only", "x-amazme-build": owner.lifecycle.build,
                                           "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)}) as client:
        attached = await client.post(f"/api/v1/sessions/{PARENT}/attachments")
        client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
        response = await client.post(f"/api/v1/sessions/{PARENT}/archive", json={"archived": True})
        assert response.status_code == 200 and response.json()["archived"] is True
        listed = await client.get("/api/v1/sessions")
        assert any(item["session_id"] == PARENT and item["archived"] is True for item in listed.json()["sessions"])
    assert pending.delivery_id not in {item.delivery_id for item in await owner.lifecycle.store.pending(PARENT)}
    reopened = SessionStore(session_database(owner.lifecycle.profile.path, PARENT), PARENT, build=owner.lifecycle.build,
                            require_existing=True)
    await reopened.initialize()
    try:
        assert (await reopened.get("r1")).answer
    finally:
        await reopened.close()


async def test_compaction_replaces_context_and_keeps_original_messages(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        original = await message_payloads(parent)
        await parent.close()
        created = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
        parent = await parent_store(owner)
        assert created.summary and await message_payloads(parent) == original
        assert (await parent.snapshot()).compaction == created.summary
        await parent.close()
        again = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
        parent = await parent_store(owner)
        assert again == created
        stale = compaction_basis(["not-the-history"])
        with pytest.raises(BackendError, match="compaction_expired"):
            await parent.commit_compaction("c2", "r1", "过期摘要", stale)
        assert await message_payloads(parent) == original
        await parent.accept(Submit(request_id="later", text="later"), fence_for(owner.lifecycle.build))
        action = await Driver(parent).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        assert action.messages[0].content == created.summary
        assert any(message.content == "later" for message in action.messages)
        assert not any(message.role == "assistant" for message in action.messages)
        assert any(message.role == "assistant" for message in await parent.messages("r1"))
    finally:
        await parent.close()


async def test_failed_summary_does_not_replace_history(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        original = await message_payloads(parent)
    finally:
        await parent.close()

    async def fail(_config: object, _messages: object, _instructions: str, *, auth: Auth) -> str:
        raise BackendError("model_failed")

    monkeypatch.setattr("amazme_backend.host.sessions.summarize", fail)
    with pytest.raises(BackendError, match="model_failed"):
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-fail", through_request_id="r1"))
    parent = await parent_store(owner)
    try:
        assert await message_payloads(parent) == original
        assert (await parent.snapshot()).compaction == ""
        await parent.accept(Submit(request_id="later", text="later"), fence_for(owner.lifecycle.build))
        action = await Driver(parent).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        assert any(message.role == "assistant" and "alpha" in message.content for message in action.messages)
    finally:
        await parent.close()


async def test_compaction_is_not_sent_twice(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    failed = False

    async def fake(_config: object, messages: list[Message], _instructions: str, *, auth: Auth) -> str:
        nonlocal failed
        text = "\n".join(message.content for message in messages)
        if "失败" in text and not failed:
            failed = True
            raise BackendError("model_failed")
        calls.append(text)
        return "已压缩一次"

    monkeypatch.setattr("amazme_backend.host.sessions.summarize", fake)
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
    finally:
        await parent.close()
    created = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
    again = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
    other = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c2", through_request_id="r1"))
    assert created == again and other == created.model_copy(update={"compaction_id": "c2"})
    assert len(calls) == 1 and "alpha" in calls[0]
    parent = await parent_store(owner)
    try:
        await finish(parent, "失败", "r-fail", owner.lifecycle.build)
    finally:
        await parent.close()
    with pytest.raises(BackendError, match="model_failed"):
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-fail", through_request_id="r-fail"))
    retried = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-fail", through_request_id="r-fail"))
    assert retried.summary == "已压缩一次" and len(calls) == 2
    parent = await parent_store(owner)
    try:
        await finish(parent, "停住", "r-held", owner.lifecycle.build)
        await parent.begin_compaction("c-held", "r-held")
    finally:
        await parent.close()
    with pytest.raises(BackendError, match="compaction_pending"):
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-held", through_request_id="r-held"))
    with pytest.raises(BackendError, match="compaction_conflict"):
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-new", through_request_id="r-held"))
    assert len(calls) == 2


@pytest.mark.parametrize("operation", ["check", "compact"])
async def test_copilot_request_identity_on_checks_and_compaction(
    owner: Host, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    provider, model = "github-copilot", "custom-copilot"
    await owner.accounts.configure_provider(ConfigureProvider(
        operation_id="d" * 32, expected_revision=0, provider=provider, api="anthropic-messages",
        base_url="https://copilot.example/v1", model_ids=[model]))
    await owner.accounts.accounts.set(provider, OAuthCredential(
        access=SecretStr("copilot-access"), refresh=SecretStr("github-refresh"), expires=2**60), 0)
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        events = [
            {"type": "message_start", "message": {"id": "summary", "usage": {"input_tokens": 1}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "summary"}},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, content="".join("data: " + json.dumps(event) + "\n\n" for event in events),
                              headers={"content-type": "text/event-stream"})

    real_http = httpx.AsyncClient

    def local_http(**kwargs):
        return real_http(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr("amazme_backend.ai.client.httpx.AsyncClient", local_http)
    if operation == "check":
        checked = await owner.accounts.check_provider(ProviderCheckRequest(
            operation_id="c" * 32, provider=provider, model_ids=[model]))
        assert checked.phase == "done" and checked.failed == []
    else:
        parent = await parent_store(owner)
        try:
            await finish(parent, "alpha", "r1", owner.lifecycle.build)
        finally:
            await parent.close()
        await owner.accounts.save_session_model(SessionModel(session_id=PARENT, provider=provider, model=model))
        compacted = await owner.sessions.compact_session(
            PARENT, CompactSession(compaction_id="copilot", through_request_id="r1"))
        assert compacted.summary == "summary"
    assert len(sent) == 1
    expected = {
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
        "X-Initiator": "user",
        "Openai-Intent": "conversation-edits",
        "Authorization": "Bearer copilot-access",
    }
    assert {name: sent[0].headers.get(name) for name in expected} == expected


async def test_compaction_pins_instructions_to_the_id_and_uses_the_session_model(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    async def fake(config: ProviderConfig, _messages: list[Message], instructions: str, *, auth: Auth) -> str:
        calls.append((config.model, instructions))
        return "摘要：" + instructions

    monkeypatch.setattr("amazme_backend.host.sessions.summarize", fake)
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
    finally:
        await parent.close()
    owner.lifecycle.profile.save_provider(owner.lifecycle.profile.config.provider.model_copy(update={"model": "default"}))
    await owner.lifecycle.store.save_session_model(SessionModel(session_id=PARENT, provider="faux", model="faux"))
    original = CompactSession(compaction_id="focus", through_request_id="r1", instructions="保留文件和未完成事项")
    created = await owner.sessions.compact_session(PARENT, original)
    assert created.instructions == original.instructions and calls == [("faux", original.instructions)]
    assert await owner.sessions.compact_session(PARENT, original) == created
    with pytest.raises(BackendError, match="compaction_conflict"):
        await owner.sessions.compact_session(PARENT, original.model_copy(update={"instructions": "替换要求"}))
    second = await owner.sessions.compact_session(PARENT, original.model_copy(update={"compaction_id": "focus2", "instructions": "仅保留决定"}))
    assert second.instructions == "仅保留决定" and len(calls) == 2
    await owner.sessions.compact_session(PARENT, original)
    parent = await parent_store(owner)
    try:
        assert await parent.active_summary() == second.summary
    finally:
        await parent.close()
    reused = await owner.sessions.compact_session(PARENT, original.model_copy(update={"compaction_id": "focus3"}))
    assert reused.compaction_id == "focus3" and reused.summary == created.summary and len(calls) == 2
    sdk = Client(owner.origin, "web-only")
    await sdk._http.aclose()
    sdk._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(owner)), base_url=owner.origin)
    async with sdk:
        attachment = await sdk.attach(PARENT)
        assert await sdk.compact(PARENT, "primary", attachment.attachment_id, original) == created
        rpc = await sdk.rpc("session.compact", session_id=PARENT, workspace="primary", attachment_id=attachment.attachment_id,
                            compaction=original.model_dump())
        assert rpc["instructions"] == original.instructions and rpc["compaction_id"] == original.compaction_id
        with pytest.raises(BackendError, match="workspace_mismatch"):
            await sdk.compact(PARENT, "other", attachment.attachment_id, original)
    assert len(calls) == 2
    parent = await parent_store(owner)
    try:
        await parent.begin_compaction("held-focus", "r1", "未收到的要求")
        with pytest.raises(BackendError, match="compaction_conflict"):
            await parent.begin_compaction("held-focus", "r1", original.instructions)
        with pytest.raises(BackendError, match="compaction_pending"):
            await parent.begin_compaction("held-focus", "r1", "未收到的要求")
        with pytest.raises(BackendError, match="compaction_conflict"):
            await parent.commit_compaction("held-focus", "r1", "错误摘要", created.basis, "改变要求")
    finally:
        await parent.close()


async def test_answer_feedback_retries_retracts_and_restores_without_overwriting_newer_votes(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "answer me", "r-vote", owner.lifecycle.build)
    finally:
        await parent.close()
    original = AnswerFeedbackWrite(operation_id="1" * 32, request_id="r-vote", rating="up", expected_revision=0)
    first = await owner.content.save_answer_feedback(PARENT, original)
    second = await owner.content.save_answer_feedback(PARENT, original.model_copy(update={"operation_id": "2" * 32, "rating": "down", "expected_revision": 1}))
    assert first.revision == 1 and second.revision == 2
    assert await owner.content.save_answer_feedback(PARENT, original) == first
    assert (await owner.content.answer_feedback(PARENT)).records == [second]
    with pytest.raises(BackendError, match="feedback_conflict"):
        await owner.content.save_answer_feedback(PARENT, original.model_copy(update={"rating": "down"}))
    with pytest.raises(BackendError, match="feedback_revision_conflict"):
        await owner.content.save_answer_feedback(PARENT, original.model_copy(update={"operation_id": "3" * 32}))
    sdk = Client(owner.origin, "web-only")
    await sdk._http.aclose()
    sdk._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(owner)), base_url=owner.origin)
    clear = original.model_copy(update={"operation_id": "4" * 32, "rating": None, "expected_revision": 2})
    async with sdk:
        attachment = await sdk.attach(PARENT)
        cleared = await sdk.save_answer_feedback(PARENT, "primary", attachment.attachment_id, clear)
        assert cleared.rating is None and cleared.revision == 3
        assert (await sdk.answer_feedback(PARENT)).records == [cleared]
        rpc = await sdk.rpc("feedback.rate", session_id=PARENT, workspace="primary", attachment_id=attachment.attachment_id, feedback=clear.model_dump())
        assert rpc["revision"] == 3 and rpc["rating"] is None
        with pytest.raises(BackendError, match="workspace_mismatch"):
            await sdk.save_answer_feedback(PARENT, "other", attachment.attachment_id, clear)
    exported = await owner.content.export_bundle()
    assert exported.answer_feedback == [cleared]
    destination = owner.lifecycle.profile.path / "imported-votes"
    destination.mkdir()
    private_write(destination / "config.json", json.dumps({"profile_id": "imported", "workspace": str(destination), "resources": "unused", "provider": {"provider": "faux"}}))
    private_write(destination / "control.token", "imported-control")
    private_write(destination / "web.token", "imported-web")
    target = Host(Profile(destination))
    target.lifecycle.fence = fence_for(target.lifecycle.build)
    lease = ProcessLease(instance_id="import-host", role="host", profile_path=str(destination), path=str(destination / "lease"), device=1, inode=1)
    target.lifecycle.fence.host_epoch = await target.lifecycle.store.initialize(target.lifecycle.instance, target.lifecycle.build, lease)
    try:
        await target.content.import_bundle(exported)
        assert (await target.content.answer_feedback(PARENT)).records == [cleared]
        assert await target.content.save_answer_feedback(PARENT, clear) == cleared
        updated = await target.content.save_answer_feedback(PARENT, original.model_copy(update={"operation_id": "5" * 32, "expected_revision": 3}))
        assert updated.revision == 4
        with pytest.raises(BackendError, match="import_conflict"):
            await target.content.import_bundle(exported)
        assert (await target.content.answer_feedback(PARENT)).records == [updated]
    finally:
        await target.lifecycle.supervisor.close()
        await target.lifecycle.store.db.close()


async def test_compaction_does_not_send_or_keep_the_provider_secret(
        owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    owner.lifecycle.profile.save_provider(owner.lifecycle.profile.config.provider.model_copy(update={"api_key": SecretStr(KEY)}))
    calls: list[str] = []

    async def fake_summarize(_config: object, messages: list[Message], _instructions: str, *, auth: Auth) -> str:
        text = "\n".join(message.content for message in messages)
        calls.append(text)
        if "回声" in text:
            return f"回声摘要 {KEY}"
        return "已压缩干净对话"

    monkeypatch.setattr("amazme_backend.host.sessions.summarize", fake_summarize)
    parent = await parent_store(owner)
    try:
        await finish(parent, "干净", "r-clean", owner.lifecycle.build)
    finally:
        await parent.close()
    created = await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-clean", through_request_id="r-clean"))
    assert created.summary == "已压缩干净对话" and KEY not in calls[0]
    with pytest.raises(BackendError, match="compaction_secret"):
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-instructions", through_request_id="r-clean", instructions=KEY))
    assert len(calls) == 1
    parent = await parent_store(owner)
    try:
        assert (await parent.snapshot()).compaction == "已压缩干净对话"
        await finish(parent, "回声", "r-echo", owner.lifecycle.build)
        echo_payloads = await message_payloads(parent)
    finally:
        await parent.close()
    before_echo = len(calls)
    with pytest.raises(BackendError, match="compaction_secret") as echoed:
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-echo", through_request_id="r-echo"))
    assert KEY not in str(echoed.value) and len(calls) == before_echo + 1
    with pytest.raises(BackendError, match="compaction_pending"):
        await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-echo", through_request_id="r-echo"))
    assert len(calls) == before_echo + 1
    parent = await parent_store(owner)
    try:
        assert await message_payloads(parent) == echo_payloads
        await finish(parent, "普通", "r-plain", owner.lifecycle.build)
        stored = f"旧摘要 {KEY}"
        await parent.commit_compaction(
            "c-stored", "r-plain", stored, compaction_basis(await parent.message_payloads("r-plain")))
        assert (await parent.snapshot()).compaction == stored
    finally:
        await parent.close()
    worker = create_worker(owner.lifecycle.profile, PARENT, "worker-compact")
    await worker.store.initialize()
    worker.storage_ready = True
    try:
        prepared = await worker.model_input([
            Message(role="user", content=stored),
            Message(role="user", content=f"我说 {KEY}"),
        ])
    finally:
        await worker.store.close()
        await worker.supervisor.close()
    assert [item.content for item in prepared] == [f"我说 {KEY}"]
    parent = await parent_store(owner)
    try:
        await finish(parent, f"对话 {KEY}", "r-secret", owner.lifecycle.build)
        secret_payloads = await message_payloads(parent)
    finally:
        await parent.close()
    sent = len(calls)
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": owner.lifecycle.build,
        "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch),
    }) as client:
        attached = await client.post(f"/api/v1/sessions/{PARENT}/attachments")
        assert attached.status_code == 201
        client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
        rejected = await client.post(
            f"/api/v1/sessions/{PARENT}/compactions",
            json={"compaction_id": "c-secret", "through_request_id": "r-secret"})
    assert rejected.status_code == 409 and rejected.json()["code"] == "compaction_secret"
    assert KEY not in rejected.text and len(calls) == sent
    parent = await parent_store(owner)
    try:
        assert await message_payloads(parent) == secret_payloads
        saved = await session_database_owner(parent).call(lambda db: [str(row[0]) for row in db.execute("SELECT payload FROM compactions")])
    finally:
        await parent.close()
    assert any(stored in item for item in saved) and not any(f"回声摘要 {KEY}" in item for item in saved)


async def test_archived_session_cannot_compact(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
        original = await message_payloads(parent)
        await parent.close()
        await owner.sessions.archive_session(PARENT, True)
        parent = await parent_store(owner)
        with pytest.raises(BackendError, match="session_archived"):
            await owner.sessions.compact_session(PARENT, CompactSession(compaction_id="c-arch", through_request_id="r1"))
        assert await message_payloads(parent) == original
    finally:
        await parent.close()










async def test_search_reads_only_this_sessions_durable_text(owner: Host) -> None:
    parent = await parent_store(owner)
    other_id = "b" * 32
    await owner.lifecycle.store.create_session(other_id, CreateSession(title="另一会话"))
    other_path = session_database(owner.lifecycle.profile.path, other_id)
    other_path.parent.mkdir(parents=True, mode=0o700)
    other = SessionStore(other_path, other_id, build=owner.lifecycle.build, approval_policy="auto", instance="other-worker")
    await other.initialize()
    await other.fence(fence_for(owner.lifecycle.build))
    try:
        await finish(parent, "alpha token", "r1", owner.lifecycle.build)
        await parent.accept(Submit(request_id="r2", text="Straße"), fence_for(owner.lifecycle.build))
        await other.accept(Submit(request_id="g1", text="gamma only"), fence_for(owner.lifecycle.build))
        found = await parent.search("ALPHA")
        assert found and all(hit.request_id == "r1" for hit in found)
        assert any("alpha token" in hit.excerpt for hit in found)
        folded = await parent.search("strasse")
        assert any(hit.request_id == "r2" and "Straße" in hit.excerpt for hit in folded)
        assert await parent.search("%") == []
        assert await other.search("alpha") == []
        assert any("gamma only" in hit.excerpt for hit in await other.search("gamma"))
        with pytest.raises(BackendError, match="search_query"):
            await parent.search("   ")
        await parent.close()
        await owner.sessions.archive_session(PARENT, True)
        parent = await parent_store(owner)
        assert any("alpha token" in hit.excerpt for hit in await parent.search("alpha"))
        listed = await owner.sessions.search_session(PARENT, "alpha")
        assert any("alpha token" in hit.excerpt for hit in listed.hits)
        assert (await owner.sessions.search_session(other_id, "alpha")).hits == []
    finally:
        await parent.close()
        await other.close()




async def test_branch_copies_model_without_sharing_later_changes(owner: Host) -> None:
    from amazme_backend.contracts import SessionModel
    await owner.lifecycle.store.save_session_model(SessionModel(session_id=PARENT, provider="deepseek", model="deepseek-flash"))
    child = "b" * 32
    await owner.lifecycle.store.create_branch(child, PARENT, "settled", "分支")
    copied = await owner.lifecycle.store.session_model(child)
    assert copied is not None and copied.model == "deepseek-flash"
    await owner.lifecycle.store.save_session_model(SessionModel(session_id=PARENT, provider="faux", model="faux"))
    assert await owner.lifecycle.store.session_model(child) == copied
    await owner.lifecycle.store.discard_unopened_branch(child)
    assert await owner.lifecycle.store.session_model(child) is None


async def test_branch_retry_keeps_its_id_after_parent_and_child_changes(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
    finally:
        await parent.close()
    request = BranchSession(branch_id="c" * 32, request_id="r1")
    first = await owner.sessions.branch_session(PARENT, request)
    await owner.sessions.rename_session(first.session_id, RenameSession(title="手动分支名称", expected_title=first.title))
    child = SessionStore(session_database(owner.lifecycle.profile.path, first.session_id), first.session_id,
                         build=owner.lifecycle.build, approval_policy="auto")
    await child.initialize()
    await child.fence(fence_for(owner.lifecycle.build))
    try:
        await finish(child, "branch-only", "r2", owner.lifecycle.build)
        before = await message_payloads(child)
        await child.save_web_policy(WebPolicy(enabled=True))
    finally:
        await child.close()
    await owner.sessions.archive_session(PARENT, True)
    retried = await owner.sessions.branch_session(PARENT, request)
    assert retried.session_id == first.session_id and retried.title == "手动分支名称" and retried.prepared
    check = SessionStore(session_database(owner.lifecycle.profile.path, first.session_id), first.session_id,
                         build=owner.lifecycle.build, read_only=True, require_existing=True)
    await check.initialize()
    try:
        assert await message_payloads(check) == before
        assert (await check.web_policy()).enabled is True
    finally:
        await check.close()
    assert len((await owner.sessions.sessions()).sessions) == 2
    with pytest.raises(BackendError, match="branch_conflict"):
        await owner.sessions.branch_session(PARENT, request.model_copy(update={"title": "changed payload"}))


async def test_interrupted_branch_is_not_attachable_and_explicit_retry_finishes_the_same_copy(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.lifecycle.build)
    finally:
        await parent.close()
    request = BranchSession(branch_id="e" * 32, request_id="r1")
    original = SessionStore.save_web_policy
    interrupted = False

    async def save(self: SessionStore, policy: WebPolicy) -> WebPolicy:
        nonlocal interrupted
        if self.session_id == request.branch_id and not interrupted:
            interrupted = True
            raise asyncio.CancelledError()
        return await original(self, policy)

    monkeypatch.setattr(SessionStore, "save_web_policy", save)
    with pytest.raises(asyncio.CancelledError):
        await owner.sessions.branch_session(PARENT, request)
    partial = await owner.lifecycle.store.session(request.branch_id)
    assert partial is not None and not partial.prepared
    with pytest.raises(BackendError, match="branch_preparation_pending"):
        await owner.sessions.attach_session(request.branch_id)
    with pytest.raises(BackendError, match="branch_preparation_pending"):
        await owner.lifecycle.store.enqueue(request.branch_id, "submit", "early", Submit(request_id="early", text="must wait"))
    recovered = await owner.sessions.branch_session(PARENT, request)
    assert recovered.prepared and recovered.session_id == request.branch_id
    assert len((await owner.sessions.sessions()).sessions) == 2
    attached = await owner.sessions.attach_session(request.branch_id)
    assert attached.session_id == request.branch_id
    owner.sessions.release_attachment(request.branch_id, attached.attachment_id)
