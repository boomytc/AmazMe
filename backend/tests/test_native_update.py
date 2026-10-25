"""Update validation must not restart a session whose business retry budget is exhausted."""

import sqlite3
from pathlib import Path

import httpx
from test_client import _serve, _stop


async def test_update_activates_without_resetting_exhausted_session_budget(tmp_path: Path):
    process, url, profile = _serve(tmp_path)
    try:
        headers = {"Authorization": "Bearer " + (profile / "web.token").read_text().strip()}
        control = {"Authorization": "Bearer " + (profile / "control.token").read_text().strip()}
        async with httpx.AsyncClient(base_url=url, headers=headers, timeout=30) as client:
            bootstrap = (await client.get("/api/v1/bootstrap")).json()
            client.headers.update({"x-amazme-build": bootstrap["build_id"],
                                   "x-amazme-epoch": str(bootstrap["host_epoch"])})
            created = await client.post("/api/v1/sessions", json={"title": "exhausted"})
            created.raise_for_status()
            session = created.json()["session_id"]
            with sqlite3.connect(profile / "execution.sqlite") as db:
                db.execute("INSERT INTO budgets(session,attempts) VALUES(?,4)", (session,))
            response = await client.post("/control/updates/prepare", headers=control,
                json={"update_id": "upgrade", "target_build": bootstrap["build_id"], "cancel_work": False})
            assert response.status_code == 200, response.text
            response = await client.post("/control/updates/upgrade/resume", headers=control)
            assert response.status_code == 200, response.text
            response = await client.post("/control/updates/complete", headers=control,
                json={"update_id": "upgrade", "expected_revision": response.json()["revision"]})
            assert response.status_code == 200, response.text
            assert response.json()["activated"]
            health = (await client.get("/api/v1/health")).json()
            assert health["state"] == "ready" and health["update"] is None
            assert health["supervisor"]["session_errors"][session] == ["worker_restart_budget_exhausted"]
            assert all(w["purpose"] == "validation" and w["state"] == "stopped"
                       for w in health["supervisor"]["workers"] if w["session_id"] == session)
            snapshot = await client.get(f"/api/v1/sessions/{session}/snapshot")
            assert snapshot.status_code == 503 and snapshot.json()["code"] == "worker_restart_budget_exhausted"
            with sqlite3.connect(profile / "execution.sqlite") as db:
                assert db.execute("SELECT attempts FROM budgets WHERE session=?", (session,)).fetchone()[0] == 4
            created = await client.post("/api/v1/sessions", json={"title": "healthy"})
            created.raise_for_status()
            snapshot = await client.get(f"/api/v1/sessions/{created.json()['session_id']}/snapshot")
            assert snapshot.status_code == 200, snapshot.text
    finally:
        _stop(process, profile)
