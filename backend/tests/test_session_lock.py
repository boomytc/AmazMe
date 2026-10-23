"""One process owns a session library. Readers do not take that lock, and a second writer is refused."""

import json
import os
import select
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import cast

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, CreateSession, HostFence, ProcessLease, Submit, WebPolicy
from amazme_backend.host import Host
from amazme_backend.sdk import Client
from amazme_backend.session_ops import run_session_op
from amazme_backend.storage import SessionStore, remove_session_directory, session_database

SID = "ab" * 16
FENCE = HostFence(host_epoch=0, build_id="test-build")


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "lock", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": ""}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:9"
    return host


async def test_second_writer_is_refused_until_the_owner_closes(tmp_path: Path) -> None:
    path = tmp_path / "session.sqlite"
    owner = SessionStore(path, SID, build="test-build")
    await owner.initialize()
    await owner.accept(Submit(request_id="one", text="独占锁"), FENCE)
    lock_path = path.with_name("session.lock")
    assert lock_path.is_file()
    assert stat_mode(lock_path) == 0o600
    reader = SessionStore(path, SID, build="test-build", read_only=True, require_existing=True)
    await reader.initialize()
    try:
        hits = await reader.search("独占锁")
        assert [hit.excerpt for hit in hits if "独占锁" in hit.excerpt]
        blocked = SessionStore(path, SID, build="test-build")
        try:
            with pytest.raises(BackendError) as caught:
                await blocked.initialize()
            assert caught.value.code == "session_locked"
            assert await reader.search("独占锁")
        finally:
            await blocked.db.close()
    finally:
        await reader.db.close()
        await owner.db.close()
    follower = SessionStore(path, SID, build="test-build", require_existing=True)
    try:
        await follower.initialize()
        assert await follower.get("one")
    finally:
        await follower.db.close()
    remove_session_directory(path.parent)
    assert not path.parent.exists()


async def test_bad_database_does_not_create_the_lock(tmp_path: Path) -> None:
    path = tmp_path / "session.sqlite"
    db = sqlite3.connect(path)
    db.execute("PRAGMA user_version=1")
    db.execute("CREATE TABLE evidence(value)")
    db.commit()
    db.close()
    before = path.read_bytes(), path.stat().st_mtime_ns
    store = SessionStore(path, SID, build="test-build")
    try:
        with pytest.raises(BackendError) as caught:
            await store.initialize()
        assert caught.value.code == "unsupported_storage_format"
        assert not path.with_name("session.lock").exists()
        assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    finally:
        await store.db.close()


async def test_symlink_lock_is_refused_before_create(tmp_path: Path) -> None:
    path = tmp_path / "session.sqlite"
    path.with_name("session.lock").symlink_to(tmp_path / "elsewhere")
    store = SessionStore(path, SID, build="test-build")
    try:
        with pytest.raises(BackendError) as caught:
            await store.initialize()
        assert caught.value.code == "session_lock_refused"
        assert not path.exists()
    finally:
        await store.db.close()


async def test_owner_operation_is_visible_to_a_reader(tmp_path: Path) -> None:
    path = tmp_path / "session.sqlite"
    owner = SessionStore(path, SID, build="test-build")
    await owner.initialize()
    try:
        saved = WebPolicy.model_validate_json(await run_session_op(
            owner, "save_web_policy", WebPolicy(enabled=False, count=4).model_dump_json()))
        assert saved.count == 4
        reader = SessionStore(path, SID, build="test-build", read_only=True, require_existing=True)
        try:
            await reader.initialize()
            assert (await reader.web_policy()).count == 4
        finally:
            await reader.db.close()
    finally:
        await owner.db.close()


