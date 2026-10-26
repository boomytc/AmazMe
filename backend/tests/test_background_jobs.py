"""One execution store owns background intent, output and resource settlement."""
import asyncio
import json

import pytest
from pydantic import ValidationError
from test_execution_p2 import call, worker
from test_execution_p2 import owner as owner
from test_execution_p2 import profile as profile

from amazme_backend.contracts.execution import Shell
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.supervisor import FreezeSupervisor, JobOutputQuery, JobReference, JobSession
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.shared.errors import BackendError


def fence(owner):
    return {"host_epoch": owner.host_epoch, "build_id": owner.build}


def test_long_execution_deadline_requires_explicit_background_and_remains_bounded():
    assert Shell(command="build").timeout_seconds == 30
    with pytest.raises(ValidationError):
        Shell(command="build", timeout_seconds=121)
    assert Shell(command="build", timeout_seconds=86400, run_in_background=True).timeout_seconds == 86400
    with pytest.raises(ValidationError):
        Shell(command="build", timeout_seconds=86401, run_in_background=True)


@pytest.mark.parametrize("gate", ["host", "supervisor"])
async def test_update_cannot_claim_clean_while_closed_epoch_background_job_is_running(owner, gate):
    info, reservation = await worker(owner)
    value, _ = await start(owner, info, command="printf start; sleep 20")
    await owner.cleanup(info.session_id, value)
    reservation.close()
    assert (await owner.retire_worker(info, "recovery")).state == "clean"
    freeze = FreezeSupervisor(**fence(owner), freeze_id="update")
    health = await owner.freeze(freeze)
    assert (await owner.invocations.job_scope(reference(owner, value)))["outcome"] == "pending"
    with pytest.raises(BackendError, match="execution_cleanup_pending|update_health_unproven"):
        if gate == "host":
            HostLifecycle.verify_clean(health)
        else:
            await owner.thaw(freeze)


def reference(owner, value):
    return JobReference(**fence(owner), session_id=value.session_id, job_id=value.call_id)


async def start(owner, info, identity="background", command="printf start; sleep 3; printf done"):
    value = (await call(owner, info, identity=identity)).model_copy(update={
        "command": command, "run_in_background": True, "timeout_seconds": 20})
    ack = await asyncio.wait_for(owner.invocations.run(value), 5)
    return value, ack


async def test_background_survives_epoch_close_and_retries_do_not_duplicate(owner):
    info, _ = await worker(owner)
    value, ack = await start(owner, info, command="printf x >> once; printf start; sleep 3; printf done")
    task = owner.invocations.jobs[value.call_id]
    assert json.loads(ack.stdout)["state"] == "running" and not task.done()
    assert await owner.invocations.run(value) == ack
    with pytest.raises(BackendError, match="call_conflict"):
        await owner.invocations.run(value.model_copy(update={"command":"printf another >> once"}))
    proof = await owner.cleanup(info.session_id, value)
    assert proof.state == "clean" and not task.done()
    listed = await owner.invocations.list_jobs(JobSession(**fence(owner), session_id=info.session_id))
    assert listed.jobs[0].job_id == value.call_id and listed.jobs[0].state == "running"
    await asyncio.wait_for(task, 10)
    page = await owner.invocations.job_output(JobOutputQuery(**reference(owner, value).model_dump()))
    assert page.job.state == "succeeded" and page.job.resource_clean and page.output.content == "startdone"
    assert (owner.profile.path / "once").read_text() == "x"
    assert await owner.invocations.job_output(JobOutputQuery(**reference(owner, value).model_dump())) == page


async def test_kill_is_idempotent_and_checks_session_scope(owner):
    info, _ = await worker(owner)
    value, _ = await start(owner, info, command="printf start; sleep 20; printf bad > late")
    other, _ = await worker(owner, "b" * 32)
    denied = JobReference(**fence(owner), session_id=other.session_id, job_id=value.call_id)
    for operation in (owner.invocations.kill_job, owner.invocations.job_scope):
        with pytest.raises(BackendError, match="job_scope_mismatch"):
            await operation(denied)
    killed = await owner.invocations.kill_job(reference(owner, value))
    assert killed.state == "cancelled" and killed.resource_clean and killed.cancel_requested
    assert await owner.invocations.kill_job(reference(owner, value)) == killed
    assert not (owner.profile.path / "late").exists()


async def test_nonzero_completion_notice_and_output_do_not_consume_a_cursor(owner):
    info, _ = await worker(owner)
    value, _ = await start(owner, info, command="printf first; sleep .3; printf last; printf err >&2; exit 7")
    task = owner.invocations.jobs[value.call_id]
    await asyncio.wait_for(task, 10)
    query = JobOutputQuery(**reference(owner, value).model_dump())
    page = await owner.invocations.job_output(query)
    assert page.job.state == "failed" and page.job.exit_code == 7 and page.output.content == "firstlast"
    stderr = await owner.invocations.job_output(query.model_copy(update={"stream":"stderr"}))
    assert stderr.output.content == "err"
    pending = await owner.invocations.pending_job_notices(HostFence(**fence(owner)))
    assert [job.job_id for job in pending.jobs] == [value.call_id]
    await owner.invocations.acknowledge_job_notice(reference(owner, value))
    await owner.invocations.acknowledge_job_notice(reference(owner, value))
    assert not (await owner.invocations.pending_job_notices(HostFence(**fence(owner)))).jobs
    assert (await owner.invocations.job_output(query)).output == page.output


async def test_capacity_refuses_before_the_second_effect(owner, monkeypatch):
    monkeypatch.setattr("amazme_backend.execution.invocations.SESSION_BACKGROUND_LIMIT", 1)
    info, _ = await worker(owner)
    value, _ = await start(owner, info)
    second = value.model_copy(update={"call_id":"second", "command":"printf bad > second"})
    with pytest.raises(BackendError, match="background_capacity"):
        await owner.invocations.run(second)
    assert not (owner.profile.path / "second").exists()
    await owner.invocations.kill_job(reference(owner, value))


async def test_worker_retirement_does_not_cancel_a_session_job(owner):
    info, reservation = await worker(owner)
    value, _ = await start(owner, info)
    task = owner.invocations.jobs[value.call_id]
    reservation.close()
    proof = await owner.retire_worker(info, "recovery")
    assert proof.state == "clean" and not task.done()
    await asyncio.wait_for(task, 10)
    assert (await owner.invocations.job_scope(reference(owner, value)))["outcome"] == "completed"


async def test_unconfirmed_cleanup_remains_retryable(owner, monkeypatch):
    info, _ = await worker(owner)
    value, _ = await start(owner, info)
    async def unconfirmed(*_args, **_kwargs):
        return False
    with monkeypatch.context() as failure:
        failure.setattr("amazme_backend.execution.invocations.reconcile", unconfirmed)
        pending = await owner.invocations.kill_job(reference(owner, value))
        assert pending.state == "cleanup_pending" and not pending.resource_clean
        assert (await owner.task_activity()).active
    retried = await owner.invocations.kill_job(reference(owner, value))
    assert retried.state == "cancelled" and retried.resource_clean
