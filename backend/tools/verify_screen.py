"""Real coding-agent interactive screen against the current source backend.

The screen only decides on an exact 批准 or 拒绝. Leaving releases the binding
and does not close the session terminal or MCP service.
"""

import fcntl
import json
import os
import pty
import re
import select
import shlex
import shutil
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
NODE = shutil.which("node") or "node"
CLI = ROOT / "packages/coding-agent/dist/bundle/cli.js"
MARKER = re.compile(r"会话:([a-f0-9]{32}) 绑定:([a-f0-9]{32}) 工作区:primary")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\]8;;(?:[^\x07\x1b]*\x07|[^\x1b]*\x1b\\)")
SECRET = re.compile(r"(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)", re.IGNORECASE)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _env(agent: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not SECRET.search(key)}
    env["AMAZME_CODING_AGENT_DIR"] = str(agent)
    for name in ("AMAZME_PYTHON_URL", "AMAZME_PYTHON_TOKEN", "AMAZME_PYTHON_SESSION", "AMAZME_PYTHON_BACKEND"):
        env.pop(name, None)
    return env


class Screen:
    def __init__(self, url: str, token: str, workspace: Path, agent: Path, session: str = "") -> None:
        self.url = url
        self.token = token
        self.workspace = workspace
        self.agent = agent
        self.session = session
        self.proc: subprocess.Popen[bytes] | None = None
        self.master = -1
        self.buf = ""
        self._closed = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        assert CLI.is_file(), "build @amazme/coding-agent before this verifier"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        command = [NODE, str(CLI), "--python-url", self.url, "--python-token", self.token, "--workspace", "primary"]
        if self.session:
            command.extend(["--python-session", self.session])
        self.proc = subprocess.Popen(
            command, cwd=self.workspace, stdin=slave, stdout=slave, stderr=slave,
            close_fds=True, start_new_session=True, env=_env(self.agent))
        os.close(slave)
        self.master = master
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def wait_for(self, needle: str, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and needle not in self._frame():
            time.sleep(0.05)
            if self.proc is not None and self.proc.poll() is not None and needle not in self._frame():
                break
        if needle not in self._frame():
            raise TimeoutError(self._frame()[-2000:])

    def wait_line(self, line: str, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and line not in self._lines():
            time.sleep(0.05)
            if self.proc is not None and self.proc.poll() is not None and line not in self._lines():
                break
        if line not in self._lines():
            raise TimeoutError(self._frame()[-2000:])

    def wait_count(self, needle: str, count: int, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and self._frame().count(needle) < count:
            time.sleep(0.05)
            if self.proc is not None and self.proc.poll() is not None:
                break
        if self._frame().count(needle) < count:
            raise TimeoutError(self._frame()[-2000:])

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

    def _frame(self) -> str:
        return ANSI.sub("", self._text().split("\x1b[2J")[-1])

    def _plain(self) -> str:
        return self._frame()

    def _lines(self) -> list[str]:
        return [item.strip() for item in self._plain().splitlines()]

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


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "screen-", 2)
    root = Path(tempfile.mkdtemp(prefix="screen-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    report: dict[str, object] = {"status": "running", "execution": "screen-source", "vm_created": False, "checks": []}
    runtime: Runtime | None = None
    screens: list[Screen] = []
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
            primary = Screen(url, token, runtime.workspace, root / "agent")
            screens.append(primary)
            primary.start()
            primary.wait_for("绑定:")
            found = MARKER.search(primary._plain())
            assert found is not None, primary._plain()[-1500:]
            session = found.group(1)
            assert token not in primary._plain()

            primary.send("你好")
            primary.wait_for("已收到：你好")
            primary.send("批准")
            primary.wait_for("已收到：批准")
            shell = runtime.workspace / "screen-shell.txt"
            assert not shell.exists()
            report["checks"].append("the word 批准 without a pending approval was only a prompt and wrote nothing")

            primary.send("/shell printf y > screen-shell.txt")
            primary.wait_for("等待审批 shell printf y > screen-shell.txt")
            assert not shell.exists()
            primary.send("不要")
            primary.wait_for("先输入批准或拒绝")
            assert "已收到：不要" not in primary._plain()
            assert not shell.exists()
            primary.send("拒绝")
            primary.wait_for("approval_denied")
            assert not shell.exists()
            primary.send("/shell printf y > screen-shell.txt")
            primary.wait_count("等待审批 shell printf y > screen-shell.txt", 2)
            assert not shell.exists()
            primary.send("批准")
            primary.wait_for('"exit_code":0', timeout=40)
            until(lambda: shell.read_text() if shell.exists() else "", lambda value: value == "y", timeout=40)
            report["checks"].append("the screen required an explicit approval before the shell wrote its file, and a refusal had no effect")

            primary.send("/file screen-shell.txt")
            primary.wait_line("y")
            primary.send("/checkpoint screen-shell.txt")
            primary.wait_for("已保存")
            report["checks"].append("the screen read the shell output and saved a checkpoint")

            primary.send("/pty printf x > screen-term.txt; printf 'SCREEN_TERM_OK\\n'")
            primary.wait_for("SCREEN_TERM_OK", timeout=20)
            primary.wait_for("输入已接收")
            until(lambda: (runtime.workspace / "screen-term.txt").read_text() if (runtime.workspace / "screen-term.txt").exists() else "",
                  lambda value: value == "x")
            primary.send("/pty-size 100 40")
            primary.wait_for("终端 100 40")
            primary.send("/pty stty size")
            primary.wait_for("40 100")
            report["checks"].append("the screen showed terminal output, treated accepted input as distinct from command success, and observed resize")

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
            primary.wait_count("等待审批 MCP native_echo", 2)
            primary.send("批准")
            until(lambda: (runtime.workspace / "mcp-effect.txt").read_text() if (runtime.workspace / "mcp-effect.txt").exists() else "",
                  lambda value: value == "x", timeout=20)
            report["checks"].append("the screen denied an MCP call with no effect, then one approval wrote once")

            other = Screen(url, token, runtime.workspace, root / "agent")
            screens.append(other)
            other.start()
            other.wait_for("绑定:")
            other_found = MARKER.search(other._plain())
            assert other_found is not None and other_found.group(1) != session
            other.quit()
            screens.remove(other)
            terminals = runtime.client.get(f"/api/v1/sessions/{session}/terminals").json()["terminals"]
            assert len(terminals) == 1 and terminals[0]["phase"] == "running"
            servers = runtime.client.get(f"/api/v1/sessions/{session}/mcp").json()["servers"]
            assert len(servers) == 1 and servers[0]["phase"] == "ready"
            report["checks"].append("a second screen session stayed separate and did not stop the first session's terminal or MCP service")

            headers = runtime.attach(session)
            request_id = "cd" * 16
            parked = runtime.client.post(
                f"/api/v1/sessions/{session}/submissions", headers=headers,
                json={"request_id": request_id, "text": "画面仍在", "not_before_ms": int(time.time() * 1000) + 3_600_000}).json()
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
            report["checks"].append("leaving the screen kept the backend, the parked request, the terminal, and the MCP service")

            again = Screen(url, token, runtime.workspace, root / "agent", session)
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
