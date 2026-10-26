import asyncio
import json
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio
from pydantic import BaseModel
from session_test_support import session_database_owner, session_state

from amazme_backend.agent.driver import Worker
from amazme_backend.agent.model import stream
from amazme_backend.ai.types import Auth
from amazme_backend.bootstrap.worker import create_worker
from amazme_backend.contracts import (
    ApprovalDecision,
    BackendError,
    Cancel,
    Cleanup,
    EffectHold,
    EffectResolution,
    FreezeWorker,
    HostFence,
    Identity,
    Lease,
    Message,
    Preview,
    ProfileConfig,
    ProviderConfig,
    StopWorker,
    Submission,
    Submit,
    ToolCall,
    ToolObservation,
    ToolResult,
    WorkerRequest,
)
from amazme_backend.execution.client import SupervisorClient
from amazme_backend.profiles.profile import Profile
from amazme_backend.sessions.persistence.clock import now_ms
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import (
    Action,
    CloseEpoch,
    Completion,
    Continue,
    EffectResolved,
    EpochClosed,
    EpochOpened,
    Failed,
    ModelInvocation,
    ModelReturned,
    OpenEpoch,
    Park,
    Previewed,
    QueryTool,
    ReconcileEffect,
    ToolInvocation,
    ToolObserved,
    ToolReturned,
)

FENCE = HostFence(host_epoch=1, build_id="test-build")
SESSION = "a" * 32


class Driver:
    def __init__(self, store: SessionStore):
        self.store = store
        self.epoch = 0
        self.tools: list[ToolInvocation] = []
        self.models: list[ModelInvocation] = []

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
            self.tools.append(action)
            await self.store.advance(ToolReturned(action, ToolResult(
                call_id=action.step_id, exit_code=0, stdout="ok", stderr="")))
        elif isinstance(action, CloseEpoch):
            await self.store.advance(EpochClosed(action.request_id, action.lease, Cleanup(
                session_id=self.store.session_id, execution_epoch=action.lease.execution_epoch,
                state="clean", resources=[], proof_id="proof")))
        else:
            pytest.fail(f"unexpected action {action}")

    async def until(self, expected: type[Action]) -> Action:
        for _ in range(100):
            action = await self.next()
            if isinstance(action, expected):
                return action
            await self.respond(action)
        pytest.fail("expected action never reached")

    async def drain(self) -> Park:
        action = await self.until(Park)
        assert isinstance(action, Park)
        return action


@pytest_asyncio.fixture
async def store(tmp_path: Path) -> AsyncIterator[SessionStore]:
    value = SessionStore(tmp_path / "session.sqlite", SESSION, approval_policy="auto", instance="worker")
    await value.initialize()
    await value.fence(FENCE)
    try:
        yield value
    finally:
        await value.close()


async def submit(store: SessionStore, text: str = "/shell echo ok", request_id: str = "root") -> None:
    await store.accept(Submit(request_id=request_id, text=text), FENCE)


async def test_approval_releases_epoch_and_consumes_once(store: SessionStore) -> None:
    session_state(store).approval_policy = "mutations"
    await submit(store)
    driver = Driver(store)
    assert (await driver.drain()).reason == "approval" and driver.epoch == 0
    approval = (await store.snapshot()).approvals[-1]
    decision = ApprovalDecision(decision_id="yes", approval_id=approval.approval_id,
        expected_revision=approval.revision, proposal_digest=approval.proposal_digest, approve=True)
    await store.approve(decision, FENCE)
    await store.approve(decision, FENCE)
    await driver.drain()
    assert (await store.get("root")).status == "succeeded"
    assert len(driver.tools) == driver.epoch == 1
    assert (await store.snapshot()).approvals[-1].state == "consumed"


