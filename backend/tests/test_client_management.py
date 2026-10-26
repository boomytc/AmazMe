"""Original sidebar operations use real storage and keep their ownership on retries."""

import asyncio
from pathlib import Path

import pytest
from test_management import _client, _host, _message

from amazme_backend.common import lock
from amazme_backend.contracts import ProcessLease
from amazme_backend.storage import session_database


async def test_project_and_session_edits_reject_stale_writes_and_remove_only_owned_history(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, ProcessLease(
        instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1))
    project_id, session_id = "1" * 32, "2" * 32
    kept = tmp_path / "primary" / "kept.txt"
    kept.write_text("用户工作目录")
    try:
        async with _client(host) as client:
            project = await client.post("/api/v1/projects", json={"project_id": project_id, "name": "项目"})
            assert project.status_code == 200
            edited = await client.put(f"/api/v1/projects/{project_id}", json={
                "name": "新项目", "workspaces": ["primary"], "expected_revision": 0})
            assert edited.json()["revision"] == 1
            stale = await client.put(f"/api/v1/projects/{project_id}", json={
                "name": "迟到", "workspaces": ["primary"], "expected_revision": 0})
            assert stale.status_code == 409 and stale.json()["code"] == "project_conflict"
            created = await client.post("/api/v1/sessions", json={
                "session_id": session_id, "title": "原名", "project_id": project_id})
            assert created.status_code == 201
            attachment = (await client.post(f"/api/v1/sessions/{session_id}/attachments")).json()
            client.headers["x-amazme-attachment"] = attachment["attachment_id"]
            renamed = await client.put(f"/api/v1/sessions/{session_id}/title", json={"title": "新名", "expected_title": "原名"})
            assert renamed.status_code == 200 and renamed.json()["session_id"] == session_id
            created_retry = await client.post("/api/v1/sessions", json={
                "session_id": session_id, "title": "原名", "project_id": project_id})
            assert created_retry.status_code == 201 and created_retry.json()["title"] == "新名"
            late = await client.put(f"/api/v1/sessions/{session_id}/title", json={"title": "迟到", "expected_title": "原名"})
            assert late.status_code == 409
            await _message(host, session_id, "hello", "待保留的历史")
            removed_project = await client.put(f"/api/v1/projects/{project_id}", json={
                "name": "新项目", "workspaces": ["primary"], "removed": True, "expected_revision": 1})
            assert removed_project.status_code == 200 and removed_project.json()["removed"] is True
            sessions = (await client.get("/api/v1/sessions")).json()["sessions"]
            assert len(sessions) == 1 and sessions[0]["archived"] is True and sessions[0]["title"] == "新名"
            directory = session_database(tmp_path, session_id).parent
            assert directory.is_dir() and kept.read_text() == "用户工作目录"
            with lock(directory / "writer.lock"):
                pass
            (directory / "worker.log").write_text("owned worker diagnostics")
            unknown = directory / "user-note.txt"
            unknown.write_text("unknown ownership")
            refused = await client.delete(f"/api/v1/sessions/{session_id}")
            assert refused.status_code == 409 and refused.json()["code"] == "branch_cleanup_refused"
            assert unknown.read_text() == "unknown ownership" and session_database(tmp_path, session_id).exists()
            unknown.unlink()  # This test owns only this marker.
            removed = await client.delete(f"/api/v1/sessions/{session_id}")
            assert removed.status_code == 200 and removed.json()["removed"] is True
            assert not directory.exists() and kept.read_text() == "用户工作目录"
            assert (await client.delete(f"/api/v1/sessions/{session_id}")).json()["removed"] is True
            replayed_create = await client.post("/api/v1/sessions", json={"session_id": session_id, "title": "原名"})
            assert replayed_create.status_code == 409 and replayed_create.json()["code"] == "session_removed"
            assert (await client.get("/api/v1/sessions")).json()["sessions"] == []
    finally:
        await host.supervisor.close()
        await host.store.db.close()


async def test_removal_refuses_a_session_directory_symlink(tmp_path: Path) -> None:
    from amazme_backend.contracts import BackendError
    from amazme_backend.storage import remove_session_directory

    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "session.sqlite"
    marker.write_text("unowned")
    link = tmp_path / "linked"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(BackendError, match="branch_cleanup_refused"):
        remove_session_directory(link)
    assert marker.read_text() == "unowned"


async def test_restore_waits_for_archive_cleanup_before_reopening_the_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from amazme_backend.contracts import CreateSession

    host = _host(tmp_path)
    await host.store.initialize(host.instance, host.build, ProcessLease(
        instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1))
    session = "3" * 32
    await host.store.create_session(session, CreateSession())
    entered, finish = asyncio.Event(), asyncio.Event()

    async def cleanup(_session: str) -> None:
        if not entered.is_set():
            entered.set()
            await finish.wait()

    monkeypatch.setattr(host, "_retire_session_resources", cleanup)
    archiving = asyncio.create_task(host.archive_session(session, True))
    await entered.wait()
    restoring = asyncio.create_task(host.archive_session(session, False))
    try:
        await asyncio.sleep(.01)
        assert not restoring.done()
        assert (await host.sessions()).sessions[0].archived is True
        finish.set()
        await archiving
        assert (await restoring).archived is False
        assert (await host.sessions()).sessions[0].archived is False
    finally:
        finish.set()
        await asyncio.gather(archiving, restoring, return_exceptions=True)
        await host.supervisor.close()
        await host.store.db.close()
