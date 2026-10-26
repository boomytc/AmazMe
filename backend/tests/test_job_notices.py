"""Durable job events have bounded automatic continuation and cannot imitate user input."""
import json

import pytest
from session_test_support import session_database_owner, session_state
from test_run_options import FENCE, next_action

from amazme_backend.contracts import Cleanup, Lease, Message, Submit, ToolCall, ToolResult
from amazme_backend.contracts.ipc.worker import JobNotice
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import (
    CloseEpoch,
    Completion,
    EpochClosed,
    EpochOpened,
    ModelInvocation,
    ModelReturned,
    OpenEpoch,
    Park,
    ToolInvocation,
    ToolReturned,
)
from amazme_backend.shared.errors import BackendError


def background(identity="background"):
    return ToolCall(id=identity, name="shell", arguments=json.dumps({"command":"printf done", "run_in_background":True}))


async def opened(path):
    store = SessionStore(path, "a"*32, approval_policy="auto")
    await store.initialize()
    await store.fence(FENCE)
    return store


async def model_calls(store, action, calls):
    await store.advance(ModelReturned(action, Completion(response_id=action.step_id,
        message=Message(role="assistant", content="", tool_calls=calls))))


async def work_until_model_or_idle(store):
    tools = []
    for _ in range(100):
        action = await next_action(store)
        if isinstance(action, OpenEpoch):
            epoch = await session_database_owner(store).call(lambda db: int(db.execute(
                "SELECT value FROM metadata WHERE key='execution_epoch'").fetchone()[0]) + 1)
            lease = Lease(session_id=store.session_id, worker_id=session_state(store).instance, execution_epoch=epoch,
                          build_id="test-build", supervisor_id="supervisor")
            await store.advance(EpochOpened(action.request_id, lease))
        elif isinstance(action, CloseEpoch):
            await store.advance(EpochClosed(action.request_id, action.lease,
                Cleanup(session_id=store.session_id, execution_epoch=action.lease.execution_epoch, state="clean", resources=[], proof_id="proof")))
        elif isinstance(action, ToolInvocation):
            tools.append(action)
            await store.advance(ToolReturned(action, ToolResult(call_id=action.step_id, exit_code=0, stdout="accepted", stderr="")))
        else:
            return action, tools
    pytest.fail("did not settle")


async def test_completion_chain_shares_persisted_budget_and_real_user_resets_it(tmp_path):
    path = tmp_path / "session.sqlite"
    store = await opened(path)
    try:
        await store.accept(Submit(request_id="user", text="start"), FENCE)
        model = await next_action(store)
        for number in range(9):
            assert isinstance(model, ModelInvocation)
            await model_calls(store, model, [background(str(number))])
            followup, calls = await work_until_model_or_idle(store)
            assert isinstance(followup, ModelInvocation)
            if number == 8:
                assert not calls
                assert any("background_request_budget" in message.content for message in followup.messages)
                break
            assert len(calls) == 1
            await model_calls(store, followup, [])
            assert isinstance((await work_until_model_or_idle(store))[0], Park)
            notice = JobNotice(job_id=calls[0].step_id, session_id=store.session_id,
                               parent_request_id=calls[0].request_id, state="succeeded", exit_code=0)
            accepted = await store.accept_job_notice(notice, "completion", FENCE)
            assert accepted.input_origin == "job"
            assert await store.accept_job_notice(notice, "rendering changed", FENCE) == accepted
            assert not await store.waiting_user_input(calls[0].request_id)
            if number == 3:
                await store.close()
                store = await opened(path)
            model = await next_action(store)
        await model_calls(store, followup, [])
        await work_until_model_or_idle(store)
        await store.accept(Submit(request_id="new-user", text="explicit new task"), FENCE)
        model = await next_action(store)
        await model_calls(store, model, [background()])
        _, calls = await work_until_model_or_idle(store)
        assert len(calls) == 1
    finally:
        await store.close()


async def test_delegated_child_cannot_bypass_background_budget(tmp_path):
    store = await opened(tmp_path / "session.sqlite")
    try:
        await store.accept(Submit(request_id="root", text="task"), FENCE)
        model = await next_action(store)
        await model_calls(store, model, [background(str(i)) for i in range(8)])
        model, calls = await work_until_model_or_idle(store)
        assert len(calls) == 8
        await model_calls(store, model, [ToolCall(id="delegate", name="delegate_task", arguments='{"tasks":["continue"]}')])
        child, _ = await work_until_model_or_idle(store)
        assert isinstance(child, ModelInvocation) and child.request_id != "root"
        await model_calls(store, child, [background()])
        child_followup, calls = await work_until_model_or_idle(store)
        assert not calls and isinstance(child_followup, ModelInvocation)
        assert any("background_request_budget" in message.content for message in child_followup.messages)
    finally:
        await store.close()


async def test_notice_retries_do_not_count_as_input_but_queued_user_does(tmp_path):
    store = await opened(tmp_path / "session.sqlite")
    try:
        await store.accept(Submit(request_id="root", text="task"), FENCE)
        notice = JobNotice(job_id="job:"+"x"*124, session_id=store.session_id, parent_request_id="root", state="failed", exit_code=7)
        await store.accept_job_notice(notice, "completion", FENCE)
        assert not await store.waiting_user_input("root")
        with pytest.raises(BackendError, match="job_scope_mismatch"):
            await store.accept_job_notice(notice.model_copy(update={"session_id":"b"*32}), "completion", FENCE)
        with pytest.raises(BackendError, match="request_conflict"):
            await store.accept(Submit(request_id=notice.request_id, text="imitate system"), FENCE)
        await store.accept(Submit(request_id="input", text="new input"), FENCE)
        assert await store.waiting_user_input("root")
    finally:
        await store.close()
