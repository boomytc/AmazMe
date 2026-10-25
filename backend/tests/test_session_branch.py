"""Session branches copy one settled turn and then diverge."""
import asyncio
import base64
import json
import shutil
import sqlite3
import subprocess
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from pydantic import SecretStr

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    BranchSession,
    Cleanup,
    CompactSession,
    ComputerPolicy,
    CreateSession,
    HostFence,
    Lease,
    Message,
    PrepareUpdate,
    ProcessLease,
    Receipt,
    RenameSession,
    Snapshot,
    Stream,
    Submit,
    ToolResult,
    WebPolicy,
    WorkspaceGrantRequest,
)
from amazme_backend.host import Host, application
from amazme_backend.host_store import HostStore
from amazme_backend.providers import Completion, stream
from amazme_backend.session_domain import (
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
from amazme_backend.storage import SessionStore, compaction_basis, session_database
from amazme_backend.worker import Worker

PARENT = "a" * 32
KEY = "sk-test-not-real"


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
            async for item in stream(action.config, action.messages):
                if isinstance(item, Completion):
                    await self.store.advance(ModelReturned(action, item))
        elif isinstance(action, OpenEpoch):
            self.epoch += 1
            await self.store.advance(EpochOpened(action.request_id, Lease(
                session_id=self.store.session_id, worker_id=self.store.instance, build_id=self.store.build,
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
    return await store.db.call(lambda db: [
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
    monkeypatch.setattr("amazme_backend.host.build_id", lambda: "a" * 64)
    value = Host(Profile(tmp_path))
    value.fence = fence_for(value.build)
    value.fence.host_epoch = await value.store.initialize(value.instance, value.build, lease)
    value.origin = "http://127.0.0.1:12345"
    await value.store.create_session(PARENT, CreateSession(title="原会话"))
    try:
        yield value
    finally:
        await value.supervisor.close()
        await value.store.db.close()


async def parent_store(owner: Host) -> SessionStore:
    path = session_database(owner.profile.path, PARENT)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    store = SessionStore(path, PARENT, build=owner.build, approval_policy="auto", instance="parent-worker")
    await store.initialize()
    await store.fence(fence_for(owner.build))
    return store


def test_session_database_rejects_escape(tmp_path: Path) -> None:
    with pytest.raises(BackendError, match="invalid_session"):
        session_database(tmp_path, "../escape")


async def test_branch_keeps_parent_history_and_drops_later_turns(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
        await finish(parent, "beta", "r2", owner.build)
        preserved = await message_payloads(parent)
        created = await owner.branch_session(PARENT, BranchSession(request_id="r1"))
        assert created.parent_id == PARENT and created.fork_request_id == "r1"
        assert created.title == "分支：原会话"
        child = SessionStore(session_database(owner.profile.path, created.session_id), created.session_id,
                             build=owner.build, approval_policy="auto", instance="child-worker",
                             require_existing=True)
        await child.initialize()
        await child.fence(fence_for(owner.build))
        try:
            assert [item.request_id for item in (await child.snapshot()).requests] == ["r1"]
            assert "beta" not in "".join(message.content for message in await child.messages("r1"))
            assert await child.db.call(lambda db: db.execute("SELECT count(*) FROM effects").fetchone()[0]) == 0
            assert await child.db.call(lambda db: db.execute("SELECT count(*) FROM approvals").fetchone()[0]) == 0
            await child.recover(initial_cleanup=Cleanup(
                session_id=created.session_id, execution_epoch=1, state="clean", resources=[], proof_id="proof"))
            assert (await Driver(child).drain()).reason == "idle"
            await child.accept(Submit(request_id="gamma", text="gamma"), fence_for(owner.build))
            action = await Driver(child).until(ModelInvocation)
            assert isinstance(action, ModelInvocation)
            context = "\n".join(message.content for message in action.messages)
            assert "alpha" in context and "gamma" in context and "beta" not in context
            with pytest.raises(BackendError, match="request_conflict"):
                await child.accept(Submit(request_id="r1", text="rewritten"), fence_for(owner.build))
            replayed = await child.accept(Submit(request_id="r1", text="alpha"), fence_for(owner.build))
            assert replayed.status == "succeeded"
            assert await message_payloads(parent) == preserved
            await parent.accept(Submit(request_id="delta", text="delta"), fence_for(owner.build))
            follow = await Driver(parent).until(ModelInvocation)
            assert isinstance(follow, ModelInvocation)
            parent_context = "\n".join(message.content for message in follow.messages)
            assert "beta" in parent_context and "gamma" not in parent_context
            assert any(item.request_id == "r2" and item.status == "succeeded"
                       for item in (await parent.snapshot()).requests)
        finally:
            await child.db.close()
    finally:
        await parent.db.close()


async def test_branch_keeps_session_switches_and_leaves_calls_behind(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
        await parent.save_web_policy(WebPolicy(enabled=True, base_url="https://user:secret@tools.example/v1"))
        before = [item.session_id for item in (await owner.sessions()).sessions]
        with pytest.raises(BackendError, match="web_address"):
            await owner.branch_session(PARENT, BranchSession(request_id="r1"))
        assert [item.session_id for item in (await owner.sessions()).sessions] == before
        web = WebPolicy(
            enabled=True, base_url="https://tools.example/v1", count=3,
            send_original_question=False, timeout_ms=5000)
        computer = ComputerPolicy(enabled=True, max_age_ms=1000)
        await parent.save_web_policy(web)
        await parent.save_computer_policy(computer)
        await parent.begin_web_call("paid", "search", "query")
        await parent.note_computer_exit(7)
        created = await owner.branch_session(PARENT, BranchSession(request_id="r1"))
        child = SessionStore(session_database(owner.profile.path, created.session_id), created.session_id,
                             build=owner.build, approval_policy="auto", instance="child-worker",
                             require_existing=True)
        await child.initialize()
        try:
            assert await child.web_policy() == web
            assert await child.computer_policy() == computer
            assert await child.db.call(lambda db: db.execute("SELECT count(*) FROM web_calls").fetchone()[0]) == 0
            assert await child.computer_runtime() == (False, None, "")
            await child.save_web_policy(WebPolicy())
            assert await parent.web_policy() == web
            assert (await parent.computer_runtime())[:2] == (True, 7)
        finally:
            await child.db.close()
    finally:
        await parent.db.close()


async def test_unsettled_branch_does_not_create_a_session(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await parent.accept(Submit(request_id="open", text="still running"), fence_for(owner.build))
        before = [item.session_id for item in (await owner.sessions()).sessions]
        with pytest.raises(BackendError, match="branch_point_unsettled"):
            await owner.branch_session(PARENT, BranchSession(request_id="open"))
        with pytest.raises(BackendError, match="branch_point_missing"):
            await owner.branch_session(PARENT, BranchSession(request_id="missing"))
        assert [item.session_id for item in (await owner.sessions()).sessions] == before
        assert (await parent.get("open")).status == "queued"
    finally:
        await parent.db.close()


async def test_frozen_update_rejects_a_branch(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
        await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build="b" * 64), owner.build)
        with pytest.raises(BackendError, match="update_frozen"):
            await owner.branch_session(PARENT, BranchSession(request_id="r1"))
        assert [item.session_id for item in (await owner.sessions()).sessions] == [PARENT]
        assert (await parent.get("r1")).status == "succeeded"
    finally:
        await parent.db.close()


async def test_failed_branch_keeps_the_parent_project_and_refuses_a_missing_workspace(
        owner: Host, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    parent = await parent_store(owner)
    grant = tmp_path.parent / f"branch-{tmp_path.name}"
    grant.mkdir()
    docs = None
    try:
        await finish(parent, "alpha", "r1", owner.build)
        await owner.add_workspace(WorkspaceGrantRequest(name="docs", host_path=str(grant)))
        created = await owner.create_session(CreateSession(title="授予", workspace="docs"))
        path = session_database(owner.profile.path, created.session_id)
        path.parent.mkdir(parents=True, mode=0o700)
        docs = SessionStore(path, created.session_id, build=owner.build, approval_policy="auto", instance="docs-worker")
        await docs.initialize()
        await docs.fence(fence_for(owner.build))
        await finish(docs, "docs", "r1", owner.build)
        await owner.remove_workspace("docs")
        with pytest.raises(BackendError, match="workspace_not_found"):
            await owner.branch_session(created.session_id, BranchSession(request_id="r1"))
        assert {item.session_id for item in (await owner.sessions()).sessions} == {PARENT, created.session_id}

        project = "b" * 32
        await owner.store.save_project(project, "项目", ["primary"])
        await owner.store.transaction(lambda db: db.execute(
            "INSERT INTO project_sessions(session,project) VALUES(?,?)", (PARENT, project)))

        async def fail(self: SessionStore, parent_path: Path, request_id: str) -> None:
            raise BackendError("storage_failure")

        monkeypatch.setattr(SessionStore, "import_settled_root", fail)
        with pytest.raises(BackendError, match="storage_failure"):
            await owner.branch_session(PARENT, BranchSession(request_id="r1"))
        assert {item.session_id for item in (await owner.sessions()).sessions} == {PARENT, created.session_id}
        links = await owner.store.db.call(lambda db: [
            str(row[0]) for row in db.execute("SELECT session FROM project_sessions")])
        assert links == [PARENT]
        assert {item.name for item in (owner.profile.path / "sessions").iterdir()} == {PARENT, created.session_id}
        assert "alpha" in "".join(await message_payloads(parent))
    finally:
        if docs is not None:
            await docs.db.close()
        await parent.db.close()
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
        await finish(parent, "alpha", "r1", owner.build)
    finally:
        await parent.db.close()
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only", "x-amazme-build": owner.build,
                                           "x-amazme-epoch": str(owner.fence.host_epoch)}) as client:
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
        await finish(parent, "alpha", "r1", owner.build)
        await parent.accept(Submit(request_id="queued", text="not started"), fence_for(owner.build))
        preserved = await message_payloads(parent)
        await parent.db.close()
        archived = await owner.archive_session(PARENT, True)
        parent = await parent_store(owner)
        assert archived.archived is True
        assert await message_payloads(parent) == preserved
        assert (await parent.get("r1")).status == "succeeded" and (await parent.get("r1")).text == "alpha"
        assert (await parent.get("queued")).status == "cancelled"
        await parent.db.close()
        assert (await owner.archive_session(PARENT, True)).archived is True
        with pytest.raises(BackendError, match="session_archived"):
            await owner.store.enqueue(PARENT, "submit", "fresh", Submit(request_id="fresh", text="later"))
        with pytest.raises(BackendError, match="session_archived"):
            await owner.branch_session(PARENT, BranchSession(request_id="r1"))
        await owner.store.demand(PARENT)
        assert PARENT not in await owner.store.due()
        assert (await owner.archive_session(PARENT, False)).archived is False
        parent = await parent_store(owner)
        await parent.accept(Submit(request_id="later", text="later"), fence_for(owner.build))
        action = await Driver(parent).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        context = "\n".join(message.content for message in action.messages)
        assert "alpha" in context and "later" in context
    finally:
        await parent.db.close()


async def test_archive_route_rejects_work_and_keeps_the_turn(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
    finally:
        await parent.db.close()
    pending = await owner.store.enqueue(PARENT, "submit", "queued", Submit(request_id="queued", text="wait"))
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only", "x-amazme-build": owner.build,
                                           "x-amazme-epoch": str(owner.fence.host_epoch)}) as client:
        attached = await client.post(f"/api/v1/sessions/{PARENT}/attachments")
        client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
        response = await client.post(f"/api/v1/sessions/{PARENT}/archive", json={"archived": True})
        assert response.status_code == 200 and response.json()["archived"] is True
        listed = await client.get("/api/v1/sessions")
        assert any(item["session_id"] == PARENT and item["archived"] is True for item in listed.json()["sessions"])
    assert pending.delivery_id not in {item.delivery_id for item in await owner.store.pending(PARENT)}
    reopened = SessionStore(session_database(owner.profile.path, PARENT), PARENT, build=owner.build,
                            require_existing=True)
    await reopened.initialize()
    try:
        assert (await reopened.get("r1")).answer
    finally:
        await reopened.db.close()


async def test_compaction_replaces_context_and_keeps_original_messages(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
        original = await message_payloads(parent)
        await parent.db.close()
        created = await owner.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
        parent = await parent_store(owner)
        assert created.summary and await message_payloads(parent) == original
        assert (await parent.snapshot()).compaction == created.summary
        await parent.db.close()
        again = await owner.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
        parent = await parent_store(owner)
        assert again == created
        stale = compaction_basis(["not-the-history"])
        with pytest.raises(BackendError, match="compaction_expired"):
            await parent.commit_compaction("c2", "r1", "过期摘要", stale)
        assert await message_payloads(parent) == original
        await parent.accept(Submit(request_id="later", text="later"), fence_for(owner.build))
        action = await Driver(parent).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        assert action.messages[0].content == created.summary
        assert any(message.content == "later" for message in action.messages)
        assert not any(message.role == "assistant" for message in action.messages)
        assert any(message.role == "assistant" for message in await parent.messages("r1"))
    finally:
        await parent.db.close()


async def test_failed_summary_does_not_replace_history(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
        original = await message_payloads(parent)
    finally:
        await parent.db.close()

    async def fail(_config: object, _messages: object) -> str:
        raise BackendError("model_failed")

    monkeypatch.setattr("amazme_backend.host.summarize", fail)
    with pytest.raises(BackendError, match="model_failed"):
        await owner.compact_session(PARENT, CompactSession(compaction_id="c-fail", through_request_id="r1"))
    parent = await parent_store(owner)
    try:
        assert await message_payloads(parent) == original
        assert (await parent.snapshot()).compaction == ""
        await parent.accept(Submit(request_id="later", text="later"), fence_for(owner.build))
        action = await Driver(parent).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        assert any(message.role == "assistant" and "alpha" in message.content for message in action.messages)
    finally:
        await parent.db.close()


async def test_compaction_is_not_sent_twice(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    failed = False

    async def fake(_config: object, messages: list[Message]) -> str:
        nonlocal failed
        text = "\n".join(message.content for message in messages)
        if "失败" in text and not failed:
            failed = True
            raise BackendError("model_failed")
        calls.append(text)
        return "已压缩一次"

    monkeypatch.setattr("amazme_backend.host.summarize", fake)
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
    finally:
        await parent.db.close()
    created = await owner.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
    again = await owner.compact_session(PARENT, CompactSession(compaction_id="c1", through_request_id="r1"))
    other = await owner.compact_session(PARENT, CompactSession(compaction_id="c2", through_request_id="r1"))
    assert created == again == other and len(calls) == 1 and "alpha" in calls[0]
    parent = await parent_store(owner)
    try:
        await finish(parent, "失败", "r-fail", owner.build)
    finally:
        await parent.db.close()
    with pytest.raises(BackendError, match="model_failed"):
        await owner.compact_session(PARENT, CompactSession(compaction_id="c-fail", through_request_id="r-fail"))
    retried = await owner.compact_session(PARENT, CompactSession(compaction_id="c-fail", through_request_id="r-fail"))
    assert retried.summary == "已压缩一次" and len(calls) == 2
    parent = await parent_store(owner)
    try:
        await finish(parent, "停住", "r-held", owner.build)
        await parent.begin_compaction("c-held", "r-held")
    finally:
        await parent.db.close()
    with pytest.raises(BackendError, match="compaction_pending"):
        await owner.compact_session(PARENT, CompactSession(compaction_id="c-held", through_request_id="r-held"))
    with pytest.raises(BackendError, match="compaction_conflict"):
        await owner.compact_session(PARENT, CompactSession(compaction_id="c-new", through_request_id="r-held"))
    assert len(calls) == 2


async def test_compaction_does_not_send_or_keep_the_provider_secret(
        owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    owner.profile.save_provider(owner.profile.config.provider.model_copy(update={"api_key": SecretStr(KEY)}))
    calls: list[str] = []

    async def fake_summarize(_config: object, messages: list[Message]) -> str:
        text = "\n".join(message.content for message in messages)
        calls.append(text)
        if "回声" in text:
            return f"回声摘要 {KEY}"
        return "已压缩干净对话"

    monkeypatch.setattr("amazme_backend.host.summarize", fake_summarize)
    parent = await parent_store(owner)
    try:
        await finish(parent, "干净", "r-clean", owner.build)
    finally:
        await parent.db.close()
    created = await owner.compact_session(PARENT, CompactSession(compaction_id="c-clean", through_request_id="r-clean"))
    assert created.summary == "已压缩干净对话" and KEY not in calls[0]
    parent = await parent_store(owner)
    try:
        assert (await parent.snapshot()).compaction == "已压缩干净对话"
        await finish(parent, "回声", "r-echo", owner.build)
        echo_payloads = await message_payloads(parent)
    finally:
        await parent.db.close()
    before_echo = len(calls)
    with pytest.raises(BackendError, match="compaction_secret") as echoed:
        await owner.compact_session(PARENT, CompactSession(compaction_id="c-echo", through_request_id="r-echo"))
    assert KEY not in str(echoed.value) and len(calls) == before_echo + 1
    with pytest.raises(BackendError, match="compaction_pending"):
        await owner.compact_session(PARENT, CompactSession(compaction_id="c-echo", through_request_id="r-echo"))
    assert len(calls) == before_echo + 1
    parent = await parent_store(owner)
    try:
        assert await message_payloads(parent) == echo_payloads
        await finish(parent, "普通", "r-plain", owner.build)
        stored = f"旧摘要 {KEY}"
        await parent.commit_compaction(
            "c-stored", "r-plain", stored, compaction_basis(await parent.message_payloads("r-plain")))
        assert (await parent.snapshot()).compaction == stored
    finally:
        await parent.db.close()
    worker = Worker(owner.profile, PARENT, "worker-compact")
    await worker.store.initialize()
    worker.storage_ready = True
    try:
        prepared = await worker.model_input([
            Message(role="user", content=stored),
            Message(role="user", content=f"我说 {KEY}"),
        ])
    finally:
        await worker.store.db.close()
    assert [item.content for item in prepared] == [f"我说 {KEY}"]
    parent = await parent_store(owner)
    try:
        await finish(parent, f"对话 {KEY}", "r-secret", owner.build)
        secret_payloads = await message_payloads(parent)
    finally:
        await parent.db.close()
    sent = len(calls)
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": owner.build,
        "x-amazme-epoch": str(owner.fence.host_epoch),
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
        saved = await parent.db.call(lambda db: [str(row[0]) for row in db.execute("SELECT payload FROM compactions")])
    finally:
        await parent.db.close()
    assert any(stored in item for item in saved) and not any(f"回声摘要 {KEY}" in item for item in saved)


async def test_archived_session_cannot_compact(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
        original = await message_payloads(parent)
        await parent.db.close()
        await owner.archive_session(PARENT, True)
        parent = await parent_store(owner)
        with pytest.raises(BackendError, match="session_archived"):
            await owner.compact_session(PARENT, CompactSession(compaction_id="c-arch", through_request_id="r1"))
        assert await message_payloads(parent) == original
    finally:
        await parent.db.close()


def browser_module() -> str:
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    contract = "const root = " + json.dumps(Stream.model_json_schema()) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    return "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()


def test_browser_branches_from_the_selected_turn() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    parent_snapshot = Snapshot(session_id="a", stream_id="stream-a", seq="2", state="ready", events=[], requests=[
        Receipt(request_id="r1", text="alpha", status="succeeded", answer="已收到：alpha", kind="root"),
        Receipt(request_id="r2", text="beta", status="succeeded", answer="已收到：beta", kind="root"),
    ])
    child_snapshot = parent_snapshot.model_copy(update={
        "session_id": "child", "stream_id": "stream-child", "requests": [], "events": []})
    script = "const appURL=" + json.dumps(browser_module()) + ";\n"
    script += "const html=" + json.dumps((web / "index.html").read_text()) + ";\n"
    script += "const parentSnapshot=" + parent_snapshot.model_dump_json() + ";\n"
    script += "const childSnapshot=" + child_snapshot.model_dump_json() + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=a&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1',protocol:'amazme-http/1'};
        const calls = [];
        let branched = false, count = 0;
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        globalThis.fetch = async (path, options={})=>{
          calls.push({path, body:options.body, build:options.headers?.['x-amazme-build']});
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path.startsWith('/api/v1/session-models/')) return response({session_id:path.split('/').at(-1),provider:'faux',model:'faux'});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/sessions') return response({sessions:branched
            ? [{session_id:'a',title:'A',parent_id:'',fork_request_id:''},{session_id:'child',title:'分支：A',parent_id:'a',fork_request_id:'r1'}]
            : [{session_id:'a',title:'A',parent_id:'',fork_request_id:''}]});
          const parts=path.split('/');
          if(parts[5]==='attachments') return response({attachment_id:'binding-'+(++count),session_id:parts[4],build_id:'build',host_epoch:1},201);
          if(parts[5]==='snapshot') return response(parts[4]==='child' ? childSnapshot : parentSnapshot);
          if(parts[5]==='branches') {
            assert.equal(JSON.parse(options.body).request_id,'r1');
            assert.equal(options.headers['x-amazme-build'],'build');
            branched = true;
            return response({session_id:'child',title:'分支：A',parent_id:'a',fork_request_id:'r1'},201);
          }
          throw Error('unexpected request '+path);
        };
        let hellos = 0;
        globalThis.WebSocket = class {
          constructor() { queueMicrotask(()=>this.onopen?.()); }
          send(raw) {
            const frame=JSON.parse(raw);
            if(frame.kind!=='hello') return;
            hellos += 1;
            const snapshot = hellos === 1 ? parentSnapshot : childSnapshot;
            queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot,batches:[],stream_id:snapshot.stream_id,binding_id:frame.binding_id,build_id:'build',resync:'initial'})}));
          }
          close() {}
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('condition timed out: '+$('error').textContent+' '+$('connection').textContent);
        }
        await import(appURL);
        await until(()=>$('connection').textContent==='已连接' && document.querySelector('#conversation article button')?.textContent==='从此处分支');
        assert.equal(document.querySelectorAll('#conversation article button').length, 4);
        document.querySelector('#conversation article button').click();
        await until(()=>$('conversation').textContent.includes('alpha')===false && [...$('sessions').children].some(node=>node.textContent==='分支：A'));
        assert.equal(calls.some(call=>String(call.path).endsWith('/branches')), true);
        window.dispatchEvent(new window.Event('pagehide'));
        await window.happyDOM.abort();
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]


def test_browser_archive_keeps_the_visible_turn() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    snapshot = Snapshot(session_id="a", stream_id="stream-a", seq="1", state="ready", events=[], requests=[
        Receipt(request_id="r1", text="alpha", status="succeeded", answer="已收到：alpha", kind="root")])
    script = "const appURL=" + json.dumps(browser_module()) + ";\n"
    script += "const html=" + json.dumps((web / "index.html").read_text()) + ";\n"
    script += "const snap=" + snapshot.model_dump_json() + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=a&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        let archived = false;
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        globalThis.fetch = async (path, options={})=>{
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path.startsWith('/api/v1/session-models/')) return response({session_id:path.split('/').at(-1),provider:'faux',model:'faux'});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:'a',title:'A',parent_id:'',fork_request_id:'',archived}]});
          const parts=path.split('/');
          if(parts[5]==='attachments' && (options.method||'GET')==='DELETE') return response({detached:true});
          if(parts[5]==='attachments') return response({attachment_id:'binding',session_id:parts[4],build_id:'build',host_epoch:1},201);
          if(parts[5]==='snapshot') return response(snap);
          if(parts[5]==='archive') {
            assert.equal(JSON.parse(options.body).archived, true);
            archived = true;
            return response({session_id:'a',title:'A',parent_id:'',fork_request_id:'',archived:true});
          }
          throw Error('unexpected '+path);
        };
        globalThis.WebSocket = class {
          constructor() { queueMicrotask(()=>this.onopen?.()); }
          send(raw) {
            const frame=JSON.parse(raw);
            if(frame.kind!=='hello') return;
            queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot:snap,batches:[],stream_id:snap.stream_id,binding_id:frame.binding_id,build_id:'build',resync:'initial'})}));
          }
          close() {}
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent+' '+$('connection').textContent);
        }
        await import(appURL);
        await until(()=>$('connection').textContent==='已连接' && $('conversation').textContent.includes('alpha'));
        assert.equal($('archive').textContent, '归档');
        $('archive').click();
        await until(()=>$('archive').textContent==='恢复' && $('send').disabled && $('conversation').textContent.includes('已收到：alpha'));
        assert.equal([...$('sessions').children].some(node=>node.textContent==='A（已归档）'), true);
        window.dispatchEvent(new window.Event('pagehide'));
        await window.happyDOM.abort();
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]


