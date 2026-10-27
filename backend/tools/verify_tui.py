"""Real amazme-backend tui process against the current source backend.

The screen is the product terminal client. It does not approve work by itself,
and leaving it does not close the session terminal or MCP service.
"""

import fcntl
import json
import os
import pty
import re
import select
import shlex
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path

from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime, until

PYTHON = ROOT / "backend/.venv/bin/python"
MARKER = re.compile(r"会话:([a-f0-9]{32}) 绑定:([a-f0-9]{32}) 工作区:primary")


class Tui:
    def __init__(self, url: str, token: str, session: str = "") -> None:
        self.url = url
        self.token = token
        self.session = session
        self.proc: subprocess.Popen[bytes] | None = None
        self.master = -1
        self.buf = ""
        self._closed = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        command = [sys.executable, "-m", "amazme_backend", "tui", "--url", self.url,
                   "--token", self.token, "--workspace", "primary"]
        if self.session:
            command.extend(["--session", self.session])
        self.proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                     close_fds=True, start_new_session=True)
        os.close(slave)
        self.master = master
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def wait_for(self, needle: str, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and needle not in self._text():
            time.sleep(0.05)
            if self.proc is not None and self.proc.poll() is not None and needle not in self._text():
                break
        if needle not in self._text():
            raise TimeoutError(self._text()[-2000:])

    def frame_count(self, needle: str) -> int:
        return self._text().split("\x1b[2J")[-1].count(needle)

    def wait_line(self, line: str, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self._has_line(line):
            time.sleep(0.05)
            if self.proc is not None and self.proc.poll() is not None and not self._has_line(line):
                break
        if not self._has_line(line):
            raise TimeoutError(self._text()[-2000:])

    def _has_line(self, line: str) -> bool:
        frame = self._text().split("\x1b[2J")[-1]
        return any(item.strip() == line for item in frame.splitlines())

    def wait_frame(self, needle: str, count: int, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and self.frame_count(needle) < count:
            time.sleep(0.05)
            if self.proc is not None and self.proc.poll() is not None:
                break
        if self.frame_count(needle) < count:
            raise TimeoutError(self._text()[-2000:])

    def send(self, text: str) -> None:
        os.write(self.master, (text + "\r").encode())

    def quit(self) -> None:
        self._closed = True
        if self.proc is not None and self.proc.poll() is None and self.master >= 0:
            try:
                os.write(self.master, b"\x03")
            except OSError:
                self.proc.kill()
        if self.proc is not None:
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self.master >= 0:
            os.close(self.master)
            self.master = -1

    def _text(self) -> str:
        with self._lock:
            return self.buf

    def _pump(self) -> None:
        while not self._closed:
            try:
                self._read(0.05)
            except OSError:
                return

    def _read(self, pause: float) -> None:
        if self.master < 0:
            return
        readable, _, _ = select.select([self.master], [], [], pause)
        if not readable:
            return
        chunk = os.read(self.master, 4096)
        if chunk:
            with self._lock:
                self.buf += chunk.decode("utf-8", "replace")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "tui-", 2)
    root = Path(tempfile.mkdtemp(prefix="tui-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    report: dict[str, object] = {"status": "running", "execution": "tui-source", "vm_created": False, "checks": []}
    runtime: Runtime | None = None
    screens: list[Tui] = []
    decoy = subprocess.Popen(["/bin/sleep", "600"])
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=240)
    token = ""
    try:
        with budget:
            runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider, approval_policy="mutations")
            runtime.start()
            assert runtime.process is not None and runtime.client is not None and runtime.ready is not None
            token = (runtime.profile / "web.token").read_text().strip()
            url = str(runtime.ready["url"])
            report["identity"] = {"build_id": runtime.ready["build_id"], "url": url, "host_pid": runtime.process.pid}
            primary = Tui(url, token)
            screens.append(primary)
            primary.start()
            primary.wait_for("绑定:")
            found = MARKER.search(primary._text())
            assert found is not None, primary._text()[-1500:]
            session = found.group(1)
            assert token not in primary._text()

            shell = runtime.workspace / "tui-shell.txt"
            primary.send("/shell printf y > tui-shell.txt")
            primary.wait_for("等待审批 shell printf y > tui-shell.txt")
            assert not shell.exists()
            primary.send("不要")
            primary.wait_for("先输入批准或拒绝")
            assert "已收到：不要" not in primary._text()
            assert not shell.exists()
            primary.send("拒绝")
            primary.wait_for("approval_denied")
            assert not shell.exists()
            primary.send("/shell printf y > tui-shell.txt")
            primary.wait_frame("等待审批 shell", 2)
            assert not shell.exists()
            primary.send("批准")
            until(lambda: shell.read_text() if shell.exists() else "", lambda value: value == "y", timeout=40)
            report["checks"].append("tui required an explicit approval before the shell wrote its file, and a refusal had no effect")

            primary.send("/file tui-shell.txt")
            primary.wait_line("y")
            primary.send("/checkpoint tui-shell.txt")
            primary.wait_for("已保存")
            report["checks"].append("tui read the shell output and saved a checkpoint")

            primary.send("/pty printf x > tui-term.txt; printf 'TUI_TERM_OK\\n'")
            primary.wait_line("TUI_TERM_OK", timeout=20)
            assert primary._has_line("输入已接收")
            until(lambda: (runtime.workspace / "tui-term.txt").read_text() if (runtime.workspace / "tui-term.txt").exists() else "",
                  lambda value: value == "x")
            assert "输入已接收" in primary._text()
            primary.send("/pty-size 100 40")
            primary.wait_for("终端 100 40")
            primary.send("/pty stty size")
            primary.wait_for("40 100")
            report["checks"].append("tui showed terminal output, treated accepted input as distinct from command success, and observed resize")

            command = shlex.join([str(PYTHON), str(ROOT / "backend/tools/mcp_probe_server.py"),
                                  "--workspace", str(runtime.workspace)])
            primary.send("/mcp " + command)
            primary.wait_for("MCP 已连接", timeout=30)
            primary.send('/mcp-call native_echo {"text":"denied","numbers":[1]}')
            primary.wait_for("等待审批 MCP native_echo")
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            primary.send("拒绝")
            primary.wait_for("MCP denied")
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            primary.send('/mcp-call native_echo {"text":"x","numbers":[2,3]}')
            primary.wait_frame("等待审批 MCP", 2)
            primary.send("批准")
            until(lambda: (runtime.workspace / "mcp-effect.txt").read_text() if (runtime.workspace / "mcp-effect.txt").exists() else "",
                  lambda value: value == "x", timeout=20)
            report["checks"].append("tui denied an MCP call with no effect, then one approval wrote once")

            other = Tui(url, token)
            screens.append(other)
            other.start()
            other.wait_for("绑定:")
            other_found = MARKER.search(other._text())
            assert other_found is not None and other_found.group(1) != session
            other.quit()
            screens.remove(other)
            terminals = runtime.client.get(f"/api/v1/sessions/{session}/terminals").json()["terminals"]
            assert len(terminals) == 1 and terminals[0]["phase"] == "running"
            servers = runtime.client.get(f"/api/v1/sessions/{session}/mcp").json()["servers"]
            assert len(servers) == 1 and servers[0]["phase"] == "ready"
            report["checks"].append("a second tui session stayed separate and did not stop the first session's terminal or MCP service")

            headers = runtime.attach(session)
            request_id = "ab" * 16
            parked = runtime.client.post(
                f"/api/v1/sessions/{session}/submissions", headers=headers,
                json={"request_id": request_id, "text": "终端仍在", "not_before_ms": int(time.time() * 1000) + 3_600_000}).json()
            assert parked["status"] == "waiting_time" and parked["cancel_requested"] is False
            primary.quit()
            screens.remove(primary)
            still = runtime.client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
            assert still["status"] == "waiting_time" and still["cancel_requested"] is False
            terminals = runtime.client.get(f"/api/v1/sessions/{session}/terminals").json()["terminals"]
            assert terminals[0]["phase"] == "running"
            servers = runtime.client.get(f"/api/v1/sessions/{session}/mcp").json()["servers"]
            assert servers[0]["phase"] == "ready"
            assert alive(runtime.process.pid)
            report["checks"].append("leaving the tui kept the backend, the parked request, the terminal, and the MCP service")

            again = Tui(url, token, session)
            screens.append(again)
            again.start()
            again.wait_for("终端仍在")
            again.wait_for("服务仍在")
            again.send("/pty-close")
            again.wait_for("终端已退出")
            again.send("/mcp-close")
            again.wait_for("服务已退出")
            again.quit()
            screens.remove(again)
            closed = runtime.client.get(f"/api/v1/sessions/{session}/terminals").json()["terminals"]
            assert closed[0]["phase"] == "exited" and closed[0]["clean"] is True
            closed_servers = runtime.client.get(f"/api/v1/sessions/{session}/mcp").json()["servers"]
            assert closed_servers[0]["phase"] == "exited" and closed_servers[0]["clean"] is True
            after = runtime.client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
            assert after["status"] == "waiting_time" and after["cancel_requested"] is False
            report["checks"].append("rejoining the same session explicitly stopped that terminal and MCP service")
            assert alive(decoy.pid or -1)
            report["status"] = "passed"
    except BaseException as error:
        message = f"{type(error).__name__}: {error}"
        if token:
            message = message.replace(token, "[redacted]")
        report.update(status="failed", error=message)
        raise
    finally:
        report["budget"] = budget.snapshot()
        for screen in screens:
            screen.quit()
        if decoy.poll() is None:
            decoy.kill()
            decoy.wait(timeout=5)
        pending = apply_cleanup(runtime, report)
        text = json.dumps(report, indent=2, ensure_ascii=False)
        if token:
            text = text.replace(token, "[redacted]")
        (root / "report.json").write_text(text + "\n")
        print(root / "report.json")
        raise_pending(pending)


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