async def test_steer_expires_approval_and_denial_never_executes(store: SessionStore) -> None:
    session_state(store).approval_policy = "all"
    await submit(store)
    driver = Driver(store)
    await driver.drain()
    approval = (await store.snapshot()).approvals[-1]
    await store.accept(Submit(request_id="steer", text="changed", mode="steer", target_run_id="root"), FENCE)
    with pytest.raises(BackendError, match="stale_approval"):
        await store.approve(ApprovalDecision(decision_id="stale", approval_id=approval.approval_id,
            expected_revision=approval.revision, proposal_digest=approval.proposal_digest, approve=True), FENCE)
    await driver.drain()
    fresh = (await store.snapshot()).approvals[-1]
    assert fresh.approval_id != approval.approval_id and fresh.proposal_digest != approval.proposal_digest
    await store.approve(ApprovalDecision(decision_id="new", approval_id=fresh.approval_id,
        expected_revision=fresh.revision, proposal_digest=fresh.proposal_digest, approve=False), FENCE)
    await driver.drain()
    assert not driver.tools and (await store.get("root")).error == "approval_denied"
    assert (await store.get("steer")).status == "interrupted"


async def test_steer_arriving_during_final_model_is_applied(store: SessionStore) -> None:
    await submit(store, "first")
    driver = Driver(store)
    action = await driver.until(ModelInvocation)
    await store.accept(Submit(request_id="steer", text="next", mode="steer", target_run_id="root"), FENCE)
    await driver.respond(action)
    following = await driver.next()
    assert isinstance(following, ModelInvocation) and following.messages[-1].content == "next"
    assert (await store.get("steer")).status == "succeeded"
    await driver.respond(following)
    await driver.drain()
    assert (await store.get("root")).status == "succeeded"


async def test_queue_reject_busy_scheduled_wake_and_cancel_isolation(store: SessionStore) -> None:
    due = now_ms() + 60000
    await store.accept(Submit(request_id="later", text="scheduled", not_before_ms=due), FENCE)
    with pytest.raises(BackendError, match="session_busy"):
        await store.accept(Submit(request_id="busy", text="no", mode="reject_busy"), FENCE)
    await submit(store, "now")
    await Driver(store).drain()
    assert (await store.get("root")).status == "succeeded"
    assert (await store.activity()).next_wake_ms == due
    await store.cancel("root", FENCE)
    assert (await store.get("root")).status == "succeeded"
    assert (await store.get("later")).status == "waiting_time"


async def test_unknown_model_never_replays_after_restart(store: SessionStore) -> None:
    await submit(store, "model")
    driver = Driver(store)
    invocation = await driver.until(ModelInvocation)
    await store.recover()
    await driver.drain()
    assert (await store.get("root")).status == "unknown" and not driver.models
    with pytest.raises(BackendError, match="stale_generation"):
        await driver.respond(invocation)


async def test_persisted_model_and_tool_results_reused_after_recovery(store: SessionStore) -> None:
    await submit(store)
    driver = Driver(store)
    await driver.respond(await driver.until(ModelInvocation))
    await store.recover()
    await driver.respond(await driver.until(ToolInvocation))
    await store.recover()
    await driver.drain()
    assert len(driver.tools) == 1 and len(driver.models) == 2
    assert (await store.get("root")).status == "succeeded"


async def test_unknown_tool_queries_closes_and_never_reexecutes(store: SessionStore) -> None:
    await submit(store)
    driver = Driver(store)
    invocation = await driver.until(ToolInvocation)
    assert not await store.request_cleanup_complete("root")
    await store.advance(Failed(invocation, "lost_reply"))
    query = await driver.next()
    assert isinstance(query, QueryTool)
    await store.advance(ToolObserved(query, ToolObservation(call_id=query.step_id, state="pending")))
    close = await driver.next()
    assert isinstance(close, CloseEpoch)
    await driver.respond(close)
    query = await driver.next()
    assert isinstance(query, QueryTool)
    await store.advance(ToolObserved(query, ToolObservation(call_id=query.step_id, state="unknown", resource_clean=True)))
    await driver.drain()
    snapshot = await store.snapshot()
    assert snapshot.requests[0].status == "unknown" and snapshot.effects[0].resource_clean
    assert snapshot.pending == 1 and not driver.tools
    assert not await store.request_cleanup_complete("root")
    resolution = EffectResolution(resolution_id="resolve", call_id=query.step_id, outcome="not_applied", evidence="checked")
    await store.resolve(resolution, FENCE)
    assert not await store.request_cleanup_complete("root")
    assert isinstance(await driver.next(), ReconcileEffect)
    await store.advance(EffectResolved(resolution, EffectHold(call_id=query.step_id, session_id=SESSION,
        request_id="root", reason="tool_outcome_unknown", resource_clean=True, reconciled=True)))
    await driver.drain()
    assert (await store.get("root")).status == "unknown" and (await store.snapshot()).pending == 0
    await store.accept(Submit(request_id="other", text="later", not_before_ms=now_ms() + 60000), FENCE)
    assert await store.request_cleanup_complete("root")
    assert not await store.request_cleanup_complete("other")


