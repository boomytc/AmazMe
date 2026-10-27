"""Update validation must not restart a session whose business retry budget is exhausted."""

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from test_client import _ready, _serve, _stop


@pytest.mark.parametrize("keep_session", [False, True])
async def test_update_skips_deleted_session_but_keeps_worker_retirement_proof(tmp_path: Path, keep_session: bool):
    process, url, profile = _serve(tmp_path)
    try:
        headers = {"Authorization": "Bearer " + (profile / "web.token").read_text().strip()}
        control = {"Authorization": "Bearer " + (profile / "control.token").read_text().strip()}
        async with httpx.AsyncClient(base_url=url, headers=headers, timeout=45) as client:
            bootstrap = (await client.get("/api/v1/bootstrap")).json()
            client.headers.update({"x-amazme-build": bootstrap["build_id"],
                                   "x-amazme-epoch": str(bootstrap["host_epoch"])})
            created = await client.post("/api/v1/sessions", json={"title": "empty", "reuse_empty": True})
            created.raise_for_status()
            session = created.json()["session_id"]
            snapshot = await client.get(f"/api/v1/sessions/{session}/snapshot")
            assert snapshot.status_code == 200, snapshot.text
            removed = await client.delete(f"/api/v1/sessions/{session}")
            assert removed.status_code == 200, removed.text
            assert not (profile / "sessions" / session).exists()
            if keep_session:
                created = await client.post("/api/v1/sessions", json={"title": "kept"})
                created.raise_for_status()
            response = await client.post("/control/updates/prepare", headers=control,
                json={"update_id": "upgrade", "target_build": bootstrap["build_id"], "cancel_work": False})
            assert response.status_code == 200, response.text
            assert any(w["session_id"] == session and w["state"] == "stopped" for w in response.json()["roster"])
            response = await client.post("/control/updates/upgrade/resume", headers=control)
            assert response.status_code == 200, response.text
            response = await client.post("/control/updates/complete", headers=control,
                json={"update_id": "upgrade", "expected_revision": response.json()["revision"]})
            assert response.status_code == 200, response.text
            assert response.json()["activated"]
            assert not (profile / "sessions" / session).exists()
            health = (await client.get("/api/v1/health")).json()
            assert health["state"] == "ready" and health["update"] is None
    finally:
        _stop(process, profile)


async def test_restart_supersedes_interrupted_local_replacement(tmp_path: Path):
    process, url, profile = _serve(tmp_path)
    try:
        headers = {"Authorization": "Bearer " + (profile / "web.token").read_text().strip()}
        control = {"Authorization": "Bearer " + (profile / "control.token").read_text().strip()}
        async with httpx.AsyncClient(base_url=url, headers=headers, timeout=45) as client:
            bootstrap = (await client.get("/api/v1/bootstrap")).json()
            client.headers.update({"x-amazme-build": bootstrap["build_id"],
                                   "x-amazme-epoch": str(bootstrap["host_epoch"])})
            update_id = "replace-" + bootstrap["instance_id"]
            response = await client.post("/control/updates/prepare", headers=control,
                json={"update_id": update_id, "target_build": bootstrap["build_id"], "cancel_work": False})
            assert response.status_code == 200, response.text
        _stop(process, profile)
        # Model an older, interrupted source replacement without changing the running code.
        with sqlite3.connect(profile / "host.sqlite") as db:
            record = json.loads(db.execute("SELECT payload FROM updates WHERE id=?", (update_id,)).fetchone()[0])
            record.update(source_build="b" * 64, target_build="c" * 64, phase="freezing")
            db.execute("UPDATE updates SET payload=? WHERE id=?", (json.dumps(record), update_id))
            db.execute("UPDATE hosts SET build=? WHERE instance=?", ("c" * 64, bootstrap["instance_id"]))
        process = subprocess.Popen([sys.executable, "-m", "amazme_backend", "serve", "--profile", str(profile),
                                    "--port", "0"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        ready = _ready(process, time.monotonic() + 30)
        assert "url" in ready
        async with httpx.AsyncClient(base_url=str(ready["url"]), headers=headers, timeout=45) as client:
            response = await client.post(f"/control/updates/{update_id}/resume", headers=control)
            assert response.status_code == 200, response.text
            assert response.json()["target_build"] == ready["build_id"]
            response = await client.post("/control/updates/complete", headers=control,
                json={"update_id": update_id, "expected_revision": response.json()["revision"]})
            assert response.status_code == 200, response.text
            assert response.json()["activated"]
            assert (await client.get("/api/v1/health")).json()["state"] == "ready"
    finally:
        _stop(process, profile)


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