async def test_host_usage_reads_under_the_writer_lock(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    created = await host.create_session(CreateSession(title="锁"))
    path = session_database(host.profile.path, created.session_id)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    owner = SessionStore(path, created.session_id, build=host.build)
    await owner.initialize()
    try:
        await owner.accept(Submit(request_id="one", text="宿主仍可读"),
                           HostFence(host_epoch=0, build_id=host.build))
        report = await host.session_usage(created.session_id)
        assert report.session_id == created.session_id
        assert report.model_calls == 0
        found = await host.search_session(created.session_id, "宿主仍可读")
        assert found.hits
    finally:
        await owner.db.close()
        await host.store.db.close()


def _serve(tmp_path: Path) -> tuple[subprocess.Popen[bytes], str, Path]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = tmp_path / "profile"
    provider = tmp_path / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    init = subprocess.run(
        [sys.executable, "-m", "amazme_backend", "init", "--profile", str(profile),
         "--workspace", str(workspace), "--provider-config", str(provider)],
        check=False, capture_output=True, text=True)
    assert init.returncode == 0, init.stderr
    err_path = tmp_path / "serve.err"
    err_file = err_path.open("wb")
    proc = subprocess.Popen(
        [sys.executable, "-m", "amazme_backend", "serve", "--profile", str(profile), "--port", "0"],
        stdout=subprocess.PIPE, stderr=err_file)
    err_file.close()
    assert proc.stdout is not None
    ready = _ready(proc, time.monotonic() + 30)
    if "url" not in ready:
        proc.kill()
        proc.wait(timeout=10)
        raise AssertionError(err_path.read_text(errors="replace")[-2000:])
    return proc, str(ready["url"]), profile


def _ready(proc: subprocess.Popen[bytes], deadline: float) -> dict[str, object]:
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    pending = ""
    while time.monotonic() < deadline:
        if proc.poll() is not None and not pending:
            break
        readable, _, _ = select.select([fd], [], [], 0.05)
        if not readable:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            if proc.poll() is not None:
                break
            continue
        pending += chunk.decode()
        if "\n" not in pending:
            continue
        line, pending = pending.split("\n", 1)
        if not line.startswith("{"):
            continue
        loaded = json.loads(line)
        if isinstance(loaded, dict) and "url" in loaded:
            return {str(key): value for key, value in cast(dict[object, object], loaded).items()}
    return {}


def _stop(proc: subprocess.Popen[bytes], profile: Path) -> None:
    subprocess.run([sys.executable, "-m", "amazme_backend", "stop", "--profile", str(profile)],
                   check=False, capture_output=True, text=True, timeout=40)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
    if proc.stdout is not None:
        proc.stdout.close()


async def test_live_worker_keeps_the_lock_and_accepts_the_host_write(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            created = await client.rpc("session.create", workspace="primary", title="锁")
            session_id = str(created["session_id"])
            attachment = await client.attach(session_id)
            submitted = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="lock-1", text="你好")
            answer = await client.wait(session_id=session_id, request_id=submitted.request_id)
            assert answer.status == "succeeded"
            path = session_database(profile, session_id)
            outsider = SessionStore(path, session_id, build="outsider")
            try:
                with pytest.raises(BackendError) as caught:
                    await outsider.initialize()
                assert caught.value.code == "session_locked"
            finally:
                await outsider.db.close()
            identity = httpx.get(url + "/api/v1/bootstrap", headers={"Authorization": "Bearer " + token}, timeout=10)
            assert identity.status_code == 200, identity.text
            body = identity.json()
            saved = httpx.post(
                f"{url}/api/v1/sessions/{session_id}/web",
                headers={
                    "Authorization": "Bearer " + token,
                    "x-amazme-build": str(body["build_id"]),
                    "x-amazme-epoch": str(body["host_epoch"]),
                    "x-amazme-attachment": attachment.attachment_id,
                },
                json={"enabled": False, "count": 4},
                timeout=20)
            assert saved.status_code == 200, saved.text
            assert saved.json()["count"] == 4
            seen = httpx.get(
                f"{url}/api/v1/sessions/{session_id}/web",
                headers={"Authorization": "Bearer " + token},
                timeout=10)
            assert seen.status_code == 200, seen.text
            assert seen.json()["count"] == 4
            reader = SessionStore(path, session_id, read_only=True, require_existing=True)
            try:
                await reader.initialize()
                assert (await reader.web_policy()).count == 4
            finally:
                await reader.db.close()
    finally:
        _stop(proc, profile)


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777
