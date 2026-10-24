"""Actual native worker/supervisor death never replays an accepted shell effect."""
import asyncio
import json
import signal
import time
from pathlib import Path

import httpx
import psutil
import pytest
from test_client import _serve, _stop

from amazme_backend.contracts import ProcessLease
from amazme_backend.processes import exited


async def poll(operation, predicate, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = await operation()
        if predicate(last):
            return last
        await asyncio.sleep(.1)
    raise AssertionError(str(last)[:2000])


def kill_owned(info, profile):
    process = psutil.Process(info["pid"])
    assert str(profile) in process.cmdline()
    lease = ProcessLease.model_validate(info["process_lease"])
    assert lease.profile_path == str(profile) and not exited(lease)
    process.send_signal(signal.SIGKILL)


@pytest.mark.parametrize("double_death", [False, True])
async def test_real_death_stops_known_native_command_and_does_not_replay(tmp_path: Path, double_death):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with httpx.AsyncClient(base_url=url, headers={"Authorization": "Bearer "+token}, timeout=10) as client:
            ready = (await client.get("/api/v1/bootstrap")).json()
            client.headers.update({"x-amazme-build": ready["build_id"], "x-amazme-epoch": str(ready["host_epoch"])})
            created = await client.post("/api/v1/sessions", json={"title": "native crash"})
            created.raise_for_status()
            session = created.json()["session_id"]
            attached = await client.post(f"/api/v1/sessions/{session}/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            endpoint = f"/api/v1/sessions/{session}"
            payload = {"request_id": "once", "text": "/shell printf x >> once.txt; sleep 20; printf bad >> once.txt"}
            accepted = await client.post(endpoint+"/submissions", json=payload)
            assert accepted.status_code == 202, accepted.text

            async def snapshot():
                return await client.get(endpoint+"/snapshot")

            response = await poll(snapshot, lambda r:r.status_code==200 and bool(r.json()["approvals"]))
            approval = response.json()["approvals"][0]
            response = await client.post(endpoint+"/approvals", json={"decision_id":"approve",
                "approval_id":approval["approval_id"], "expected_revision":approval["revision"],
                "proposal_digest":approval["proposal_digest"], "approve":True})
            assert response.status_code == 202, response.text
            marker = tmp_path / "workspace/once.txt"
            for _ in range(100):
                if marker.exists():
                    break
                await asyncio.sleep(.05)
            assert marker.read_text() == "x"
            health = (await client.get("/api/v1/health")).json()
            worker = next(w for w in health["supervisor"]["workers"] if w["session_id"]==session and w["state"]=="ready")
            kill_owned(worker, profile)
            if double_death:
                service = next(s for s in health["supervisors"] if s["state"]=="running")
                kill_owned(service, profile)

            async def receipt():
                return await client.get(endpoint+"/requests/once")

            response = await poll(receipt, lambda r:r.status_code==200 and r.json()["status"] in {"unknown","interrupted"}, timeout=40)
            assert response.json()["decision"]["status"] in {"unknown","interrupted"}
            retry = await client.post(endpoint+"/submissions", json=payload)
            assert retry.status_code==202, retry.text
            await asyncio.sleep(.3)
            assert marker.read_text() == "x"
            reports = list((profile / "executions").glob("*/result.json"))
            assert reports and all(json.loads(p.read_text())["stopped"] for p in reports)
            assert not (profile / "vm.json").exists()
    finally:
        _stop(process, profile)