def test_browser_compaction_keeps_the_original_turn() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    snapshot = Snapshot(session_id="a", stream_id="stream-a", seq="1", state="ready", events=[], requests=[
        Receipt(request_id="r1", text="alpha", status="succeeded", answer="已收到：alpha", kind="root")])
    script = "const appURL=" + json.dumps(browser_module()) + ";\n"
    script += "const html=" + json.dumps((web / "index.html").read_text()) + ";\n"
    script += "const snap=" + snapshot.model_dump_json() + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=a&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const compactionIds=[];
        globalThis.fetch = async (path, options={})=>{
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path.startsWith('/api/v1/session-models/')) return response({session_id:path.split('/').at(-1),provider:'faux',model:'faux'});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:'a',title:'A',archived:false}]});
          const parts=path.split('/');
          if(parts[5]==='attachments' && (options.method||'GET')==='DELETE') return response({detached:true});
          if(parts[5]==='attachments') return response({attachment_id:'binding',session_id:parts[4],build_id:'build',host_epoch:1},201);
          if(parts[5]==='snapshot') return response(snap);
          if(parts[5]==='compactions') {
            const body=JSON.parse(options.body);
            assert.equal(body.through_request_id,'r1');
            compactionIds.push(body.compaction_id);
            if(compactionIds.filter(item=>item===body.compaction_id).length===1) {
              return response({code:'compaction_pending',message:'compaction_pending'},409);
            }
            return response({compaction_id:body.compaction_id,through_request_id:'r1',basis:'abc',message_count:2,summary:'已压缩 alpha'},201);
          }
          throw Error('unexpected '+path);
        };
        globalThis.WebSocket = class {
          constructor() { queueMicrotask(()=>this.onopen?.()); }
          send(raw) {
            const frame=JSON.parse(raw);
            if(frame.kind!=='hello') return;
            queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot:snap,batches:[],stream_id:snap.stream_id,binding_id:frame.binding_id,build_id:'build',resync:'initial'})}));
          }
          close() {}
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent+' '+$('connection').textContent);
        }
        await import(appURL);
        await until(()=>$('conversation').textContent.includes('alpha') && [...document.querySelectorAll('button')].some(node=>node.textContent==='压缩上下文'));
        const compact=[...document.querySelectorAll('button')].find(node=>node.textContent==='压缩上下文');
        compact.click();
        await until(()=>$('error').textContent.includes('未自动重发'));
        compact.click();
        await until(()=>$('compaction').textContent.includes('已压缩 alpha') && $('conversation').textContent.includes('已收到：alpha'));
        assert.equal(compactionIds.length, 2);
        assert.equal(compactionIds[0], compactionIds[1]);
        window.dispatchEvent(new window.Event('pagehide'));
        await window.happyDOM.abort();
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]


