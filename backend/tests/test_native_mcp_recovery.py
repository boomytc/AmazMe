import asyncio
import shlex
import sys

import httpx
import pytest
from test_client import _serve, _stop
from test_native_mcp import SERVER
from test_native_recovery import kill_owned, poll


@pytest.mark.parametrize("kill_supervisor", [False, True])
async def test_real_mcp_ownership_across_worker_and_supervisor_death(tmp_path, kill_supervisor):
    process, url, profile = _serve(tmp_path)
    script = tmp_path / "workspace/mcp_service.py"
    script.write_text("open('mcp-starts','a').write('x')\n" + SERVER)
    try:
        async with httpx.AsyncClient(base_url=url, headers={"Authorization": "Bearer " + (profile / "web.token").read_text()}, timeout=15) as client:
            ready = (await client.get("/api/v1/bootstrap")).json()
            client.headers.update({"x-amazme-build": ready["build_id"], "x-amazme-epoch": str(ready["host_epoch"])})
            response = await client.post("/api/v1/sessions", json={"title": "MCP recovery"})
            response.raise_for_status()
            endpoint = f"/api/v1/sessions/{response.json()['session_id']}"
            attached = await client.post(endpoint + "/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            (await client.get(endpoint + "/snapshot")).raise_for_status()
            server = {"server_id": "a" * 32, "command": shlex.join([sys.executable, str(script), "calls.txt"]), "workspace": "primary"}
            response = await client.post(endpoint + "/mcp", json=server)
            assert response.status_code == 200, response.text
            base = endpoint + "/mcp/" + server["server_id"]
            call = {"call_id": "b" * 32, "name": "demo.slow", "arguments": {"seconds": 60}}
            response = await client.post(base + "/calls", json=call)
            response.raise_for_status()
            decision = {"decision_id": "approve", "approve": True, "digest": response.json()["digest"]}
            response = await client.post(base + "/calls/" + call["call_id"] + "/decision", json=decision)
            assert response.status_code == 200 and response.json()["phase"] == "running", response.text
            for _ in range(50):
                if (tmp_path / "workspace/calls.txt").exists():
                    break
                await asyncio.sleep(.05)
            assert (tmp_path / "workspace/calls.txt").read_text() == "x"
            health = (await client.get("/api/v1/health")).json()
            kill_owned(next(w for w in health["supervisor"]["workers"] if w["state"] == "ready"), profile)
            if kill_supervisor:
                kill_owned(next(s for s in health["supervisors"] if s["state"] == "running"), profile)
            await poll(lambda: client.get(endpoint + "/snapshot"), lambda r: r.status_code == 200)
            expected = "unknown" if kill_supervisor else "ready"
            response = await poll(lambda: client.get(endpoint + "/mcp"),
                lambda r: r.status_code == 200 and r.json()["servers"][0]["phase"] == expected)
            if kill_supervisor:
                assert response.json()["servers"][0]["clean"]
                assert response.json()["calls"][0]["phase"] == "unknown"
            else:
                assert response.json()["calls"][0]["phase"] == "running"
            retry = await client.post(endpoint + "/mcp", json=server)
            assert retry.json()["phase"] == expected
            assert (tmp_path / "workspace/mcp-starts").read_text() == "x"
            response = await client.post(base + "/cancel", json={})
            assert response.status_code == 200 and response.json()["clean"], response.text
            retry = await client.post(base + "/calls/" + call["call_id"] + "/decision", json=decision)
            assert retry.json()["phase"] == "unknown"
            assert (tmp_path / "workspace/calls.txt").read_text() == "x"
    finally:
        _stop(process, profile)