@pytest.mark.parametrize("settled", [False, True])
async def test_effect_resolution_rejects_second_id_without_pending_work(store: SessionStore, settled: bool) -> None:
    await submit(store)
    driver = Driver(store)
    tool = await driver.until(ToolInvocation)
    await store.advance(Failed(tool, "lost_reply"))
    query = await driver.next()
    assert isinstance(query, QueryTool)
    await store.advance(ToolObserved(query, ToolObservation(call_id=query.step_id, state="unknown")))
    await driver.drain()
    first = EffectResolution(resolution_id="first", call_id=query.step_id, outcome="applied", evidence="checked file")
    await store.resolve(first, FENCE)
    if settled:
        assert isinstance(await driver.next(), ReconcileEffect)
        await store.advance(EffectResolved(first, EffectHold(call_id=query.step_id, session_id=SESSION,
            request_id="root", reason="tool_outcome_unknown", resource_clean=True, reconciled=True)))
        await driver.drain()
    before = await store.snapshot()
    attempts = await asyncio.gather(
        store.resolve(first, FENCE),
        store.resolve(first.model_copy(update={"resolution_id": "second"}), FENCE),
        return_exceptions=True,
    )
    assert not isinstance(attempts[0], BaseException)
    assert isinstance(attempts[1], BackendError) and attempts[1].code == "resolution_conflict"
    assert await store.snapshot() == before
    await store.close()
    reopened = SessionStore(session_database_owner(store).path, SESSION, instance="replacement", require_existing=True)
    await reopened.initialize()
    try:
        assert await reopened.resolve(first, FENCE) == await reopened.get("root")
        with pytest.raises(BackendError, match="resolution_conflict"):
            await reopened.resolve(first.model_copy(update={"resolution_id": "after-restart"}), FENCE)
        action = await reopened.advance()
        if settled:
            assert isinstance(action, Park) and (await reopened.snapshot()).pending == 0
        else:
            assert isinstance(action, ReconcileEffect) and action.resolution == first
        assert (await reopened.activity()).state == "ready"
    finally:
        await reopened.close()


async def test_frozen_resolution_does_not_block_cancellation_settlement(store: SessionStore) -> None:
    await submit(store)
    driver = Driver(store)
    tool = await driver.until(ToolInvocation)
    await store.advance(Failed(tool, "lost_reply"))
    query = await driver.next()
    assert isinstance(query, QueryTool)
    await store.advance(ToolObserved(query, ToolObservation(call_id=query.step_id, state="unknown")))
    await driver.drain()
    await submit(store, "started before freeze", "cancel-me")
    assert isinstance(await driver.next(), ModelInvocation)
    resolution = EffectResolution(resolution_id="resolve", call_id=query.step_id, outcome="applied", evidence="checked")
    await store.resolve(resolution, FENCE)
    await store.freeze(FENCE, "update", cancel_work=True)
    await store.recover(frozen=True)
    assert isinstance(await driver.next(), Park)
    receipt = await store.get("cancel-me")
    assert receipt.status == "unknown" and receipt.cancel_requested
    assert (await store.snapshot()).pending == 1
    await store.thaw(FENCE, "update")
    action = await driver.next()
    assert isinstance(action, ReconcileEffect) and action.resolution == resolution