async def test_search_reads_only_this_sessions_durable_text(owner: Host) -> None:
    parent = await parent_store(owner)
    other_id = "b" * 32
    await owner.store.create_session(other_id, CreateSession(title="另一会话"))
    other_path = session_database(owner.profile.path, other_id)
    other_path.parent.mkdir(parents=True, mode=0o700)
    other = SessionStore(other_path, other_id, build=owner.build, approval_policy="auto", instance="other-worker")
    await other.initialize()
    await other.fence(fence_for(owner.build))
    try:
        await finish(parent, "alpha token", "r1", owner.build)
        await parent.accept(Submit(request_id="r2", text="Straße"), fence_for(owner.build))
        await other.accept(Submit(request_id="g1", text="gamma only"), fence_for(owner.build))
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
        await parent.db.close()
        await owner.archive_session(PARENT, True)
        parent = await parent_store(owner)
        assert any("alpha token" in hit.excerpt for hit in await parent.search("alpha"))
        listed = await owner.search_session(PARENT, "alpha")
        assert any("alpha token" in hit.excerpt for hit in listed.hits)
        assert (await owner.search_session(other_id, "alpha")).hits == []
    finally:
        await parent.db.close()
        await other.db.close()


def test_browser_searches_the_selected_session() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    schema = Stream.model_json_schema()
    contract = "const root = " + json.dumps(schema) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    session = "d" * 32
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=''' + session + r'''&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path.startsWith('/api/v1/session-models/')) return response({session_id:path.split('/').at(-1),provider:'faux',model:'faux'});
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.includes('/search')) {
            const query = new URL(path, 'http://127.0.0.1').searchParams.get('q');
            seen.push(path.split('?')[0] + ' ' + query);
            if(query==='alpha') return response({query, hits:[{request_id:'r1', ordinal:0, role:'user', excerpt:'alpha token'}]});
            return response({query, hits:[]});
          }
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        await until(()=>$('sessions').textContent.includes('工作区'));
        $('history-query').value = 'alpha';
        $('history-form').requestSubmit();
        await until(()=>$('history-results').textContent==='alpha token');
        $('history-query').value = 'nope';
        $('history-form').requestSubmit();
        await until(()=>$('history-results').textContent==='没有匹配');
        assert.deepEqual(seen, [''' + json.dumps(f"/api/v1/sessions/{session}/search alpha") + r''', ''' + json.dumps(f"/api/v1/sessions/{session}/search nope") + r''']);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]


