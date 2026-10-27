"""Run CLI, RPC, SDK, and TUI against one frozen amazme-backend."""

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path
from typing import cast

from amazme_backend.contracts import BackendError
from amazme_backend.sdk import Client

MARKER = re.compile(r"会话:([a-f0-9]{32}) 绑定:([a-f0-9]{32}) 工作区:primary")


def serve(executable: Path, profile: Path, workspace: Path, provider: Path) -> tuple[subprocess.Popen[bytes], str]:
    init = subprocess.run(
        [str(executable), "init", "--profile", str(profile), "--workspace", str(workspace),
         "--provider-config", str(provider)],
        check=False, capture_output=True, text=True)
    if init.returncode != 0:
        raise SystemExit(init.stderr[-2000:])
    err_path = profile.parent / "serve.err"
    err_file = err_path.open("wb")
    proc = subprocess.Popen(
        [str(executable), "serve", "--profile", str(profile), "--port", "0"],
        stdout=subprocess.PIPE, stderr=err_file)
    err_file.close()
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    pending = ""
    deadline = time.monotonic() + 40
    ready: dict[str, object] = {}
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
            ready = {str(key): value for key, value in cast(dict[object, object], loaded).items()}
            break
    if "url" not in ready:
        proc.kill()
        raise SystemExit(err_path.read_text(errors="replace")[-2000:])
    return proc, str(ready["url"])


def stop(executable: Path, proc: subprocess.Popen[bytes], profile: Path) -> None:
    subprocess.run([str(executable), "stop", "--profile", str(profile)],
                   check=False, capture_output=True, text=True, timeout=40)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
    if proc.stdout is not None:
        proc.stdout.close()


def cli(executable: Path, url: str, token: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(executable), "client", "--url", url, "--token", token, *args],
        check=False, capture_output=True, text=True, timeout=60)


def collect(master: int, proc: subprocess.Popen[bytes], buf: str, needle: str, deadline: float) -> str:
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


def open_tui(executable: Path, url: str, token: str) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
    proc = subprocess.Popen(
        [str(executable), "tui", "--url", url, "--token", token, "--workspace", "primary"],
        stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    return proc, master


def close_tui(proc: subprocess.Popen[bytes], master: int) -> None:
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


async def check(executable: Path, url: str, token: str) -> dict[str, object]:
    future = int(time.time() * 1000) + 60_000
    async with Client(url, token) as client:
        created = await client.rpc("session.create", workspace="primary", title="冻结")
        session_id = str(created["session_id"])
        attachment = await client.attach(session_id)
        held = await client.submit(
            session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
            request_id="held", text="稍后", not_before_ms=future)
        if held.status not in {"queued", "waiting_time"} or held.cancel_requested:
            raise SystemExit("parked request was not waiting")
        await client.release(session_id=session_id, attachment_id=attachment.attachment_id)
        still = await client.request(session_id=session_id, request_id="held")
        if still.status != held.status or still.cancel_requested:
            raise SystemExit("release cancelled the request")
        try:
            await client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="after-release", text="再来")
        except BackendError as exc:
            if exc.code != "stale_client_binding":
                raise SystemExit(exc.code)
        else:
            raise SystemExit("released binding was accepted")
        again = await client.attach(session_id)
        try:
            await client.rpc(
                "request.submit", session_id=session_id, workspace="other",
                attachment_id=again.attachment_id, request_id="nope", text="不要")
        except BackendError as exc:
            if exc.code != "workspace_mismatch":
                raise SystemExit(exc.code)
        else:
            raise SystemExit("mismatched workspace was accepted")
        await client.cancel(
            session_id=session_id, workspace="primary", attachment_id=again.attachment_id, request_id="held")
    created_cli = cli(executable, url, token, "create", "--workspace", "primary", "--title", "命令行")
    if created_cli.returncode != 0 or token in created_cli.stdout or token in created_cli.stderr:
        raise SystemExit(created_cli.stderr[-500:])
    cli_session = str(json.loads(created_cli.stdout)["session_id"])
    submitted = cli(executable, url, token, "submit", "--session", cli_session, "--workspace", "primary",
                    "--request-id", "cli-1", "--text", "你好")
    if submitted.returncode != 0 or token in submitted.stdout:
        raise SystemExit(submitted.stderr[-500:] or submitted.stdout[-500:])
    answer = json.loads(submitted.stdout)
    if answer.get("status") != "succeeded" or answer.get("answer") != "已收到：你好":
        raise SystemExit(submitted.stdout[-500:])
    rejected = cli(executable, url, token, "rpc", "--method", "request.submit", "--params", json.dumps({
        "session_id": cli_session, "workspace": "other", "attachment_id": "none",
        "request_id": "nope", "text": "不要"}))
    if rejected.returncode != 1 or rejected.stderr.strip() != "workspace_mismatch" or token in rejected.stderr:
        raise SystemExit(rejected.stderr[-500:])
    tui_pids: list[int] = []
    for _ in range(2):
        tui, master = open_tui(executable, url, token)
        tui_pids.append(tui.pid)
        try:
            screen = collect(master, tui, "", "绑定:", time.monotonic() + 20)
            if MARKER.search(screen) is None or token in screen:
                raise SystemExit(screen[-1500:])
            os.write(master, "你好\r".encode())
            screen = collect(master, tui, screen, "已收到：你好", time.monotonic() + 30)
            if "已收到：你好" not in screen or token in screen:
                raise SystemExit(screen[-1500:])
            os.write(master, b"\x03")
            screen = collect(master, tui, screen, "已松开绑定", time.monotonic() + 10)
            if "已松开绑定" not in screen or tui.wait(timeout=10) != 0:
                raise SystemExit(screen[-1500:])
        finally:
            if tui.poll() is None:
                close_tui(tui, master)
            else:
                os.close(master)
    if len(set(tui_pids)) != 2:
        raise SystemExit("tui did not start twice")
    return {"sdk": "passed", "cli": "passed", "rpc": "passed", "tui_pids": tui_pids}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    executable = args.executable.resolve()
    build = json.loads((executable.parent / "build.json").read_text())
    root = Path(tempfile.mkdtemp(prefix="amazme-frozen-clients-"))
    workspace = root / "workspace"
    profile = root / "profile"
    workspace.mkdir()
    provider = root / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    proc, url = serve(executable, profile, workspace, provider)
    token = (profile / "web.token").read_text().strip()
    try:
        import asyncio
        outcome = asyncio.run(check(executable, url, token))
    finally:
        stop(executable, proc, profile)
        shutil.rmtree(root, ignore_errors=True)
    report = {
        "executable": str(executable),
        "build_id": build["build_id"],
        "protocol": "amazme-http/1",
        **outcome,
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"build_id": report["build_id"], "result": "passed"}))


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
