"""The amazme interactive entry uses the Python host and releases its binding on exit."""

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path
from typing import cast

from runtime_cleanup import stop_and_destroy

from amazme_backend.contracts import BackendError
from amazme_backend.sdk import Client

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "coding-agent" / "dist" / "cli.js"
NODE = os.environ.get("AMAZME_NODE", "node")
FROZEN = os.environ.get("AMAZME_FROZEN_BACKEND", "")
TOKEN_FILE = "web.token"
MARKER = re.compile(r"会话:([a-f0-9]{32}) 绑定:([a-f0-9]{32}) 工作区:primary")


def _serve(tmp_path: Path) -> tuple[subprocess.Popen[bytes], str, Path]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = tmp_path / "profile"
    provider = tmp_path / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    backend = [FROZEN] if FROZEN else [sys.executable, "-m", "amazme_backend"]
    init = subprocess.run(
        [*backend, "init", "--profile", str(profile),
         "--workspace", str(workspace), "--provider-config", str(provider)],
        check=False, capture_output=True, text=True)
    assert init.returncode == 0, init.stderr
    err_path = tmp_path / "serve.err"
    err_file = err_path.open("wb")
    proc = subprocess.Popen(
        [*backend, "serve", "--profile", str(profile), "--port", "0"],
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
    backend = [FROZEN] if FROZEN else [sys.executable, "-m", "amazme_backend"]
    try:
        stop_and_destroy(backend, profile)
    finally:
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()


def _open_ui(url: str, token: str, home: Path) -> tuple[subprocess.Popen[bytes], int]:
    assert CLI.is_file(), "build @amazme/coding-agent before this test"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
    env = os.environ.copy()
    env["AMAZME_CODING_AGENT_DIR"] = str(home)
    env.pop("AMAZME_OFFLINE", None)
    proc = subprocess.Popen(
        [NODE, str(CLI), "--python-url", url, "--python-token", token, "--workspace", "primary"],
        stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env)
    os.close(slave)
    return proc, master


def _collect(master: int, proc: subprocess.Popen[bytes], buf: str, needle: str, deadline: float) -> str:
    while time.monotonic() < deadline and needle not in buf:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            chunk = os.read(master, 4096)
            if not chunk:
                break
            buf += chunk.decode("utf-8", "replace")
            continue
        if proc.poll() is not None:
            break
    return buf


def _close(proc: subprocess.Popen[bytes], master: int) -> None:
    if proc.poll() is None:
        try:
            os.write(master, b"\x03")
        except OSError:
            proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
    os.close(master)


async def _rejects(action, code: str) -> None:
    try:
        await action()
    except BackendError as exc:
        assert exc.code == code
    else:
        raise AssertionError(code + " was accepted")


async def test_amazme_interactive_uses_python_and_quit_releases(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    future = int(time.time() * 1000) + 60_000
    ui: subprocess.Popen[bytes] | None = None
    master = -1
    try:
        ui, master = _open_ui(url, token, tmp_path / "agent")
        screen = _collect(master, ui, "", "绑定:", time.monotonic() + 20)
        found = MARKER.search(screen)
        assert found is not None, screen[-2000:]
        session_id, attachment_id = found.group(1), found.group(2)
        assert token not in screen
        async with Client(url, token) as client:
            other = await client.attach(session_id)
            parked = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=other.attachment_id,
                request_id="parked", text="等一下", not_before_ms=future)
            assert parked.cancel_requested is False
        os.write(master, b"\x03")
        screen = _collect(master, ui, screen, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen, screen[-2000:]
        assert ui.wait(timeout=10) == 0
        async with Client(url, token) as client:
            still = await client.request(session_id=session_id, request_id="parked")
            assert still.status == parked.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment_id,
                request_id="after-quit", text="再来"), "stale_client_binding")
            fresh = await client.attach(session_id)
            await client.cancel(
                session_id=session_id, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="parked")
        os.close(master)
        master = -1
        first_pid = ui.pid

        ui, master = _open_ui(url, token, tmp_path / "agent")
        assert ui.pid != first_pid
        screen = _collect(master, ui, "", "绑定:", time.monotonic() + 20)
        second = MARKER.search(screen)
        assert second is not None, screen[-2000:]
        assert second.group(1) != session_id
        os.write(master, "你好\r".encode())
        screen = _collect(master, ui, screen, "已收到：你好", time.monotonic() + 30)
        assert "已收到：你好" in screen, screen[-2000:]
        assert token not in screen
        os.write(master, b"\x03")
        screen = _collect(master, ui, screen, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen
        assert ui.wait(timeout=10) == 0
        os.close(master)
        master = -1
        ui = None
    finally:
        if ui is not None and master >= 0:
            _close(ui, master)
        elif master >= 0:
            os.close(master)
        _stop(proc, profile)


def _open_default(tmp_path: Path, cwd: Path) -> tuple[subprocess.Popen[bytes], int]:
    assert CLI.is_file(), "build @amazme/coding-agent before this test"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    wrapper = bin_dir / "amazme-backend"
    if not wrapper.exists():
        wrapper.write_text(f"#!/bin/sh\nexec {sys.executable} -m amazme_backend \"$@\"\n")
        wrapper.chmod(0o755)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
    env = os.environ.copy()
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env["AMAZME_CODING_AGENT_DIR"] = str(tmp_path / "agent")
    env.pop("AMAZME_OFFLINE", None)
    env.pop("AMAZME_PYTHON_BACKEND", None)
    proc = subprocess.Popen(
        [NODE, str(CLI)], cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env)
    os.close(slave)
    return proc, master


async def test_default_interactive_starts_python_and_leave_keeps_the_host(tmp_path: Path) -> None:
    cwd = tmp_path / "workspace"
    cwd.mkdir()
    profile = tmp_path / "agent" / "python-host"
    ui: subprocess.Popen[bytes] | None = None
    master = -1
    try:
        ui, master = _open_default(tmp_path, cwd)
        screen = _collect(master, ui, "", "绑定:", time.monotonic() + 30)
        found = MARKER.search(screen)
        assert found is not None, screen[-2000:]
        session_id, attachment_id = found.group(1), found.group(2)
        token = (profile / "web.token").read_text().strip()
        url = str(json.loads((profile / "ready.json").read_text())["url"])
        assert token not in screen
        future = int(time.time() * 1000) + 60_000
        async with Client(url, token) as client:
            other = await client.attach(session_id)
            parked = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=other.attachment_id,
                request_id="parked", text="等一下", not_before_ms=future)
            assert parked.cancel_requested is False
        os.write(master, b"\x03")
        screen = _collect(master, ui, screen, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen, screen[-2000:]
        assert ui.wait(timeout=10) == 0
        async with Client(url, token) as client:
            still = await client.request(session_id=session_id, request_id="parked")
            assert still.status == parked.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment_id,
                request_id="after-quit", text="再来"), "stale_client_binding")
        os.close(master)
        master = -1
        first_pid = ui.pid

        ui, master = _open_default(tmp_path, cwd)
        assert ui.pid != first_pid
        screen = _collect(master, ui, "", "绑定:", time.monotonic() + 20)
        second = MARKER.search(screen)
        assert second is not None, screen[-2000:]
        assert second.group(1) != session_id
        os.write(master, "你好\r".encode())
        screen = _collect(master, ui, screen, "已收到：你好", time.monotonic() + 30)
        assert "已收到：你好" in screen, screen[-2000:]
        assert token not in screen
        os.write(master, b"\x03")
        screen = _collect(master, ui, screen, "已松开绑定", time.monotonic() + 10)
        assert ui.wait(timeout=10) == 0
        async with Client(url, token) as client:
            still = await client.request(session_id=session_id, request_id="parked")
            assert still.status == parked.status
            fresh = await client.attach(session_id)
            await client.cancel(
                session_id=session_id, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="parked")
        os.close(master)
        master = -1
        ui = None
    finally:
        if ui is not None and master >= 0:
            _close(ui, master)
        elif master >= 0:
            os.close(master)
        if profile.is_dir():
            stop_and_destroy([sys.executable, "-m", "amazme_backend"], profile)