async def test_branch_copies_model_without_sharing_later_changes(owner: Host) -> None:
    from amazme_backend.contracts import SessionModel
    await owner.store.save_session_model(SessionModel(session_id=PARENT, provider="deepseek", model="deepseek-flash"))
    child = "b" * 32
    await owner.store.create_branch(child, PARENT, "settled", "分支")
    copied = await owner.store.session_model(child)
    assert copied is not None and copied.model == "deepseek-flash"
    await owner.store.save_session_model(SessionModel(session_id=PARENT, provider="faux", model="faux"))
    assert await owner.store.session_model(child) == copied
    await owner.store.discard_unopened_branch(child)
    assert await owner.store.session_model(child) is None


async def test_branch_retry_keeps_its_id_after_parent_and_child_changes(owner: Host) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
    finally:
        await parent.db.close()
    request = BranchSession(branch_id="c" * 32, request_id="r1")
    first = await owner.branch_session(PARENT, request)
    await owner.rename_session(first.session_id, RenameSession(title="手动分支名称", expected_title=first.title))
    child = SessionStore(session_database(owner.profile.path, first.session_id), first.session_id,
                         build=owner.build, approval_policy="auto")
    await child.initialize()
    await child.fence(fence_for(owner.build))
    try:
        await finish(child, "branch-only", "r2", owner.build)
        before = await message_payloads(child)
        await child.save_web_policy(WebPolicy(enabled=True))
    finally:
        await child.db.close()
    await owner.archive_session(PARENT, True)
    retried = await owner.branch_session(PARENT, request)
    assert retried.session_id == first.session_id and retried.title == "手动分支名称" and retried.prepared
    check = SessionStore(session_database(owner.profile.path, first.session_id), first.session_id,
                         build=owner.build, read_only=True, require_existing=True)
    await check.initialize()
    try:
        assert await message_payloads(check) == before
        assert (await check.web_policy()).enabled is True
    finally:
        await check.db.close()
    assert len((await owner.sessions()).sessions) == 2
    with pytest.raises(BackendError, match="branch_conflict"):
        await owner.branch_session(PARENT, request.model_copy(update={"title": "changed payload"}))


async def test_interrupted_branch_is_not_attachable_and_explicit_retry_finishes_the_same_copy(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = await parent_store(owner)
    try:
        await finish(parent, "alpha", "r1", owner.build)
    finally:
        await parent.db.close()
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
        await owner.branch_session(PARENT, request)
    partial = await owner.store.session(request.branch_id)
    assert partial is not None and not partial.prepared
    with pytest.raises(BackendError, match="branch_preparation_pending"):
        await owner.attach_session(request.branch_id)
    with pytest.raises(BackendError, match="branch_preparation_pending"):
        await owner.store.enqueue(request.branch_id, "submit", "early", Submit(request_id="early", text="must wait"))
    recovered = await owner.branch_session(PARENT, request)
    assert recovered.prepared and recovered.session_id == request.branch_id
    assert len((await owner.sessions()).sessions) == 2
    attached = await owner.attach_session(request.branch_id)
    assert attached.session_id == request.branch_id
    owner.release_attachment(request.branch_id, attached.attachment_id)