async def test_decision_waits_for_cleanup_and_cleanup_failure_blocks(store: SessionStore) -> None:
    await submit(store)
    driver = Driver(store)
    invocation = await driver.until(ToolInvocation)
    await store.cancel("root", FENCE)
    await driver.respond(invocation)
    close = await driver.next()
    assert isinstance(close, CloseEpoch)
    assert (await store.get("root")).status == "cleaning"
    await store.advance(EpochClosed(close.request_id, close.lease, Cleanup(session_id=SESSION,
        execution_epoch=close.lease.execution_epoch, state="blocked", resources=[], reason="unproven")))
    assert (await driver.next()) == Park("blocked")
    assert (await store.get("root")).status == "cleaning"
    with pytest.raises(BackendError, match="worker_blocked"):
        await submit(store, "no", "new")


async def test_children_independent_context_and_required_join(store: SessionStore) -> None:
    await submit(store, '/delegate ["child one","child two"]')
    await Driver(store).drain()
    root = await store.get("root")
    assert root.status == "succeeded" and len(root.children) == 2
    for child in root.children:
        assert (await store.get(child)).status == "succeeded"
        messages = await store.messages(child)
        assert messages[0].content in {"child one", "child two"}
        assert all("/delegate" not in message.content for message in messages)
    assert any(m.role == "tool" and all(child in m.content for child in root.children)
               for m in await store.messages("root"))


async def test_child_failure_cancels_sibling_before_parent_settles(store: SessionStore) -> None:
    await submit(store, '/delegate ["first","second"]')
    driver = Driver(store)
    await driver.respond(await driver.until(ModelInvocation))
    child = await driver.until(ModelInvocation)
    assert isinstance(child, ModelInvocation) and child.request_id != "root"
    await store.advance(Failed(child, "unknown_model"))
    await driver.drain()
    root = await store.get("root")
    assert root.status == "unknown" and root.error == "required_child_failed"
    assert [(await store.get(key)).status for key in root.children] == ["unknown", "cancelled"]


async def test_parent_cancel_cascades_and_preserves_other_root(store: SessionStore) -> None:
    await submit(store, '/delegate ["first","second"]')
    driver = Driver(store)
    await driver.respond(await driver.until(ModelInvocation))
    child = await driver.until(ModelInvocation)
    await submit(store, "next", "next")
    await store.cancel("root", FENCE)
    await store.advance(Failed(child, "interrupted"))
    await driver.drain()
    root = await store.get("root")
    assert root.status == "cancelled"
    assert all([(await store.get(key)).status == "cancelled" for key in root.children])
    assert (await store.get("next")).status == "succeeded"


async def test_depth_limit_fails_required_ancestors(store: SessionStore) -> None:
    text = "leaf"
    for _ in range(5):
        text = "/delegate " + json.dumps([text])
    await submit(store, text)
    await Driver(store).drain()
    assert (await store.get("root")).status == "failed"
    assert any(r.error == "child_capacity" for r in (await store.snapshot()).requests)


async def test_freeze_preserves_queued_approval_children_and_stop(store: SessionStore) -> None:
    session_state(store).approval_policy = "mutations"
    await submit(store, '/delegate ["/shell echo child"]')
    await submit(store, "queued", "later")
    driver = Driver(store)
    await driver.drain()
    before = await store.snapshot()
    await store.freeze(FENCE, "update")
    assert (await driver.drain()).reason == "frozen"
    frozen = await store.snapshot()
    assert frozen.pending == before.pending == 3
    assert [r.status for r in frozen.requests] == [r.status for r in before.requests]
    await store.stopping(FENCE, cancel_work=False)
    session_state(store).instance = "replacement"
    await store.recover(frozen=True)
    assert (await store.snapshot()).state == "frozen"
    with pytest.raises(BackendError, match="freeze_conflict"):
        await store.thaw(FENCE, "wrong")
    await store.thaw(FENCE, "update")
    assert (await driver.drain()).reason == "approval"


async def test_freeze_interrupted_model_stays_unknown(store: SessionStore) -> None:
    await submit(store, "running")
    driver = Driver(store)
    action = await driver.until(ModelInvocation)
    await store.freeze(FENCE, "update")
    await store.advance(Failed(action, "execution_interrupted"))
    await driver.drain()
    assert (await store.get("root")).status == "unknown"
    await store.thaw(FENCE, "update")
    await driver.drain()
    assert not driver.models