def _headless_env(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    wrapper = bin_dir / "amazme-backend"
    if not wrapper.exists():
        wrapper.write_text(f"#!/bin/sh\nexec {sys.executable} -m amazme_backend \"$@\"\n")
        wrapper.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env["AMAZME_CODING_AGENT_DIR"] = str(tmp_path / "agent")
    env.pop("AMAZME_OFFLINE", None)
    env.pop("AMAZME_PYTHON_BACKEND", None)
    env.pop("AMAZME_DURABLE_TUI", None)
    return env


def _run_cli(tmp_path: Path, cwd: Path, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    assert CLI.is_file(), "build @amazme/coding-agent before this test"
    return subprocess.run(
        [NODE, str(CLI), *args], cwd=cwd, env=_headless_env(tmp_path), input=stdin,
        capture_output=True, text=True, timeout=60)


async def test_print_json_and_rpc_use_the_python_host(tmp_path: Path) -> None:
    cwd = tmp_path / "workspace"
    cwd.mkdir()
    profile = tmp_path / "agent" / "python-host"
    try:
        printed = _run_cli(tmp_path, cwd, "--print", "你好")
        assert printed.returncode == 0, printed.stderr
        assert printed.stdout.strip() == "已收到：你好"
        token = (profile / "web.token").read_text().strip()
        url = str(json.loads((profile / "ready.json").read_text())["url"])
        assert token not in printed.stdout and token not in printed.stderr
        encoded = _run_cli(tmp_path, cwd, "--mode", "json", "--workspace", "primary", "你好")
        assert encoded.returncode == 0, encoded.stderr
        body = json.loads(encoded.stdout)
        assert body["status"] == "succeeded"
        assert body["answer"] == "已收到：你好"
        assert body["workspace"] == "primary"
        assert len(str(body["session_id"])) == 32
        assert token not in encoded.stdout and token not in encoded.stderr
        created = _run_cli(tmp_path, cwd, "--mode", "rpc", stdin=json.dumps({
            "jsonrpc": "2.0", "id": "c", "method": "session.create",
            "params": {"workspace": "primary", "title": "命令"},
        }) + "\n")
        assert created.returncode == 0, created.stderr
        session_id = str(json.loads(created.stdout)["result"]["session_id"])
        assert token not in created.stdout
        future = int(time.time() * 1000) + 60_000
        async with Client(url, token) as client:
            attachment = await client.attach(session_id)
        held = _run_cli(tmp_path, cwd, "--mode", "rpc", stdin=json.dumps({
            "jsonrpc": "2.0", "id": "s", "method": "request.submit",
            "params": {
                "session_id": session_id, "workspace": "primary",
                "attachment_id": attachment.attachment_id, "request_id": "held",
                "text": "稍后", "not_before_ms": future,
            },
        }) + "\n")
        assert held.returncode == 0, held.stderr
        receipt = json.loads(held.stdout)["result"]
        assert receipt["status"] in {"queued", "waiting_time"}
        released = _run_cli(tmp_path, cwd, "--mode", "rpc", stdin=json.dumps({
            "jsonrpc": "2.0", "id": "r", "method": "session.release",
            "params": {"session_id": session_id, "attachment_id": attachment.attachment_id},
        }) + "\n")
        assert json.loads(released.stdout)["result"] == {"detached": True, "cancelled": False}
        async with Client(url, token) as client:
            still = await client.request(session_id=session_id, request_id="held")
            assert still.status == receipt["status"]
            assert still.cancel_requested is False
            fresh = await client.attach(session_id)
            await client.cancel(
                session_id=session_id, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="held")
        mismatched = _run_cli(tmp_path, cwd, "--mode", "rpc", stdin=json.dumps({
            "jsonrpc": "2.0", "id": "m", "method": "request.submit",
            "params": {
                "session_id": session_id, "workspace": "other",
                "attachment_id": "none", "request_id": "nope", "text": "不要",
            },
        }) + "\n")
        assert json.loads(mismatched.stdout)["error"]["message"] == "workspace_mismatch"
        assert token not in mismatched.stdout and token not in mismatched.stderr
    finally:
        if profile.is_dir():
            stop_and_destroy([sys.executable, "-m", "amazme_backend"], profile)
