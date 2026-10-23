"""CLI, RPC, and the async SDK name the host, session, and workspace."""

import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
from typing import cast

from amazme_backend.contracts import BackendError
from amazme_backend.sdk import Client

TOKEN_FILE = "web.token"


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


def _cli(url: str, token: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "amazme_backend", "client", "--url", url, "--token", token, *args],
        check=False, capture_output=True, text=True, timeout=60)


async def _rejects(action, code: str) -> None:
    try:
        await action()
    except BackendError as exc:
        assert exc.code == code
    else:
        raise AssertionError(code + " was accepted")


async def test_release_does_not_cancel_and_cli_reads_the_answer(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    future = int(time.time() * 1000) + 60_000
    try:
        async with Client(url, token) as client:
            created = await client.rpc("session.create", workspace="primary", title="命令")
            session_id = str(created["session_id"])
            assert created["workspace"] == "primary"
            attachment = await client.attach(session_id)
            held = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="held", text="稍后", not_before_ms=future)
            assert held.status in {"queued", "waiting_time"}
            assert held.cancel_requested is False
            await client.release(session_id=session_id, attachment_id=attachment.attachment_id)
            still = await client.request(session_id=session_id, request_id="held")
            assert still.status == held.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="after-release", text="再来"), "stale_client_binding")

            second = await client.attach(session_id)
            released = await client.rpc(
                "session.release", session_id=session_id, attachment_id=second.attachment_id)
            assert released == {"detached": True, "cancelled": False}
            still = await client.request(session_id=session_id, request_id="held")
            assert still.status == held.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.cancel(
                session_id=session_id, workspace="primary", attachment_id=second.attachment_id,
                request_id="held"), "stale_client_binding")

            third = await client.attach(session_id)
            await _rejects(lambda: client.rpc(
                "request.submit", session_id=session_id, workspace="other",
                attachment_id=third.attachment_id, request_id="nope", text="不要"), "workspace_mismatch")
            cancelled = await client.cancel(
                session_id=session_id, workspace="primary", attachment_id=third.attachment_id,
                request_id="held")
            finished = await client.wait(session_id=session_id, request_id=cancelled.request_id)
            assert finished.status == "cancelled"

        created_cli = _cli(url, token, "create", "--workspace", "primary", "--title", "命令行")
        assert created_cli.returncode == 0, created_cli.stderr
        cli_session = str(json.loads(created_cli.stdout)["session_id"])
        assert token not in created_cli.stdout and token not in created_cli.stderr
        submitted = _cli(url, token, "submit", "--session", cli_session, "--workspace", "primary",
                         "--request-id", "cli-1", "--text", "你好")
        assert submitted.returncode == 0, submitted.stderr
        answer = json.loads(submitted.stdout)
        assert answer["status"] == "succeeded"
        assert answer["answer"] == "已收到：你好"
        assert token not in submitted.stdout and token not in submitted.stderr
        rejected = _cli(url, token, "rpc", "--method", "request.submit", "--params", json.dumps({
            "session_id": cli_session, "workspace": "other", "attachment_id": "none",
            "request_id": "nope", "text": "不要"}))
        assert rejected.returncode == 1
        assert rejected.stderr.strip() == "workspace_mismatch"
        assert token not in rejected.stdout and token not in rejected.stderr

        async with Client(url, token) as client:
            parked_attachment = await client.attach(cli_session)
            parked = await client.submit(
                session_id=cli_session, workspace="primary", attachment_id=parked_attachment.attachment_id,
                request_id="parked", text="等一下", not_before_ms=future)
            assert parked.status in {"queued", "waiting_time"}
        released_cli = _cli(url, token, "release", "--session", cli_session,
                            "--attachment", parked_attachment.attachment_id)
        assert released_cli.returncode == 0, released_cli.stderr
        assert json.loads(released_cli.stdout) == {"detached": True, "cancelled": False}
        assert token not in released_cli.stdout and token not in released_cli.stderr
        async with Client(url, token) as client:
            still = await client.request(session_id=cli_session, request_id="parked")
            assert still.status == parked.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=cli_session, workspace="primary", attachment_id=parked_attachment.attachment_id,
                request_id="after-cli-release", text="再来"), "stale_client_binding")
            fresh = await client.attach(cli_session)
            await client.cancel(
                session_id=cli_session, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="parked")
            done = await client.wait(session_id=cli_session, request_id="parked")
            assert done.status == "cancelled"
    finally:
        _stop(proc, profile)
