"""A file checkpoint previews without writing and restores only that path."""

import json
from pathlib import Path

import httpx

from amazme_backend.contracts import HostFence, ProcessLease
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "checks", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def test_checkpoint_preview_does_not_write_and_restore_is_selective(tmp_path: Path) -> None:
    host = _host(tmp_path)
    root = tmp_path / "primary"
    (root / "note.txt").write_text("alpha\n")
    (root / "other.txt").write_text("leave\n")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
            "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
        }) as client:
            current = await client.get("/api/v1/files/content", params={"path": "note.txt"})
            saved = await client.post("/api/v1/checkpoints", json={
                "checkpoint_id": "a" * 32, "workspace": "primary", "path": "note.txt"})
            assert saved.status_code == 200 and saved.json()["digest"] == current.json()["digest"]
            changed = await client.post("/api/v1/files/content", json={
                "path": "note.txt", "content": "beta\n", "expected_digest": current.json()["digest"]})
            assert changed.status_code == 200
            assert (root / "note.txt").read_text() == "beta\n"
            preview = await client.get("/api/v1/checkpoints/" + "a" * 32)
            assert preview.status_code == 200
            assert preview.json()["content"] == "alpha\n"
            assert "beta" in preview.json()["diff"]
            assert (root / "note.txt").read_text() == "beta\n"
            conflict = await client.post("/api/v1/checkpoints", json={
                "checkpoint_id": "a" * 32, "workspace": "primary", "path": "note.txt"})
            assert conflict.status_code == 409 and conflict.json()["code"] == "checkpoint_conflict"
            stale = await client.post("/api/v1/checkpoints/" + "a" * 32 + "/restore", json={
                "expected_digest": current.json()["digest"]})
            assert stale.status_code == 409 and stale.json()["code"] == "file_conflict"
            assert (root / "note.txt").read_text() == "beta\n"
            beta = await client.get("/api/v1/files/content", params={"path": "note.txt"})
            restored = await client.post("/api/v1/checkpoints/" + "a" * 32 + "/restore", json={
                "expected_digest": beta.json()["digest"]})
            assert restored.status_code == 200
            assert (root / "note.txt").read_text() == "alpha\n"
            assert (root / "other.txt").read_text() == "leave\n"
            listed = await client.get("/api/v1/checkpoints", params={"workspace": "primary", "path": "note.txt"})
            assert any(item["digest"] == beta.json()["digest"] for item in listed.json()["checkpoints"])
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()
