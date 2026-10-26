"""Controllable request clocks, durable continuation and provider-visible context."""
from datetime import datetime

import pytest
from session_test_support import session_state
from test_run_options import FENCE, next_action, opened

from amazme_backend.agent.model import model_request
from amazme_backend.agent.prompting import clock_context
from amazme_backend.ai.types import Auth
from amazme_backend.contracts import Cleanup, Lease, Message, Submit, ToolCall, ToolResult
from amazme_backend.sessions.types import (
    CloseEpoch,
    Completion,
    EpochClosed,
    EpochOpened,
    ModelInvocation,
    ModelReturned,
    OpenEpoch,
    ToolInvocation,
    ToolReturned,
)
from amazme_backend.shared.errors import BackendError


def instant(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def wire(action):
    return model_request(action.config, action.messages, auth=Auth(),
        context=clock_context(action.config.time_zone, action.started_at_ms)).system_prompt


@pytest.mark.parametrize("zone,date,source", [
    ("Asia/Shanghai", "2026-10-27", "Asia/Shanghai (reported by client)"),
    ("America/Los_Angeles", "2026-10-26", "America/Los_Angeles (reported by client)"),
    ("", "2026-10-26", "UTC is the display fallback"),
])
async def test_client_zone_or_explicit_utc_fallback_reaches_model(tmp_path, monkeypatch, zone, date, source):
    monkeypatch.setattr("amazme_backend.sessions.persistence.clock.now_ms", lambda: instant("2026-10-26T16:30:00+00:00"))
    store = await opened(tmp_path / "session.sqlite")
    try:
        await store.accept(Submit(request_id="root", text="date", time_zone=zone), FENCE)
        action = await next_action(store)
        assert isinstance(action, ModelInvocation)
        prompt = wire(action)
        assert f"Current date at that sample: {date}." in prompt and source in prompt
    finally:
        await store.close()


async def test_resume_keeps_request_sample_and_next_request_refreshes_after_midnight(tmp_path, monkeypatch):
    now = instant("2026-10-26T15:59:59+00:00")
    monkeypatch.setattr("amazme_backend.sessions.persistence.clock.now_ms", lambda: now)
    path = tmp_path / "session.sqlite"
    store = await opened(path)
    try:
        await store.accept(Submit(request_id="first", text="read", time_zone="Asia/Shanghai"), FENCE)
        first = await next_action(store)
        assert isinstance(first, ModelInvocation)
        first_prompt = wire(first)
        await store.advance(ModelReturned(first, Completion(response_id="first", message=Message(role="assistant", content="", tool_calls=[
            ToolCall(id="read", name="read_file", arguments='{"path":"note"}')]))))
        assert isinstance(await next_action(store), OpenEpoch)
        lease = Lease(session_id="session", worker_id=session_state(store).instance, execution_epoch=1,
                      build_id="test-build", supervisor_id="supervisor")
        await store.advance(EpochOpened("first", lease))
        tool = await next_action(store)
        assert isinstance(tool, ToolInvocation)
        await store.advance(ToolReturned(tool, ToolResult(call_id=tool.step_id, exit_code=0, stdout="read", stderr="")))
        closing = await next_action(store)
        assert isinstance(closing, CloseEpoch)
        await store.advance(EpochClosed("first", lease, Cleanup(session_id="session", execution_epoch=1,
            state="clean", resources=[], proof_id="proof")))
        await store.close()
        now = instant("2026-10-26T16:00:01+00:00")
        store = await opened(path)
        resumed = await next_action(store)
        assert isinstance(resumed, ModelInvocation)
        assert wire(resumed) == first_prompt and resumed.started_at_ms == first.started_at_ms
        await store.advance(ModelReturned(resumed, Completion(response_id="done", message=Message(role="assistant", content="done"))))
        await next_action(store)
        await store.accept(Submit(request_id="next", text="new date", time_zone="Asia/Shanghai"), FENCE)
        following = await next_action(store)
        assert isinstance(following, ModelInvocation)
        assert "Current date at that sample: 2026-10-27." in wire(following)
        assert following.started_at_ms == now
    finally:
        await store.close()


async def test_user_steer_refreshes_time_and_zone_without_waiting_for_a_new_tool(tmp_path, monkeypatch):
    now = instant("2026-10-26T15:59:59+00:00")
    monkeypatch.setattr("amazme_backend.sessions.persistence.clock.now_ms", lambda: now)
    store = await opened(tmp_path / "session.sqlite")
    try:
        await store.accept(Submit(request_id="root", text="wait", time_zone="UTC"), FENCE)
        first = await next_action(store)
        now = instant("2026-10-26T16:00:01+00:00")
        await store.accept(Submit(request_id="steer", text="now", mode="steer", target_run_id="root", time_zone="Asia/Tokyo"), FENCE)
        await store.advance(ModelReturned(first, Completion(response_id="before", message=Message(role="assistant", content="before"))))
        second = await next_action(store)
        assert isinstance(second, ModelInvocation)
        assert second.started_at_ms == now and "2026-10-27" in wire(second) and "Asia/Tokyo" in wire(second)
    finally:
        await store.close()


def test_invalid_zone_is_rejected_in_product_context_before_provider_dispatch():
    with pytest.raises(BackendError, match="invalid_time_zone"):
        clock_context("Invalid/Zone", instant("2026-10-26T00:00:00+00:00"))
