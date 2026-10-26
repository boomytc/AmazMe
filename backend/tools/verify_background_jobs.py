"""Opt-in real 126-second command; foreground receipt, reconnect, output and final exit."""
import asyncio
import json
import re
import shlex
import sys
import tempfile
import time
from pathlib import Path

from resource_budget import ResourceBudget
from resource_census import release_named_slot
from verify_runtime import ROOT, Runtime

from amazme_backend.contracts.execution import JobView
from amazme_backend.sdk import Client


async def drive(url: str, token: str) -> dict[str, object]:
    async with Client(url, token) as client:
        session = await client.create_session(workspace="primary", title="real >120 seconds")
        attachment = await client.attach(session.session_id)
        code = "import time\nstart=time.monotonic()\nprint('开始 中文',flush=True)\nfor i in range(126):\n time.sleep(1)\n print(f'tick:{i+1} elapsed:{time.monotonic()-start:.3f}',flush=True)"
        arguments = {"command":shlex.join([sys.executable, "-c", code]), "run_in_background":True, "timeout_seconds":180}
        started = time.monotonic()
        response = await client.rpc("request.submit", session_id=session.session_id, workspace="primary",
            attachment_id=attachment.attachment_id, request_id="long-command", text="real 126-second job",
            approval_policy="auto", tool_call={"id":"long", "name":"shell", "arguments":json.dumps(arguments)})
        assert not response.get("error"), response
        receipt = await client.wait(session_id=session.session_id, request_id="long-command")
        assert receipt.status == "succeeded", receipt
        envelope = json.loads(receipt.answer)
        assert envelope["exit_code"] == 0, envelope
        job = JobView.model_validate_json(envelope["stdout"])
        acknowledgement_seconds = time.monotonic() - started
        assert acknowledgement_seconds < 10 and job.outcome == "pending"
        print(json.dumps({"event":"acknowledged", "seconds":acknowledgement_seconds, "job_id":job.job_id}), flush=True)
        await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
    while time.monotonic() - started < 121:
        await asyncio.sleep(min(1, 121 - (time.monotonic() - started)))
    async with Client(url, token) as client:
        await client.attach(session.session_id)
        deadline = time.monotonic() + 10
        while True:
            running = await client.job_output(session.session_id, job.job_id)
            assert running.job.state == "running", running
            times = re.findall(r"elapsed:(\d+\.\d+)", running.output.content if running.output else "")
            command_elapsed = max(map(float, times), default=0)
            if command_elapsed > 120:
                break
            assert time.monotonic() < deadline, running
            await asyncio.sleep(.5)
        elapsed = time.monotonic() - started
        assert elapsed > 120 and running.output and "开始 中文" in running.output.content
        print(json.dumps({"event":"past_120_seconds", "seconds":elapsed, "state":running.job.state,
                          "retained_bytes":running.output.archive.stdout.retained_bytes}), flush=True)
        deadline = time.monotonic() + 30
        while True:
            page = await client.job_output(session.session_id, job.job_id)
            if page.job.resource_clean:
                break
            assert time.monotonic() < deadline, page
            await asyncio.sleep(.5)
        assert page.job.state == "succeeded" and page.job.exit_code == 0 and page.output and "tick:126" in page.output.content
        assert (await client.job_output(session.session_id, job.job_id)).output == page.output
        return {"status":"passed", "execution":"real native shell, faux completion model; no paid provider",
                "acknowledgement_seconds":acknowledgement_seconds, "observed_running_seconds":elapsed,
                "command_elapsed_seconds":command_elapsed,
                "completed_seconds":time.monotonic()-started, "job":page.job.model_dump(mode="json")}


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "jobs-", 2)
    root = Path(tempfile.mkdtemp(prefix="jobs-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider)
    report: dict[str, object] = {"status":"failed"}
    try:
        with ResourceBudget([root], limit_bytes=128*1024**2, deadline_seconds=200):
            runtime.start()
            report = asyncio.run(drive(str(runtime.ready["url"]), (runtime.profile/"web.token").read_text().strip()))
    finally:
        runtime.close()
        report["resources"] = runtime.resource_report
        (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
        print(json.dumps({"report":str(root/"report.json"), **report}, ensure_ascii=False), flush=True)
    assert report["resources"]["owned_reclaimed"], report


if __name__ == "__main__":
    main()