async def test_snapshot_context_usage_and_preview_replacement(store: SessionStore) -> None:
    await submit(store, "input")
    driver = Driver(store)
    action = await driver.until(ModelInvocation)
    assert isinstance(action, ModelInvocation)
    preview = Preview(request_id="root", run_id="root", generation=action.generation, preview_seq="1", text="prefix")
    await store.advance(Previewed(action, preview))
    assert (await store.snapshot()).previews == [preview]
    result = Completion(message=Message(role="assistant", content="answer", reasoning_signature="opaque-provider-replay"), response_id="response",
                        input_tokens=12, output_tokens=6)
    await store.advance(ModelReturned(action, result))
    await driver.drain()
    snapshot = await store.snapshot()
    assert not snapshot.previews
    messages = [e.message for e in snapshot.events if e.message]
    assert [m.content for m in messages] == ["input", "answer"]
    assert [(m.key, m.ordinal) for m in messages] == [("input", 1), (action.step_id, 2)]
    stored = (await store.messages("root"))[-1]
    assert stored.provider_response_id == "response" and stored.reasoning_signature == "opaque-provider-replay"
    replay = await store.events(0)
    history = await store.history()
    assert "opaque-provider-replay" not in snapshot.model_dump_json() + replay.model_dump_json() + history.model_dump_json()
    assert [event.message for batch in replay.batches for event in batch.events if event.message] == messages
    assert [event.message for event in history.events if event.message] == messages
    assert any('input_tokens' in e.text and '12' in e.text for e in snapshot.events if e.kind == "tool")
    with pytest.raises(BackendError, match="stale_generation"):
        await store.advance(Previewed(action, preview.model_copy(update={"preview_seq": "2"})))


async def test_invalid_arguments_fail_before_epoch(store: SessionStore) -> None:
    await submit(store, "input")
    driver = Driver(store)
    action = await driver.until(ModelInvocation)
    assert isinstance(action, ModelInvocation)
    await store.advance(ModelReturned(action, Completion(message=Message(role="assistant", content="", tool_calls=[
        ToolCall(id="bad", name="write_file", arguments='{"path":"../escape","content":"no"}')]), response_id="bad")))
    await driver.drain()
    assert (await store.get("root")).error == "invalid_workspace_path" and driver.epoch == 0


class FakeSupervisor(SupervisorClient):
    def __init__(self) -> None:
        self.calls: list[tuple[str, BaseModel | None]] = []
        self.epoch = 0
        self.fail_open = False
        self.closed = False

    async def call[T: BaseModel](self, method: str, path: str, response: type[T], body: BaseModel | None = None) -> T:
        self.calls.append((path, body.model_copy(deep=True) if body else None))
        if path == "/workers/heartbeat":
            result = Identity(build_id=FENCE.build_id, fingerprint=FENCE.build_id, profile_id="profile",
                              instance_id="sup", pid=1, role="supervisor", host_epoch=1)
        elif path == "/epochs/open":
            if self.fail_open:
                raise BackendError("lost_open_reply")
            self.epoch += 1
            result = Lease(session_id=SESSION, worker_id="worker", build_id=FENCE.build_id,
                           execution_epoch=self.epoch, supervisor_id="sup")
        elif path == "/epochs/close":
            assert isinstance(body, Lease)
            result = Cleanup(session_id=SESSION, execution_epoch=body.execution_epoch, state="clean",
                             resources=[], proof_id="proof")
        else:
            raise AssertionError(f"unexpected external call {path}")
        return response.model_validate(result.model_dump())

    async def close(self) -> None:
        self.closed = True


