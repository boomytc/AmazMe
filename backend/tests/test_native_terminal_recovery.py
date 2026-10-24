import asyncio
import json

import httpx
import pytest
from test_client import _serve, _stop
from test_native_recovery import kill_owned, poll


@pytest.mark.parametrize("kill_supervisor", [False, True])
async def test_real_native_terminal_survives_worker_death_but_does_not_relaunch_after_supervisor_death(tmp_path, kill_supervisor):
    process, url, profile = _serve(tmp_path)
    try:
        async with httpx.AsyncClient(base_url=url, headers={"Authorization": "Bearer " + (profile / "web.token").read_text()}, timeout=15) as client:
            ready = (await client.get("/api/v1/bootstrap")).json()
            client.headers.update({"x-amazme-build": ready["build_id"], "x-amazme-epoch": str(ready["host_epoch"])})
            created = await client.post("/api/v1/sessions", json={"title": "terminal recovery"})
            created.raise_for_status()
            session = created.json()["session_id"]
            endpoint = f"/api/v1/sessions/{session}"
            attached = await client.post(endpoint + "/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            # Make a real session worker ready, then keep a separate terminal alive.
            (await client.get(endpoint + "/snapshot")).raise_for_status()
            request = {"terminal_id": "e" * 32, "command": "printf x >> terminal-start; sleep 60", "workspace": "primary"}
            opened = await client.post(endpoint + "/terminals", json=request)
            assert opened.status_code == 200, opened.text
            terminal = endpoint + "/terminals/" + request["terminal_id"]
            for _ in range(50):
                if (tmp_path / "workspace/terminal-start").exists():
                    break
                await asyncio.sleep(.05)
            assert (tmp_path / "workspace/terminal-start").read_text() == "x"
            health = (await client.get("/api/v1/health")).json()
            worker = next(w for w in health["supervisor"]["workers"] if w["session_id"] == session and w["state"] == "ready")
            kill_owned(worker, profile)
            if kill_supervisor:
                kill_owned(next(s for s in health["supervisors"] if s["state"] == "running"), profile)

            async def recover():
                return await client.get(endpoint + "/snapshot")

            await poll(recover, lambda r: r.status_code == 200)

            async def read():
                return await client.post(terminal + "/read", json={})

            expected = "unknown" if kill_supervisor else "running"
            response = await poll(read, lambda r: r.status_code == 200 and r.json()["phase"] == expected)
            if kill_supervisor:
                assert response.json()["clean"]
            retry = await client.post(endpoint + "/terminals", json=request)
            assert retry.json()["phase"] == expected, retry.text
            assert (tmp_path / "workspace/terminal-start").read_text() == "x"
            closed = await client.post(terminal + "/close", json={})
            assert closed.status_code == 200 and closed.json()["clean"], closed.text
            assert not (profile / "vm.json").exists()
    finally:
        _stop(process, profile)
    reports = list((profile / "executions").glob("*/result.json"))
    assert reports and all(json.loads(p.read_text())["stopped"] for p in reports)
