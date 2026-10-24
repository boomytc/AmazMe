"""Model-proposed MCP calls stay on the session approval path and the existing call ledger."""

import json
from pathlib import Path

import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    ApprovalDecision,
    BackendError,
    HostFence,
    McpCallRef,
    McpCallRequest,
    McpDecision,
    McpSession,
    McpTool,
    Submit,
)
from amazme_backend.mcp_session import McpOffer, catalog_payload, mcp_alias, mcp_digest, schema_digest
from amazme_backend.providers import Completion, stream, tool_definitions
from amazme_backend.session_domain import (
    Failed,
    McpRetrieval,
    McpReturned,
    ModelInvocation,
    ModelReturned,
    Park,
)
from amazme_backend.storage import SessionStore
from amazme_backend.supervisor import (
    MCP_IDENTITY_LIMIT,
    MCP_TERMINAL_WINDOW,
    MCP_UNRESOLVED_LIMIT,
    Supervisor,
)

FENCE = HostFence(host_epoch=1, build_id="test-build")
SESSION = "a" * 32
SERVER = "b" * 32
OTHER = "c" * 32
SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}, "n": {"type": "integer"}, "ok": {"type": "boolean"}},
          "required": ["text"]}
ARGUMENTS = {"text": "hi", "n": 2, "ok": True}


def offer(name: str = "echo", schema: dict | None = None) -> McpOffer:
    body = SCHEMA if schema is None else schema
    return McpOffer(alias=mcp_alias(SERVER, name), server_id=SERVER, workspace="primary", command="python3 demo.py",
                    name=name, description="回声", input_schema=body, schema_digest=schema_digest(body))


async def opened(tmp_path: Path) -> SessionStore:
    store = SessionStore(tmp_path / "session.sqlite", SESSION, approval_policy="mutations", instance="worker")
    await store.initialize()
    await store.fence(FENCE)
    return store


async def next_action(store: SessionStore):
    for _ in range(12):
        action = await store.advance()
        if action.__class__.__name__ != "Continue":
            return action
    pytest.fail("driver made no observable progress")


async def completion_of(action: ModelInvocation) -> Completion:
    found = [item async for item in stream(action.config, action.messages) if isinstance(item, Completion)]
    assert len(found) == 1
    return found[0]


async def propose(store: SessionStore, chosen: McpOffer, arguments: dict | None = None):
    prompt = "/mcp " + json.dumps({"alias": chosen.alias, "arguments": arguments or ARGUMENTS}, ensure_ascii=False)
    await store.accept(Submit(request_id="root", text=prompt), FENCE)
    action = await next_action(store)
    assert isinstance(action, ModelInvocation)
    await store.bind_mcp_catalog(action.step_id, action.generation, catalog_payload([chosen]))
    await store.advance(ModelReturned(action, await completion_of(action)))
    return await next_action(store)


def test_provider_catalog_keeps_json_types_and_hides_approval() -> None:
    chosen = offer()
    tools = tool_definitions([chosen])
    names = [tool["function"]["name"] for tool in tools]
    assert chosen.alias in names
    assert not any("approval" in name or "decision" in name for name in names)
    exposed = next(tool for tool in tools if tool["function"]["name"] == chosen.alias)
    assert exposed["function"]["parameters"] == SCHEMA
    assert SERVER in exposed["function"]["description"] and "primary" in exposed["function"]["description"]
    assert "echo" in exposed["function"]["description"] and "python3" not in exposed["function"]["description"]