def make_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, validation: bool = False) -> tuple[Worker, FakeSupervisor]:
    profile = Profile.__new__(Profile)
    profile.path = profile.ipc = tmp_path
    profile.token = "fake-unit-test-token"
    profile.config = ProfileConfig(profile_id="profile", workspace=str(tmp_path), resources=str(tmp_path),
        provider=ProviderConfig(provider="faux"), approval_policy="auto", user_resources=str(tmp_path / "agent"))
    (tmp_path / "config.json").write_text(profile.config.model_dump_json())
    with sqlite3.connect(tmp_path / "host.sqlite") as db:
        db.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)")
        db.execute("INSERT INTO sessions(id,workspace) VALUES(?, 'primary')", (SESSION,))
    (tmp_path / "sessions" / SESSION).mkdir(parents=True)
    supervisor = FakeSupervisor()
    monkeypatch.setattr("amazme_backend.bootstrap.worker.build_id", lambda: FENCE.build_id)
    def peer(_path: Path, _token: str) -> FakeSupervisor:
        return supervisor
    monkeypatch.setattr("amazme_backend.bootstrap.worker.SupervisorClient", peer)
    return create_worker(profile, SESSION, "worker", frozen=validation, validation=validation), supervisor


async def test_storage_ready_ack_precedes_failed_initial_probe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner, supervisor = make_worker(tmp_path, monkeypatch)
    supervisor.fail_open = True
    try:
        with pytest.raises(BackendError, match="lost_open_reply"):
            await owner.initialize()
        path, body = supervisor.calls[0]
        assert path == "/workers/heartbeat" and isinstance(body, WorkerRequest) and body.storage_ready
        assert owner.loop_task is None and all(path != "/tools/run" for path, _ in supervisor.calls)
    finally:
        await owner.shutdown()
    assert supervisor.closed


async def test_validation_thaw_never_runs_business_cancel_is_metadata_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner, supervisor = make_worker(tmp_path, monkeypatch, validation=True)
    monkeypatch.setattr("amazme_backend.agent.driver.stream", lambda *_: pytest.fail("validation called the model"))
    await owner.initialize()
    try:
        await owner.store.thaw(FENCE, "startup")
        await submit(owner.store, "queued")
        freeze = FreezeWorker(**FENCE.model_dump(), freeze_id="update", cancel_work=True)
        assert (await owner.freeze(freeze)).requests[0].status == "cancelled"
        await owner.thaw(freeze)
        with pytest.raises(BackendError, match="validation_worker"):
            await owner.submit(Submission(**FENCE.model_dump(), value=Submit(request_id="no", text="no")))
        paths = [path for path, _ in supervisor.calls]
        assert owner.loop_task is None and set(paths) <= {"/workers/heartbeat", "/epochs/open", "/epochs/close"}
        assert paths.count("/epochs/open") == paths.count("/epochs/close") == 1
        await owner.request_stop(StopWorker(**FENCE.model_dump(), session_id=SESSION, worker_id="worker",
                                            execution_epoch=supervisor.epoch, reason="update"))
    finally:
        await owner.shutdown()


async def test_stop_uses_local_epoch_without_supervisor_callback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner, supervisor = make_worker(tmp_path, monkeypatch)
    await owner.initialize()
    try:
        await owner.store.freeze(FENCE, "update")
        before = len(supervisor.calls)
        with pytest.raises(BackendError, match="stale_execution_epoch"):
            await owner.request_stop(StopWorker(**FENCE.model_dump(), session_id=SESSION, worker_id="worker", execution_epoch=0))
        identity = await owner.request_stop(StopWorker(**FENCE.model_dump(), session_id=SESSION, worker_id="worker",
            execution_epoch=1, reason="update"))
        assert identity.state == "stopping" and len(supervisor.calls) == before
    finally:
        await owner.shutdown()


@pytest.mark.parametrize("boundary", ["open", "close"])
async def test_repeated_cancel_does_not_interrupt_epoch_boundaries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                boundary: str) -> None:
    owner, _ = make_worker(tmp_path, monkeypatch)
    await owner.store.initialize()
    owner.storage_ready = owner.initialized = True
    await owner.store.fence(FENCE)
    await submit(owner.store)
    action = await Driver(owner.store).until(OpenEpoch if boundary == "open" else CloseEpoch)
    owner.current = action
    gate = asyncio.Event()

    async def blocked() -> Failed:
        await gate.wait()
        return Failed(action, "test")

    task = asyncio.create_task(blocked())
    owner.run_task = task
    try:
        cancellation = Cancel(**FENCE.model_dump(), request_id="root")
        await owner.cancel(cancellation)
        await owner.cancel(cancellation)
        assert not task.cancelled() and not task.done()
    finally:
        gate.set()
        await task
        owner.run_task = None
        await owner.shutdown()


