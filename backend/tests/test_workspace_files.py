"""Workspace browse and checked writes stay inside the granted directory."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from amazme_backend.contracts import BackendError, HostFence, PrepareUpdate, ProcessLease
from amazme_backend.contracts.workspaces import FileWrite
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile
from amazme_backend.workspaces.files import list_files, read_file, write_file


def test_browse_read_and_checked_write(tmp_path: Path) -> None:
    root = tmp_path / "work"
    root.mkdir()
    (root / "note.txt").write_text("alpha\n")
    (root / "nested").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    (root / "escape").symlink_to(outside / "secret.txt")
    (root / "alias").symlink_to(root / "note.txt")
    listed = list_files(root)
    assert {item.name for item in listed.entries} >= {"note.txt", "escape", "alias", "nested"}
    assert read_file(root, "note.txt").content == "alpha\n"
    assert read_file(root, "alias").content == "alpha\n"
    with pytest.raises(BackendError, match="workspace_path_escape"):
        read_file(root, "escape")
    with pytest.raises(BackendError, match="invalid_workspace_path"):
        read_file(root, "../secret.txt")
    opened = read_file(root, "note.txt")
    changed = write_file(root, FileWrite(path="note.txt", content="beta\n", expected_digest=opened.digest))
    assert "alpha" in changed.diff and "beta" in changed.diff
    assert (root / "note.txt").read_text() == "beta\n"
    (root / "sub").mkdir()
    (root / "sub" / "inner.txt").write_text("in\n")
    (root / "linkdir").symlink_to(root / "sub", target_is_directory=True)
    with pytest.raises(BackendError, match="workspace_not_directory"):
        list_files(root, "linkdir")
    with pytest.raises(BackendError, match="workspace_not_directory"):
        read_file(root, "linkdir/inner.txt")
    assert read_file(root, "sub/inner.txt").content == "in\n"
    (root / "bin.dat").write_bytes(b"\xff")
    with pytest.raises(BackendError, match="file_not_text"):
        read_file(root, "bin.dat")
    for index in range(201):
        (root / f"n{index:03d}.txt").write_text("x")
    page = list_files(root)
    assert page.truncated and len(page.entries) == 200
    following = list_files(root, offset=200)
    assert following.offset == 200 and following.limit == 200 and not following.truncated
    assert page.total == following.total == len(list(root.iterdir()))
    names = [entry.name for entry in [*page.entries, *following.entries]]
    assert len(names) == len(set(names)) == page.total and set(names) == {item.name for item in root.iterdir()}
    assert list_files(root, offset=following.total).entries == []
    with pytest.raises(BackendError, match="invalid_workspace_page"):
        list_files(root, offset=-1)
    with pytest.raises(BackendError, match="workspace_missing"):
        list_files(root, "gone")
    with pytest.raises(BackendError, match="workspace_missing"):
        read_file(root, "gone.txt")


@pytest.mark.parametrize("existed", [False, True])
def test_staging_failure_does_not_damage_original(tmp_path, monkeypatch, existed):
    import errno
    target = tmp_path / "note.txt"
    if existed:
        target.write_text("original")
    expected = hashlib.sha256(b"original").hexdigest() if existed else ""
    real_write = os.write
    def disk_full(fd, data):
        real_write(fd, b"half")
        raise OSError(errno.ENOSPC, "full")
    monkeypatch.setattr(os, "write", disk_full)
    with pytest.raises(BackendError, match="workspace_no_space"):
        write_file(tmp_path, FileWrite(path="note.txt", content="new content", expected_digest=expected))
    assert target.read_text() == "original" if existed else not target.exists()
    assert not list(tmp_path.glob(".amazme-write-*"))


def test_atomic_create_refuses_a_racing_creator_and_preserves_file_metadata(tmp_path, monkeypatch):
    target = tmp_path / "note"
    real_link = os.link
    def create_first(*args, **kwargs):
        target.write_text("racing creator")
        return real_link(*args, **kwargs)
    with monkeypatch.context() as race:
        race.setattr(os, "link", create_first)
        with pytest.raises(BackendError, match="file_conflict"):
            write_file(tmp_path, FileWrite(path="note", content="new"))
    assert target.read_text() == "racing creator"
    target.chmod(0o640)
    attribute = "com.amazme.test" if sys.platform == "darwin" else "user.amazme"
    if sys.platform == "darwin":
        subprocess.run(["/usr/bin/xattr", "-w", attribute, "metadata", str(target)], check=True)
    else:
        os.setxattr(target, attribute, b"metadata")
    before = target.stat()
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    write_file(tmp_path, FileWrite(path="note", content="changed", expected_digest=digest))
    after = target.stat()
    assert (after.st_mode, after.st_uid, after.st_gid) == (before.st_mode, before.st_uid, before.st_gid)
    if sys.platform == "darwin":
        assert subprocess.check_output(["/usr/bin/xattr", "-p", attribute, str(target)]).strip() == b"metadata"
    else:
        assert os.getxattr(target, attribute) == b"metadata"


def test_hardlink_and_stale_digest_do_not_write(tmp_path: Path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("alpha\n")
    os.link(target, tmp_path / "linked.txt")
    digest = hashlib.sha256(b"alpha\n").hexdigest()
    with pytest.raises(BackendError, match="workspace_hardlink_write"):
        write_file(tmp_path, FileWrite(path="note.txt", content="beta\n", expected_digest=digest))
    assert target.read_text() == "alpha\n"
    (tmp_path / "linked.txt").unlink()
    with pytest.raises(BackendError, match="file_conflict"):
        write_file(tmp_path, FileWrite(path="note.txt", content="beta\n", expected_digest="0" * 64))
    assert target.read_text() == "alpha\n"
    created = write_file(tmp_path, FileWrite(path="fresh.txt", content="new\n", expected_digest=""))
    assert (tmp_path / "fresh.txt").read_text() == "new\n"
    assert created.digest == hashlib.sha256(b"new\n").hexdigest()
    (tmp_path / "sub").mkdir()
    (tmp_path / "via").symlink_to(tmp_path / "sub")
    with pytest.raises(BackendError, match="workspace_symlink_write"):
        write_file(tmp_path, FileWrite(path="via/child.txt", content="x", expected_digest=""))
    locked = tmp_path / "locked.txt"
    locked.write_text("alpha\n")
    locked.chmod(0)
    try:
        with pytest.raises(BackendError, match="workspace_permission"):
            write_file(tmp_path, FileWrite(path="locked.txt", content="beta\n", expected_digest=digest))
        locked.chmod(0o644)
        assert locked.read_text() == "alpha\n"
    finally:
        locked.chmod(0o644)
    (tmp_path / "dir").mkdir()
    with pytest.raises(BackendError, match="workspace_not_file"):
        write_file(tmp_path, FileWrite(path="dir", content="x", expected_digest=""))
    huge = "你" * 400_000
    with pytest.raises(BackendError, match="file_too_large"):
        write_file(tmp_path, FileWrite(path="note.txt", content=huge, expected_digest=digest))
    assert target.read_text() == "alpha\n"


@pytest.fixture
async def owner(tmp_path: Path):
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "files", "workspace": str(tmp_path / "work"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "note.txt").write_text("alpha\n")
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    value = Host(Profile(tmp_path))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    value.lifecycle.fence = HostFence(host_epoch=1, build_id=value.lifecycle.build)
    value.lifecycle.fence.host_epoch = await value.lifecycle.store.initialize(value.lifecycle.instance, value.lifecycle.build, lease)
    value.origin = "http://127.0.0.1:12345"
    try:
        yield value
    finally:
        await value.lifecycle.supervisor.close()
        await value.lifecycle.store.db.close()


async def test_file_route_reads_and_writes_the_granted_workspace(owner: Host) -> None:
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only"}) as client:
        listed = await client.get("/api/v1/files")
        assert listed.status_code == 200
        assert any(item["name"] == "note.txt" for item in listed.json()["entries"])
        for index in range(205):
            (Path(owner.lifecycle.profile.config.workspace) / f"z{index:03}.txt").touch()
        second = await client.get("/api/v1/files", params={"offset": 200})
        assert second.status_code == 200
        assert second.json()["offset"] == second.json()["limit"] == 200 and second.json()["total"] == 206
        assert [row["name"] for row in second.json()["entries"]] == [f"z{index:03}.txt" for index in range(199, 205)]
        assert (await client.get("/api/v1/files", params={"offset": -1})).status_code == 422
        content = await client.get("/api/v1/files/content", params={"path": "note.txt"})
        assert content.json()["content"] == "alpha\n"
        client.headers.update({"x-amazme-build": owner.lifecycle.build, "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)})
        saved = await client.post("/api/v1/files/content", json={
            "path": "note.txt", "content": "beta\n", "expected_digest": content.json()["digest"]})
        assert saved.status_code == 200 and "beta" in saved.json()["diff"]
        await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="freeze-files", target_build="ab" * 32), owner.lifecycle.build)
        blocked = await client.post("/api/v1/files/content", json={
            "path": "note.txt", "content": "gamma\n", "expected_digest": saved.json()["digest"]})
        assert blocked.status_code == 503 and blocked.json()["code"] == "update_frozen"
    assert (Path(owner.lifecycle.profile.config.workspace) / "note.txt").read_text() == "beta\n"
