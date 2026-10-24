"""The terminal client names the host, waits for an explicit decision, and leaves accepted work running."""

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

from amazme_backend.contracts import BackendError
from amazme_backend.sdk import Client

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


def _open_tui(url: str, token: str) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
    proc = subprocess.Popen(
        [sys.executable, "-m", "amazme_backend", "tui", "--url", url, "--token", token, "--workspace", "primary"],
        stdin=slave, stdout=slave, stderr=slave, close_fds=True)
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


def _close_tui(proc: subprocess.Popen[bytes], master: int) -> None:
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


async def test_tui_quit_releases_binding_and_second_launch_shows_the_answer(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    future = int(time.time() * 1000) + 60_000
    tui: subprocess.Popen[bytes] | None = None
    master = -1
    try:
        tui, master = _open_tui(url, token)
        screen = _collect(master, tui, "", "绑定:", time.monotonic() + 20)
        found = MARKER.search(screen)
        assert found is not None, screen[-1500:]
        session_id, attachment_id = found.group(1), found.group(2)
        assert token not in screen
        async with Client(url, token) as client:
            other = await client.attach(session_id)
            parked = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=other.attachment_id,
                request_id="parked", text="等一下", not_before_ms=future)
            assert parked.status in {"queued", "waiting_time"}
            assert parked.cancel_requested is False
        os.write(master, b"\x03")
        screen = _collect(master, tui, screen, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen, screen[-1500:]
        assert tui.wait(timeout=10) == 0
        assert token not in screen
        async with Client(url, token) as client:
            still = await client.request(session_id=session_id, request_id="parked")
            assert still.status == parked.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment_id,
                request_id="after-tui", text="再来"), "stale_client_binding")
            fresh = await client.attach(session_id)
            await client.cancel(
                session_id=session_id, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="parked")
        os.close(master)
        master = -1
        first_pid = tui.pid

        tui, master = _open_tui(url, token)
        assert tui.pid != first_pid
        screen = _collect(master, tui, "", "绑定:", time.monotonic() + 20)
        second = MARKER.search(screen)
        assert second is not None, screen[-1500:]
        assert second.group(1) != session_id
        os.write(master, "你好\r".encode())
        screen = _collect(master, tui, screen, "已收到：你好", time.monotonic() + 30)
        assert "已收到：你好" in screen, screen[-1500:]
        assert token not in screen
        os.write(master, b"\x03")
        screen = _collect(master, tui, screen, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen
        assert tui.wait(timeout=10) == 0
        os.close(master)
        master = -1
        tui = None
    finally:
        if tui is not None and master >= 0:
            _close_tui(tui, master)
        elif master >= 0:
            os.close(master)
        _stop(proc, profile)


async def test_two_terminals_keep_their_own_sessions(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    future = int(time.time() * 1000) + 60_000
    first: subprocess.Popen[bytes] | None = None
    second: subprocess.Popen[bytes] | None = None
    master_a = -1
    master_b = -1
    try:
        first, master_a = _open_tui(url, token)
        second, master_b = _open_tui(url, token)
        assert first.pid != second.pid
        screen_a = _collect(master_a, first, "", "绑定:", time.monotonic() + 20)
        screen_b = _collect(master_b, second, "", "绑定:", time.monotonic() + 20)
        found_a = MARKER.search(screen_a)
        found_b = MARKER.search(screen_b)
        assert found_a is not None, screen_a[-1500:]
        assert found_b is not None, screen_b[-1500:]
        session_a, attachment_a = found_a.group(1), found_a.group(2)
        session_b, attachment_b = found_b.group(1), found_b.group(2)
        assert session_a != session_b
        assert token not in screen_a and token not in screen_b
        async with Client(url, token) as client:
            other = await client.attach(session_a)
            parked = await client.submit(
                session_id=session_a, workspace="primary", attachment_id=other.attachment_id,
                request_id="parked-a", text="等一下", not_before_ms=future)
            assert parked.cancel_requested is False
        os.write(master_a, b"\x03")
        screen_a = _collect(master_a, first, screen_a, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen_a
        assert first.wait(timeout=10) == 0
        assert second.poll() is None
        async with Client(url, token) as client:
            still = await client.request(session_id=session_a, request_id="parked-a")
            assert still.status == parked.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=session_a, workspace="primary", attachment_id=attachment_a,
                request_id="after-a", text="再来"), "stale_client_binding")
        os.write(master_b, "你好\r".encode())
        screen_b = _collect(master_b, second, screen_b, "已收到：你好", time.monotonic() + 30)
        assert "已收到：你好" in screen_b, screen_b[-1500:]
        assert token not in screen_b
        os.write(master_b, b"\x03")
        screen_b = _collect(master_b, second, screen_b, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen_b
        assert second.wait(timeout=10) == 0
        async with Client(url, token) as client:
            await _rejects(lambda: client.submit(
                session_id=session_b, workspace="primary", attachment_id=attachment_b,
                request_id="after-b", text="再来"), "stale_client_binding")
            fresh = await client.attach(session_a)
            await client.cancel(
                session_id=session_a, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="parked-a")
            done = await client.wait(session_id=session_a, request_id="parked-a")
            assert done.status == "cancelled"
        first = None
        second = None
        os.close(master_a)
        os.close(master_b)
        master_a = -1
        master_b = -1
    finally:
        if first is not None and master_a >= 0:
            _close_tui(first, master_a)
        elif master_a >= 0:
            os.close(master_a)
        if second is not None and master_b >= 0:
            _close_tui(second, master_b)
        elif master_b >= 0:
            os.close(master_b)
        _stop(proc, profile)


async def test_tui_shell_waits_for_an_explicit_decision(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    target = tmp_path / "workspace" / "tui-shell.txt"
    tui: subprocess.Popen[bytes] | None = None
    master = -1
    try:
        tui, master = _open_tui(url, token)
        screen = _collect(master, tui, "", "绑定:", time.monotonic() + 20)
        assert MARKER.search(screen) is not None, screen[-1500:]
        os.write(master, b"/shell printf y > tui-shell.txt\r")
        screen = _collect(master, tui, screen, "等待审批 shell printf y > tui-shell.txt", time.monotonic() + 20)
        assert "等待审批 shell printf y > tui-shell.txt" in screen, screen[-1500:]
        assert not target.exists()
        os.write(master, "不要\r".encode())
        screen = _collect(master, tui, screen, "先输入批准或拒绝", time.monotonic() + 10)
        assert "先输入批准或拒绝" in screen, screen[-1500:]
        assert "已收到：不要" not in screen
        assert not target.exists()
        os.write(master, "拒绝\r".encode())
        screen = _collect(master, tui, screen, "approval_denied", time.monotonic() + 20)
        assert "approval_denied" in screen, screen[-1500:]
        assert not target.exists()
        os.write(master, b"/shell printf y > tui-shell.txt\r")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and screen.split("\x1b[2J")[-1].count("等待审批 shell") < 2:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                screen += os.read(master, 4096).decode("utf-8", "replace")
            elif tui.poll() is not None:
                break
        assert screen.split("\x1b[2J")[-1].count("等待审批 shell") >= 2, screen[-1500:]
        assert not target.exists()
        os.write(master, "批准\r".encode())
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not target.exists():
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                screen += os.read(master, 4096).decode("utf-8", "replace")
        assert target.read_text() == "y", screen[-1500:]
        assert token not in screen
        os.write(master, b"\x03")
        screen = _collect(master, tui, screen, "已松开绑定", time.monotonic() + 10)
        assert "已松开绑定" in screen
        assert tui.wait(timeout=10) == 0
        os.close(master)
        master = -1
        tui = None
    finally:
        if tui is not None and master >= 0:
            _close_tui(tui, master)
        elif master >= 0:
            os.close(master)
        _stop(proc, profile)
