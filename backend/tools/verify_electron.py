"""Real Electron process against the current source backend.

The desktop launcher still expects one executable. This run points it at a
wrapper that execs the checkout's Python module, so the proof is not a frozen
package and not a Chrome stand-in.
"""

import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import httpx
from playwright.sync_api import expect, sync_playwright
from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, until

GUI = ROOT / "packages/gui"
PYTHON = ROOT / "backend/.venv/bin/python"
NODE = shutil.which("node") or ""
SECRET = re.compile(r"KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|^AWS_|^AZURE_|^GOOGLE_", re.I)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def child_env(updates: dict[str, str]) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not SECRET.search(key)}
    for name in ("AMAZME_PYTHON_URL", "AMAZME_PYTHON_TOKEN", "AMAZME_PYTHON_SESSION", "AMAZME_PYTHON_BACKEND"):
        env.pop(name, None)
    env.update(updates)
    return env


class ElectronRun:
    def __init__(self, root: Path, workspace: Path, wrapper: Path):
        self.root = root
        self.workspace = workspace
        self.wrapper = wrapper
        self.process: subprocess.Popen[str] | None = None
        self.opener: subprocess.Popen[str] | None = None
        self.stdout = ""
        self.stderr = ""
        self._lock = threading.Lock()
        self._io: list[threading.Thread] = []
        self.host_pid = 0
        self.origin = ""
        self.resource_before: dict[str, object] | None = None
        self.resource_report: dict[str, object] | None = None

    def start(self, port: int) -> None:
        import resource_census

        report = resource_census.collect()
        self.resource_before = report
        resource_census.admit(report, purpose="serve")
        env = child_env({
            "AMAZME_GUI_SMOKE": "1",
            "AMAZME_GUI_SMOKE_HOLD": "1",
            "AMAZME_GUI_SMOKE_DATA_DIR": str(self.root),
            "AMAZME_GUI_CWD": str(self.workspace),
            "AMAZME_PYTHON_BACKEND": str(self.wrapper),
            "AMAZME_GUI_READY_TIMEOUT_MS": "120000",
            "AMAZME_CODING_AGENT_DIR": str(self.root / "agent"),
        })
        if not NODE:
            raise RuntimeError("node is required to launch Electron")
        self.process = subprocess.Popen(
            [NODE, "dist/start.js", f"--remote-debugging-port={port}",
             "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*"],
            cwd=GUI, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        self._capture(self.process)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with self._lock:
                ready = "desktop host pid:" in self.stdout and "desktop smoke: http://127.0.0.1:" in self.stdout
            if ready:
                break
            if self.process.poll() is not None:
                raise RuntimeError(f"electron exited early\n{self.stdout}\n{self.stderr[-4000:]}")
            time.sleep(0.05)
        else:
            raise TimeoutError(f"electron did not become ready\n{self.stdout}\n{self.stderr[-4000:]}")
        with self._lock:
            captured = self.stdout
        self.host_pid = int(re.search(r"desktop host pid: (\d+)", captured).group(1))
        self.origin = re.search(r"desktop smoke: (http://127\.0\.0\.1:\d+)", captured).group(1)

    def open_second_window(self) -> None:
        assert self.process is not None
        self.opener = subprocess.Popen(
            [NODE, "dist/start.js", "--amazme-new-window"],
            cwd=GUI, env=child_env({
                "AMAZME_GUI_SMOKE": "1",
                "AMAZME_GUI_SMOKE_HOLD": "1",
                "AMAZME_GUI_SMOKE_DATA_DIR": str(self.root),
                "AMAZME_GUI_CWD": str(self.workspace),
                "AMAZME_PYTHON_BACKEND": str(self.wrapper),
                "AMAZME_GUI_READY_TIMEOUT_MS": "120000",
                "AMAZME_CODING_AGENT_DIR": str(self.root / "agent"),
            }),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        code = self.opener.wait(timeout=20)
        if code != 0:
            raise RuntimeError(f"second window launch exited {code}: {self.opener.stderr.read() if self.opener.stderr else ''}")
        until(lambda: "desktop window requested" in self._more_stdout(), bool, timeout=15)

    def _capture(self, process: subprocess.Popen[str]) -> None:
        def pump(stream, target: str) -> None:
            if stream is None:
                return
            for line in stream:
                with self._lock:
                    if target == "stdout":
                        self.stdout += line
                    else:
                        self.stderr += line

        for stream, target in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            thread = threading.Thread(target=pump, args=(stream, target), daemon=True)
            thread.start()
            self._io.append(thread)

    def _more_stdout(self) -> str:
        with self._lock:
            return self.stdout

    def quit(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=10)
            raise
        if self.host_pid and alive(self.host_pid):
            raise RuntimeError("source backend stayed up after Electron quit")

    def close(self) -> None:
        import resource_census
        try:
            if self.process is not None and self.process.poll() is None:
                try:
                    self.quit()
                except Exception:
                    if self.process.poll() is None:
                        os.killpg(self.process.pid, signal.SIGKILL)
                        self.process.wait(timeout=10)
            if self.opener is not None and self.opener.poll() is None:
                self.opener.kill()
        finally:
            try:
                report, processes = resource_census.scan()
                self.resource_report = resource_census.owned_after(
                    [self.root], report, processes, before=self.resource_before,
                )
                resource_census.record(report, purpose="serve", event="after", before=self.resource_before)
            except Exception as error:
                self.resource_report = {
                    "reclaimed": False, "owned_reclaimed": False, "global_reclaimed": False,
                    "scope": resource_census.SCOPE, "error": str(error), "deletion": "not_performed",
                    "note": resource_census.NOTE,
                }


def connected_pages(browser):
    found = []
    for page in product_pages(browser):
        try:
            if page.locator("#connection").inner_text(timeout=1000) == "已连接":
                found.append(page)
        except Exception:
            continue
    return found


def product_pages(browser):
    found = []
    for context in browser.contexts:
        for page in context.pages:
            if page.url.startswith("http://127.0.0.1:"):
                found.append(page)
    return found


def session_of(page) -> str:
    return page.url.split("session=")[1].split("&")[0] if "session=" in page.url else ""


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "electron-", 2)
    root = Path(tempfile.mkdtemp(prefix="electron-", dir=parent))
    workspace = root / "workspace"
    workspace.mkdir()
    (root / "agent").mkdir()
    wrapper = root / "amazme-backend"
    wrapper.write_text(f"#!/bin/sh\nexec {shlex.quote(str(PYTHON))} -m amazme_backend \"$@\"\n")
    wrapper.chmod(0o755)
    report: dict[str, object] = {"status": "running", "execution": "electron-source", "vm_created": False, "checks": []}
    runtime: ElectronRun | None = ElectronRun(root, workspace, wrapper)
    decoy = subprocess.Popen(["/bin/sleep", "600"])
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=240)
    try:
        with budget:
            port = free_port()
            runtime.start(port)
            token = (root / "python-profile" / "web.token").read_text().strip()
            with httpx.Client(base_url=runtime.origin, timeout=30, trust_env=False,
                               headers={"Authorization": f"Bearer {token}"}) as client:
                boot = client.get("/api/v1/bootstrap").json()
                report["identity"] = {"build_id": boot["build_id"], "url": runtime.origin, "host_pid": runtime.host_pid}
                fence = {"x-amazme-build": boot["build_id"], "x-amazme-epoch": str(boot["host_epoch"])}
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                    page = until(lambda: connected_pages(browser)[:1] or [None], lambda items: items[0] is not None, timeout=30)[0]
                    assert "Electron" in page.evaluate("() => navigator.userAgent")
                    session = until(lambda: session_of(page), lambda value: len(value) == 32, timeout=15)
                    errors: list[str] = []
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    page.locator("#terminal summary").click()
                    expect(page.locator("#terminal-state")).to_have_text("尚无终端，点击新建")
                    page.locator("#terminal-new").click()
                    expect(page.locator("#terminal-state")).to_have_text("运行中")
                    lost_ids: list[str] = []
                    lost_attempts = {"count": 0}

                    def fail_first_input(route) -> None:
                        request = route.request
                        lost_attempts["count"] += 1
                        body = request.post_data_json
                        if isinstance(body, dict) and isinstance(body.get("input_id"), str):
                            lost_ids.append(str(body["input_id"]))
                        if lost_attempts["count"] == 1:
                            route.fetch()
                            route.abort()
                            return
                        route.continue_()

                    page.route("**/terminals/**/input", fail_first_input)
                    page.locator("#terminal-input").fill("printf x >> electron-lost.txt")
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#error")).not_to_have_text("", timeout=15000)
                    until(lambda: (workspace / "electron-lost.txt").read_text() if (workspace / "electron-lost.txt").exists() else "",
                          lambda value: value == "x")
                    page.locator("#terminal-form button").first.click()
                    time.sleep(0.4)
                    assert (workspace / "electron-lost.txt").read_text() == "x"
                    assert len(lost_ids) >= 2 and lost_ids[0] == lost_ids[1]
                    page.unroute("**/terminals/**/input", fail_first_input)
                    report["checks"].append("electron page reused one terminal input after the first receipt was lost")
                    page.locator("#terminal-input").fill("printf x > electron-term.txt; printf 'ELECTRON_TERM_OK\\n'")
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#terminal-output")).to_contain_text("ELECTRON_TERM_OK")
                    expect(page.locator("#terminal-output .xterm")).to_be_visible()
                    until(lambda: (workspace / "electron-term.txt").read_text() if (workspace / "electron-term.txt").exists() else "",
                          lambda value: value == "x")
                    page.locator("#terminal-input").fill("printf '\\033[31mRED\\033[0m'")
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#terminal-output .xterm-fg-1")).to_be_visible(timeout=15000)
                    expect(page.locator("#terminal-output")).to_contain_text("RED")
                    report["checks"].append("electron page xterm DOM painted a red cell")
                    page.locator("#terminal-resize").click()
                    page.locator("#terminal-input").fill("stty size")
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#terminal-output")).to_contain_text("40 100")
                    page.reload()
                    expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                    assert session_of(page) == session
                    page.locator("#terminal summary").click()
                    expect(page.locator("#terminal-state")).to_have_text("运行中")
                    expect(page.locator("#terminal-output")).to_contain_text("ELECTRON_TERM_OK")
                    page.locator("#terminal-close").click()
                    expect(page.locator("#terminal-state")).to_contain_text("已退出")
                    report["checks"].append("electron page showed terminal output, observed resize, kept the terminal across reload, and explicit close exited it")

                    page.locator("#prompt").fill("/shell printf y > electron-shell.txt")
                    page.locator("#send").click()
                    page.locator("#approvals").get_by_role("button", name="批准", exact=True).click()
                    until(lambda: (workspace / "electron-shell.txt").read_text() if (workspace / "electron-shell.txt").exists() else "",
                          lambda value: value == "y", timeout=40)
                    report["checks"].append("electron page approval was required before the shell wrote its file")

                    page.locator("#files summary").click()
                    page.locator("#file-list").get_by_role("button", name="electron-shell.txt", exact=True).click()
                    expect(page.locator("#file-content")).to_have_value("y")
                    page.locator("#checkpoint-save").click()
                    expect(page.locator("#file-diff")).to_contain_text("已保存")
                    report["checks"].append("electron page saved a checkpoint for the shell output")

                    command = shlex.join([str(PYTHON), str(ROOT / "backend/tools/mcp_probe_server.py"),
                                          "--workspace", str(workspace)])
                    page.locator("#mcp summary").click()
                    page.locator("#mcp-command").fill(command)
                    page.locator("#mcp-form button").click()
                    expect(page.locator("#mcp-state")).to_contain_text("已连接", timeout=20000)
                    page.get_by_role("button", name="native_echo", exact=True).click()
                    page.locator("#mcp-arguments").fill('{"text":"denied","numbers":[1]}')
                    page.locator("#mcp-request").click()
                    page.get_by_role("button", name="拒绝调用", exact=True).click()
                    expect(page.locator("#mcp-result")).to_contain_text("denied")
                    assert not (workspace / "mcp-effect.txt").exists()
                    page.locator("#mcp-arguments").fill('{"text":"x","numbers":[2,3]}')
                    page.locator("#mcp-request").click()
                    page.get_by_role("button", name="批准调用", exact=True).click()
                    until(lambda: (workspace / "mcp-effect.txt").read_text() if (workspace / "mcp-effect.txt").exists() else "",
                          lambda value: value == "x", timeout=20)
                    report["checks"].append("electron page denied an MCP call with no effect, then one approval wrote once")

                    runtime.open_second_window()
                    pages = until(lambda: connected_pages(browser),
                                  lambda items: len(items) == 2 and len({session_of(item) for item in items}) == 2, timeout=30)
                    other = next(item for item in pages if session_of(item) != session)
                    assert session_of(other) != session
                    attachment = client.post(f"/api/v1/sessions/{session}/attachments", headers=fence).json()["attachment_id"]
                    request_id = "ab" * 16
                    parked = client.post(f"/api/v1/sessions/{session}/submissions", headers={**fence, "x-amazme-attachment": attachment},
                                         json={"request_id": request_id, "text": "窗口仍在", "not_before_ms": int(time.time() * 1000) + 3_600_000}).json()
                    assert parked["status"] == "waiting_time" and parked["cancel_requested"] is False
                    other.close()
                    until(lambda: [session_of(item) for item in product_pages(browser)], lambda items: items == [session], timeout=15)
                    still = client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
                    assert still["status"] == "waiting_time" and still["cancel_requested"] is False
                    servers = client.get(f"/api/v1/sessions/{session}/mcp").json()["servers"]
                    assert servers and servers[0]["phase"] == "ready"
                    page.close()
                    until(lambda: product_pages(browser), lambda items: items == [], timeout=15)
                    after = client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
                    assert after["status"] == "waiting_time" and after["cancel_requested"] is False
                    assert alive(runtime.host_pid)
                    assert client.get("/").status_code == 200
                    report["checks"].append("closing either Electron window kept the source backend, the other session, the parked request, and the MCP service")
                    assert not errors, errors
                    report["page_errors"] = errors
                    report["user_agent"] = "Electron"
            runtime.quit()
            assert not alive(runtime.host_pid)
            assert alive(decoy.pid or -1)
            report["checks"].append("explicit Electron quit stopped the source backend it started and left an unrelated process")
            report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        report["budget"] = budget.snapshot()
        if decoy.poll() is None:
            decoy.kill()
            decoy.wait(timeout=5)
        pending = apply_cleanup(runtime, report)
        (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(root / "report.json")
        raise_pending(pending)


if __name__ == "__main__":
    main()
