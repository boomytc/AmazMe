"""Public background jobs use real native processes, durable delivery and client bindings."""
import asyncio
import json
import signal
import subprocess
import sys
import time

import pytest
from test_client import _cli, _ready, _serve, _stop
from test_native_recovery import kill_owned, poll

from amazme_backend.contracts.execution import JobView
from amazme_backend.interfaces.tui import _handle, _PtyPending
from amazme_backend.sdk import Client
from amazme_backend.shared.errors import BackendError


async def tool(client, session, attachment, identity, name, arguments):
    result = await client.rpc("request.submit", session_id=session, workspace="primary", attachment_id=attachment,
        request_id=identity, text=identity, approval_policy="auto",
        tool_call={"id": identity, "name": name, "arguments": json.dumps(arguments)})
    assert not result.get("error"), result
    receipt = await client.wait(session_id=session, request_id=identity, attempts=300)
    assert receipt.status == "succeeded", receipt
    return json.loads(receipt.answer)


async def start(client, session, attachment, identity="start", command="printf 开始; sleep 6; printf 完成"):
    result = await tool(client, session, attachment, identity, "shell", {
        "command": command, "run_in_background": True, "timeout_seconds": 60})
    assert result["exit_code"] == 0, result
    return JobView.model_validate_json(result["stdout"])


async def test_reconnect_completion_nonzero_and_cli_tui_queries_share_one_job(tmp_path):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            session = await client.create_session(workspace="primary", title="jobs")
            attachment = await client.attach(session.session_id)
            command = "printf x >> once; printf 开始; sleep 4; printf 完成; printf 错误 >&2; exit 7"
            job = await start(client, session.session_id, attachment.attachment_id, command=command)
            assert job.outcome == "pending" and not job.resource_clean
            duplicate = await start(client, session.session_id, attachment.attachment_id, command=command)
            assert duplicate.job_id == job.job_id
            initial = await poll(lambda: client.job_output(session.session_id, job.job_id),
                                 lambda page: page.output and page.output.content == "开始")
            assert initial.job.state == "running"
            await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
        async with Client(url, token) as client:
            attachment = await client.attach(session.session_id)
            listing = await client.list_jobs(session.session_id)
            assert [item.job_id for item in listing.jobs] == [job.job_id]
            final = await poll(lambda: client.job_output(session.session_id, job.job_id),
                               lambda page: page.job.resource_clean)
            assert final.job.state == "failed" and final.job.exit_code == 7
            assert final.output.content == "开始完成"
            assert (await client.job_output(session.session_id, job.job_id, stream="stderr")).output.content == "错误"
            await poll(lambda: client.snapshot(session.session_id),
                       lambda snap: any(r.input_origin == "job" and r.status == "succeeded" for r in snap.requests))
            snapshot = await client.snapshot(session.session_id)
            notices = [r for r in snapshot.requests if r.input_origin == "job"]
            assert len(notices) == 1 and job.job_id in notices[0].text
            assert (await client.job_output(session.session_id, job.job_id)).output == final.output
            assert (tmp_path / "workspace/once").read_text() == "x"
            cli = _cli(url, token, "rpc", "--method", "job.list", "--params", json.dumps({
                "session_id":session.session_id, "workspace":"primary", "attachment_id":attachment.attachment_id}))
            assert cli.returncode == 0 and job.job_id in cli.stdout, cli.stderr
            lines = []
            await _handle(client, session, attachment, "primary", "/jobs", lines, None, "", "", _PtyPending())
            await _handle(client, session, attachment, "primary", f"/job-output {job.job_id} stderr 0",
                          lines, None, "", "", _PtyPending())
            assert any(job.job_id in line for line in lines) and "错误" in lines
    finally:
        _stop(process, profile)