async def test_lost_open_reply_blocks_without_further_model_or_tool(store: SessionStore) -> None:
    await submit(store)
    driver = Driver(store)
    opening = await driver.until(OpenEpoch)
    await store.advance(Failed(opening, "lost_open_reply"))
    for _ in range(3):
        assert await driver.next() == Park("blocked")
    assert len(driver.models) == 1 and not driver.tools
    assert (await store.snapshot()).state == "blocked"


async def test_unknown_effect_counts_toward_queue_capacity(store: SessionStore) -> None:
    await submit(store)
    driver = Driver(store)
    tool = await driver.until(ToolInvocation)
    await store.advance(Failed(tool, "lost"))
    query = await driver.next()
    assert isinstance(query, QueryTool)
    await store.advance(ToolObserved(query, ToolObservation(call_id=query.step_id, state="unknown")))
    await driver.drain()
    assert (await store.get("root")).status == "unknown"
    for i in range(127):
        await submit(store, "queued", f"q{i}")
    with pytest.raises(BackendError, match="queue_full"):
        await submit(store, "no", "overflow")
    snapshot = await store.snapshot()
    assert snapshot.pending == len(snapshot.requests) == 128
    assert len(snapshot.effects) == 1


async def test_snapshot_view_budget_preserves_all_receipts_and_signals_truncation(store: SessionStore,
                                                                               monkeypatch: pytest.MonkeyPatch) -> None:
    await submit(store, "input")
    await Driver(store).drain()
    for i in range(25):
        await submit(store, "queued", f"q{i}")
    monkeypatch.setattr("amazme_backend.sessions.service.SNAPSHOT_VIEW_BYTES", 320)
    snapshot = await store.snapshot()
    assert len(snapshot.requests) == 26 and snapshot.pending == 25
    assert any(e.text == "snapshot_view_truncated" for e in snapshot.events)
    assert sum(len(e.model_dump_json().encode()) for e in snapshot.events if e.kind in {"message", "tool"}) < 320