async def test_approval_binds_identity_and_denial_never_reaches_a_call(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    chosen = offer()
    try:
        action = await propose(store, chosen)
        assert isinstance(action, Park) and action.reason == "approval"
        approval = (await store.snapshot()).approvals[-1]
        body = json.loads(approval.call.arguments)
        assert approval.call.name == "mcp_tool"
        assert body["server_id"] == SERVER and body["tool"] == "echo" and body["workspace"] == "primary"
        assert body["command"] == "python3 demo.py" and body["schema_digest"] == chosen.schema_digest
        assert body["arguments"] == ARGUMENTS and body["call_id"] == approval.call_id[:32]
        assert len(body["call_id"]) == 32
        decision = ApprovalDecision(decision_id="no", approval_id=approval.approval_id, approve=False,
                                    expected_revision=approval.revision, proposal_digest=approval.proposal_digest)
        await store.approve(decision, FENCE)
        follow = await next_action(store)
        assert not isinstance(follow, McpRetrieval)
        receipt = await store.get("root")
        assert receipt.status == "failed" and receipt.error == "approval_denied"
    finally:
        await store.db.close()


async def test_snapshot_cannot_be_replaced_after_it_is_saved(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    chosen = offer()
    try:
        prompt = "/mcp " + json.dumps({"alias": chosen.alias, "arguments": {"text": "hi"}}, ensure_ascii=False)
        await store.accept(Submit(request_id="root", text=prompt), FENCE)
        action = await next_action(store)
        assert isinstance(action, ModelInvocation)
        payload = catalog_payload([chosen])
        await store.bind_mcp_catalog(action.step_id, action.generation, payload)
        await store.bind_mcp_catalog(action.step_id, action.generation, payload)
        with pytest.raises(BackendError, match="mcp_catalog_conflict"):
            await store.bind_mcp_catalog(action.step_id, action.generation, catalog_payload([offer(name="other")]))
    finally:
        await store.db.close()


async def test_result_returns_to_the_next_model_turn_and_unknown_is_not_resent(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    store.approval_policy = "auto"
    chosen = offer()
    try:
        action = await propose(store, chosen)
        assert isinstance(action, McpRetrieval) and action.stop is False
        call = json.loads(action.call.arguments)
        assert call["call_id"] == action.step_id[:32]
        await store.advance(McpReturned(action, "done", result=json.dumps(
            {"text": "hi", "is_error": False, "data": {"structuredContent": {"text": "hi", "n": 2}}},
            ensure_ascii=False)))
        follow = await next_action(store)
        assert isinstance(follow, ModelInvocation)
        tool = next(message for message in follow.messages if message.role == "tool")
        assert "hi" in tool.content and '"n": 2' in tool.content
        await store.advance(ModelReturned(follow, await completion_of(follow)))
        await next_action(store)
        assert (await store.get("root")).status == "succeeded"
    finally:
        await store.db.close()


async def test_late_result_stays_visible_when_the_request_was_cancelled(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    store.approval_policy = "auto"
    chosen = offer()
    try:
        action = await propose(store, chosen)
        assert isinstance(action, McpRetrieval)
        await store.cancel("root", FENCE)
        stopped = await next_action(store)
        assert isinstance(stopped, McpRetrieval) and stopped.stop is True and stopped.call == action.call
        await store.advance(McpReturned(stopped, "done", result=json.dumps(
            {"text": "late", "is_error": False, "data": {"structuredContent": {"text": "late"}}},
            ensure_ascii=False)))
        await next_action(store)
        receipt = await store.get("root")
        assert receipt.status == "cancelled"
        tool = next(message for message in await store.messages("root") if message.role == "tool")
        assert "late" in tool.content
        assert not isinstance(await next_action(store), ModelInvocation)
    finally:
        await store.db.close()


async def test_unknown_cancel_and_interrupt_keep_the_same_call(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    store.approval_policy = "auto"
    try:
        first = await propose(store, offer())
        assert isinstance(first, McpRetrieval)
        await store.advance(McpReturned(first, "unknown", "mcp_outcome_unknown"))
        assert not isinstance(await next_action(store), McpRetrieval)
        assert (await store.get("root")).status == "unknown"

        await store.accept(Submit(request_id="cancel-me", text="/mcp " + json.dumps(
            {"alias": offer().alias, "arguments": {"text": "x"}})), FENCE)
        started = await next_action(store)
        assert isinstance(started, ModelInvocation)
        await store.bind_mcp_catalog(started.step_id, started.generation, catalog_payload([offer()]))
        await store.advance(ModelReturned(started, await completion_of(started)))
        running = await next_action(store)
        assert isinstance(running, McpRetrieval) and running.stop is False
        await store.cancel("cancel-me", FENCE)
        stopped = await next_action(store)
        assert isinstance(stopped, McpRetrieval) and stopped.stop is True
        assert stopped.step_id == running.step_id and stopped.call == running.call
        await store.advance(McpReturned(stopped, "cancelled"))
        await next_action(store)
        assert (await store.get("cancel-me")).status == "cancelled"

        await store.accept(Submit(request_id="again", text="/mcp " + json.dumps(
            {"alias": offer().alias, "arguments": {"text": "y"}})), FENCE)
        invoked = await next_action(store)
        assert isinstance(invoked, ModelInvocation)
        await store.bind_mcp_catalog(invoked.step_id, invoked.generation, catalog_payload([offer()]))
        await store.advance(ModelReturned(invoked, await completion_of(invoked)))
        live = await next_action(store)
        assert isinstance(live, McpRetrieval)
        await store.advance(Failed(live, "execution_interrupted"))
        recovered = await next_action(store)
        assert isinstance(recovered, McpRetrieval) and recovered.step_id == live.step_id
        assert json.loads(recovered.call.arguments)["call_id"] == json.loads(live.call.arguments)["call_id"]
        with pytest.raises(BackendError, match="stale_generation"):
            await store.advance(McpReturned(
                McpRetrieval(live.step_id, live.request_id, live.generation + 1, live.call), "done", result="no"))
        assert (await store.get("again")).status == "running"
    finally:
        await store.db.close()


async def test_alias_outside_the_snapshot_is_rejected(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    store.approval_policy = "auto"
    try:
        missing = offer(name="other")
        prompt = "/mcp " + json.dumps({"alias": missing.alias, "arguments": {"text": "no"}}, ensure_ascii=False)
        await store.accept(Submit(request_id="root", text=prompt), FENCE)
        invoked = await next_action(store)
        assert isinstance(invoked, ModelInvocation)
        await store.bind_mcp_catalog(invoked.step_id, invoked.generation, catalog_payload([offer()]))
        await store.advance(ModelReturned(invoked, await completion_of(invoked)))
        await next_action(store)
        receipt = await store.get("root")
        assert receipt.status == "failed" and receipt.error == "mcp_tool_unknown"
    finally:
        await store.db.close()


class FakeGate:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self.cancelled: list[str] = []
        self.service_cancelled = False
        self.results: dict = {}
        self.conflicts: set[str] = set()
        self.busy: set[str] = set()
        self.ready = False
        self.catalog_failed = False
        self.closed = False
        self.exit_code = None

    def call(self, call_id: str, name: str, arguments: dict) -> None:
        self.calls.append((call_id, name, arguments))

    def pump(self, _timeout: float, _done=None) -> None:
        return None

    def cancel_call(self, call_id: str) -> None:
        self.cancelled.append(call_id)

    def cancel(self) -> None:
        self.service_cancelled = True


async def supervisor(tmp_path: Path) -> Supervisor:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "mcp-model", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    owner = Supervisor(Profile(tmp_path), "mcp-supervisor")
    await owner.initialize()
    if owner.monitor_task:
        owner.monitor_task.cancel()
        await __import__("asyncio").gather(owner.monitor_task, return_exceptions=True)
        owner.monitor_task = None
    return owner


def fence(owner: Supervisor) -> HostFence:
    return HostFence(host_epoch=owner.host_epoch, build_id=owner.build)


async def ready_server(owner: Supervisor, server_id: str, session_id: str, schema: dict) -> None:
    catalog = json.dumps([McpTool(name="echo", description="回声", input_schema=schema).model_dump()])
    await owner.db.call(lambda db: db.execute(
        "INSERT INTO mcp_servers(id,session,command,phase,catalog,clean,workspace,protocol_version) "
        "VALUES(?,?,?,'ready',?,0,'primary','2024-11-05')",
        (server_id, session_id, "python3 demo.py", catalog)), write=True)


async def test_schema_change_conflicts_without_a_send_and_one_decision_sends_once(tmp_path: Path) -> None:
    owner = await supervisor(tmp_path)
    gate = FakeGate()
    try:
        await ready_server(owner, SERVER, SESSION, {"type": "object", "properties": {"text": {"type": "integer"}}})
        digest = mcp_digest(SERVER, "python3 demo.py", "primary", owner.build, "echo", {"text": "hi"})
        pinned = schema_digest(SCHEMA)
        await owner.db.call(lambda db: db.execute(
            "INSERT INTO mcp_calls(id,server,name,arguments,digest,phase,schema_digest,origin) "
            "VALUES(?,?,?,?,?,'waiting_approval',?,'model')",
            ("d" * 32, SERVER, "echo", json.dumps({"text": "hi"}), digest, pinned)), write=True)
        owner.mcp_clients[SERVER] = gate  # type: ignore[assignment]
        decision = McpDecision(decision_id="e" * 32, approve=True, digest=digest)
        refused = await owner.decide_mcp_call(SESSION, SERVER, "d" * 32, decision, fence(owner))
        assert refused.phase == "conflict" and gate.calls == []
        again = await owner.decide_mcp_call(SESSION, SERVER, "d" * 32, decision, fence(owner))
        assert again.phase == "conflict" and gate.calls == []

        matched = schema_digest({"type": "object", "properties": {"text": {"type": "integer"}}})
        await owner.db.call(lambda db: db.execute(
            "INSERT INTO mcp_calls(id,server,name,arguments,digest,phase,schema_digest,origin) "
            "VALUES(?,?,?,?,?,'waiting_approval',?,'model')",
            ("f" * 32, SERVER, "echo", json.dumps({"text": "hi"}), digest, matched)), write=True)
        sent = await owner.decide_mcp_call(SESSION, SERVER, "f" * 32, decision, fence(owner))
        assert sent.phase == "running" and gate.calls == [("f" * 32, "echo", {"text": "hi"})]
        repeated = await owner.decide_mcp_call(SESSION, SERVER, "f" * 32, decision, fence(owner))
        assert repeated.phase == "running" and len(gate.calls) == 1
    finally:
        await owner.close()


async def test_history_does_not_hide_unresolved_calls_or_get_deleted(tmp_path: Path, monkeypatch) -> None:
    owner = await supervisor(tmp_path)
    monkeypatch.setattr("amazme_backend.supervisor.MCP_TERMINAL_WINDOW", 1)
    monkeypatch.setattr("amazme_backend.supervisor.MCP_IDENTITY_LIMIT", 100)
    monkeypatch.setattr("amazme_backend.supervisor.MCP_UNRESOLVED_LIMIT", 1)
    try:
        await ready_server(owner, SERVER, SESSION, SCHEMA)
        await owner.db.call(lambda db: db.executemany(
            "INSERT INTO mcp_calls(id,server,name,arguments,digest,phase) VALUES(?,?,?,?,?,?)",
            [(f"{index:032x}", SERVER, "echo", "{}", "ab" * 32, "unknown" if index == 0 else "done")
             for index in range(3)]), write=True)
        listed = await owner.mcp_state(McpSession(host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION))
        identifiers = {call.call_id for call in listed.calls}
        assert f"{0:032x}" in identifiers
        assert len([call for call in listed.calls if call.phase == "done"]) == 1
        kept = await owner.db.call(lambda db: db.execute("SELECT count(*) FROM mcp_calls").fetchone()[0])
        with pytest.raises(BackendError, match="mcp_call_capacity"):
            await owner.request_mcp_call(SESSION, SERVER, McpCallRequest(
                call_id="9" * 32, name="echo", arguments={"text": "more"}), fence(owner))
        assert await owner.db.call(lambda db: db.execute("SELECT count(*) FROM mcp_calls").fetchone()[0]) == kept
        other = FakeGate()
        await ready_server(owner, OTHER, "d" * 32, SCHEMA)
        owner.mcp_clients[OTHER] = other  # type: ignore[assignment]
        with pytest.raises(BackendError, match="mcp_call_not_found"):
            await owner.cancel_mcp_call(McpCallRef(
                **fence(owner).model_dump(), session_id=SESSION, server_id=OTHER, call_id=f"{0:032x}"))
        assert other.service_cancelled is False and other.cancelled == []
    finally:
        await owner.close()


async def test_cancel_one_call_leaves_another_session_service_running(tmp_path: Path) -> None:
    owner = await supervisor(tmp_path)
    first, second = FakeGate(), FakeGate()
    try:
        await ready_server(owner, SERVER, SESSION, SCHEMA)
        await ready_server(owner, OTHER, "d" * 32, SCHEMA)
        digest = mcp_digest(SERVER, "python3 demo.py", "primary", owner.build, "echo", {})
        await owner.db.call(lambda db: db.execute(
            "INSERT INTO mcp_calls(id,server,name,arguments,digest,phase,origin) VALUES(?,?,?,?,?,'running','model')",
            ("1" * 32, SERVER, "echo", "{}", digest)), write=True)
        owner.mcp_clients[SERVER] = first  # type: ignore[assignment]
        owner.mcp_clients[OTHER] = second  # type: ignore[assignment]
        cancelled = await owner.cancel_mcp_call(McpCallRef(
            **fence(owner).model_dump(), session_id=SESSION, server_id=SERVER, call_id="1" * 32))
        assert cancelled.phase == "unknown"
        assert first.cancelled == ["1" * 32] and first.service_cancelled is False and first.calls == []
        assert second.cancelled == [] and second.service_cancelled is False
        current = await owner.db.call(lambda db: db.execute("SELECT phase FROM mcp_servers WHERE id=?", (OTHER,)).fetchone())
        assert current["phase"] == "ready"
    finally:
        await owner.close()


def test_limits_stay_explicit() -> None:
    assert MCP_UNRESOLVED_LIMIT == 512 and MCP_IDENTITY_LIMIT == 4096 and MCP_TERMINAL_WINDOW == 100