async def test_user_input_ends_wait_without_killing_then_explicit_kill_is_idempotent(tmp_path):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            session = await client.create_session(workspace="primary", title="waiting")
            attachment = await client.attach(session.session_id)
            job = await start(client, session.session_id, attachment.attachment_id, command="printf 开始; sleep 40; printf 完成")
            waiter = asyncio.create_task(tool(client, session.session_id, attachment.attachment_id, "wait-output",
                                              "job_output", {"job_id":job.job_id, "wait_seconds":30}))
            await poll(lambda: client.snapshot(session.session_id), lambda snap: any(
                event.request_id == "wait-output" and '"phase":"intent"' in event.text for event in snap.events))
            before = time.monotonic()
            await client.submit(session_id=session.session_id, workspace="primary", attachment_id=attachment.attachment_id,
                                request_id="interrupt", text="user interrupt")
            result = await asyncio.wait_for(waiter, 5)
            assert time.monotonic() - before < 5
            assert json.loads(result["stdout"])["wait_reason"] == "user_input"
            assert (await client.list_jobs(session.session_id)).jobs[0].outcome == "pending"
            for suffix in ("output", "kill"):
                with pytest.raises(BackendError, match="invalid_request"):
                    await client._send("GET" if suffix == "output" else "POST",
                        f"/api/v1/sessions/{session.session_id}/jobs/!/{suffix}",
                        headers=client._write(attachment.attachment_id))
            await client.wait(session_id=session.session_id, request_id="interrupt")
            submitted = await client.rpc("request.submit", session_id=session.session_id, workspace="primary",
                attachment_id=attachment.attachment_id, request_id="cancel-wait", text="cancel-wait", approval_policy="auto",
                tool_call={"id":"wait", "name":"job_output", "arguments":json.dumps({"job_id":job.job_id, "wait_seconds":30})})
            assert not submitted.get("error"), submitted
            await poll(lambda: client.snapshot(session.session_id), lambda snap: any(
                event.request_id == "cancel-wait" and '"phase":"intent"' in event.text for event in snap.events))
            await client.cancel(session_id=session.session_id, workspace="primary", attachment_id=attachment.attachment_id,
                                request_id="cancel-wait")
            cancelled = await asyncio.wait_for(client.wait(session_id=session.session_id, request_id="cancel-wait"), 5)
            assert cancelled.status == "cancelled"
            assert (await client.list_jobs(session.session_id)).jobs[0].outcome == "pending"
            other = await client.create_session(workspace="primary", title="other")
            other_attachment = await client.attach(other.session_id)
            with pytest.raises(BackendError, match="job_scope_mismatch"):
                await client.job_output(other.session_id, job.job_id)
            with pytest.raises(BackendError, match="job_scope_mismatch"):
                await client.kill_job(session_id=other.session_id, attachment_id=other_attachment.attachment_id, job_id=job.job_id)
            killed = await client.kill_job(session_id=session.session_id, attachment_id=attachment.attachment_id, job_id=job.job_id)
            assert killed.resource_clean and killed.state == "cancelled"
            assert await client.kill_job(session_id=session.session_id, attachment_id=attachment.attachment_id, job_id=job.job_id) == killed
            assert not (await client.list_jobs(session.session_id)).jobs[0].outcome == "pending"
            capacity = [await start(client, session.session_id, attachment.attachment_id, identity=f"capacity-{i}",
                                    command="printf start; sleep 40") for i in range(4)]
            refused = await tool(client, session.session_id, attachment.attachment_id, "over-capacity", "shell",
                                 {"command":"printf bad > refused", "run_in_background":True})
            assert refused["exit_code"] == 1 and refused["stderr"] == "background_capacity"
            assert not (tmp_path / "workspace/refused").exists()
            for active in capacity:
                assert (await client.kill_job(session_id=session.session_id, attachment_id=attachment.attachment_id,
                                               job_id=active.job_id)).resource_clean
    finally:
        _stop(process, profile)


async def test_worker_death_preserves_background_then_archiving_stops_it(tmp_path):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            session = await client.create_session(workspace="primary", title="worker")
            attachment = await client.attach(session.session_id)
            job = await start(client, session.session_id, attachment.attachment_id, command="printf start; sleep 40; printf bad > late")
            health = await client._send("GET", "/api/v1/health")
            worker = next(w for w in health["supervisor"]["workers"] if w["session_id"] == session.session_id and w["state"] == "ready")
            kill_owned(worker, profile)
            await asyncio.sleep(1.5)
            assert (await client.job_output(session.session_id, job.job_id)).job.state == "running"
            await client._send("POST", f"/api/v1/sessions/{session.session_id}/archive",
                               json_body={"archived":True}, headers=client._write(attachment.attachment_id))
            stopped = (await client.list_jobs(session.session_id)).jobs[0]
            assert stopped.resource_clean and stopped.state in {"cancelled", "unknown"}
            assert not (tmp_path / "workspace/late").exists()
    finally:
        _stop(process, profile)


@pytest.mark.parametrize("kill_supervisor", [False, True])
async def test_host_death_reconciles_closed_epoch_job_without_replay_and_keeps_logs(tmp_path, kill_supervisor):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            session = await client.create_session(workspace="primary", title="host")
            attachment = await client.attach(session.session_id)
            job = await start(client, session.session_id, attachment.attachment_id,
                              command="printf x >> once; printf retained; sleep 40; printf bad >> once")
            await poll(lambda: client.job_output(session.session_id, job.job_id), lambda page: page.output and page.output.content == "retained")
            health = await client._send("GET", "/api/v1/health")
            supervisor = next(item for item in health["supervisors"] if item["state"] == "running")
        process.send_signal(signal.SIGKILL)
        process.wait(timeout=10)
        process.stdout.close()
        if kill_supervisor:
            kill_owned(supervisor, profile)
        with (tmp_path / "restart.err").open("wb") as log:
            process = subprocess.Popen([sys.executable, "-m", "amazme_backend", "serve", "--profile", str(profile), "--port", "0"],
                                       stdout=subprocess.PIPE, stderr=log)
        ready = _ready(process, time.monotonic()+40)
        assert "url" in ready, (tmp_path / "restart.err").read_text()[-3000:]
        async with Client(str(ready["url"]), token) as client:
            attachment = await client.attach(session.session_id)
            if kill_supervisor:
                page = await poll(lambda: client.job_output(session.session_id, job.job_id), lambda value: value.job.resource_clean)
                assert page.job.state == "unknown" and page.job.outcome == "unknown"
            else:
                page = await client.job_output(session.session_id, job.job_id)
                assert page.job.state == "running" and page.job.outcome == "pending"
                killed = await client.kill_job(session_id=session.session_id, attachment_id=attachment.attachment_id, job_id=job.job_id)
                assert killed.resource_clean
            assert page.output.content == "retained" and (tmp_path / "workspace/once").read_text() == "x"
            await asyncio.sleep(.4)
            assert len((await client.list_jobs(session.session_id)).jobs) == 1
    finally:
        _stop(process, profile)