async def test_snapshot_fact_limit_is_explicit_not_partial_success(store: SessionStore,
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    await submit(store)
    monkeypatch.setattr("amazme_backend.sessions.service.SNAPSHOT_MAX_BYTES", 100)
    with pytest.raises(BackendError, match="snapshot_fact_limit"):
        await store.snapshot()
    assert (await store.get("root")).status == "queued"


async def test_shutdown_drains_driver_even_if_storage_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner, supervisor = make_worker(tmp_path, monkeypatch)
    await owner.store.initialize()
    owner.storage_ready = True
    gate = asyncio.Event()
    async def waiting() -> None:
        await gate.wait()

    owner.loop_task = asyncio.create_task(waiting())
    session_database_owner(owner.store).failure = "injected storage loss"
    try:
        with pytest.raises(BackendError):
            await owner.shutdown()
        assert owner.loop_task.done() and session_database_owner(owner.store).closed and supervisor.closed
    finally:
        owner.loop_task.cancel()
        await asyncio.gather(owner.loop_task, return_exceptions=True)


async def test_driver_observation_failure_closes_admission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner, supervisor = make_worker(tmp_path, monkeypatch)
    await owner.store.initialize()
    owner.storage_ready = owner.initialized = True
    await owner.store.fence(FENCE)
    await submit(owner.store, "input")

    async def invalid(action: Action) -> ModelReturned:
        assert isinstance(action, ModelInvocation)
        return ModelReturned(action, Completion(message=Message(role="user", content="invalid"), response_id="bad"))

    monkeypatch.setattr(owner, "perform", invalid)
    owner.loop_task = asyncio.create_task(owner.loop())
    with pytest.raises(BackendError, match="invalid_tool_calls"):
        await owner.loop_task
    assert owner.stop.is_set() and owner.quiescent.is_set()
    assert (await owner.store.activity()).state == "blocked"
    with pytest.raises(BackendError, match="worker_unavailable"):
        await owner.submit(Submission(**FENCE.model_dump(), value=Submit(request_id="no", text="no")))
    with pytest.raises(BackendError, match="invalid_tool_calls"):
        await owner.shutdown()
    assert supervisor.closed and session_database_owner(owner.store).closed


async def test_approval_revalidates_after_build_change(store: SessionStore) -> None:
    session_state(store).approval_policy = "mutations"
    await submit(store)
    driver = Driver(store)
    await driver.drain()
    old = (await store.snapshot()).approvals[-1]
    decision = ApprovalDecision(decision_id="approved", approval_id=old.approval_id,
        expected_revision=old.revision, proposal_digest=old.proposal_digest, approve=True)
    await store.approve(decision, FENCE)
    session_state(store).build = "next-build"
    await store.recover()
    await driver.drain()
    approvals = (await store.snapshot()).approvals
    assert approvals[0].state == "expired" and approvals[-1].state == "pending"
    assert approvals[-1].build_id == "next-build" and not driver.tools


async def test_snapshot_real_view_limit_with_large_unicode_history(store: SessionStore) -> None:
    from amazme_backend.sessions.policy.limits import SNAPSHOT_MAX_BYTES, SNAPSHOT_VIEW_BYTES

    driver = Driver(store)
    for index in range(12):
        await submit(store, "hello", f"r{index}")
        action = await driver.until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        text = "界" * 30000 if index == 0 else "done"
        await store.advance(ModelReturned(action, Completion(message=Message(role="assistant", content=text),
                                                             response_id=f"response-{index}")))
        await driver.drain()
    snapshot = await store.snapshot()
    assert len(snapshot.requests) == 12 and all(r.status == "succeeded" for r in snapshot.requests)
    assert len(snapshot.model_dump_json().encode()) <= SNAPSHOT_MAX_BYTES
    assert sum(len(e.model_dump_json().encode()) for e in snapshot.events if e.kind in {"tool", "message"}) <= SNAPSHOT_VIEW_BYTES
    assert any(e.text == "snapshot_view_truncated" for e in snapshot.events)


async def test_snapshot_limits_reconciled_effect_history_and_drops_stale_previews(store: SessionStore) -> None:
    import sqlite3

    def history(db: sqlite3.Connection) -> None:
        for index in range(35):
            hold = EffectHold(call_id=f"call-{index}", session_id=SESSION, request_id=f"old-{index}",
                              reason="unknown", resource_clean=True, reconciled=index != 0)
            db.execute("INSERT INTO effects VALUES(?,?)", (hold.call_id, hold.model_dump_json()))
        preview = Preview(request_id="missing", run_id="missing", generation=0, preview_seq="1", text="stale")
        db.execute("INSERT INTO previews VALUES(?,?)", (preview.request_id, preview.model_dump_json()))
    await session_database_owner(store).call(history)
    snapshot = await store.snapshot()
    assert len(snapshot.effects) == 21 and snapshot.effects[0].call_id == "call-0"
    assert not snapshot.previews


@pytest.mark.parametrize("change", ["revision", "digest", "policy"])
async def test_approval_rejects_stale_parameters_and_policy(store: SessionStore, change: str) -> None:
    session_state(store).approval_policy = "mutations"
    await submit(store)
    driver = Driver(store)
    await driver.drain()
    approval = (await store.snapshot()).approvals[-1]
    decision = ApprovalDecision(decision_id="decision", approval_id=approval.approval_id,
        expected_revision="0" if change == "revision" else approval.revision,
        proposal_digest="wrong" if change == "digest" else approval.proposal_digest, approve=True)
    if change == "policy":
        session_state(store).approval_policy = "all"
    with pytest.raises(BackendError, match="stale_approval"):
        await store.approve(decision, FENCE)
    assert not driver.tools and driver.epoch == 0
