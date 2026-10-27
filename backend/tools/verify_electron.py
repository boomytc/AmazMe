"""Exercise the Electron source launcher or one specified frozen app with owned cleanup."""

import argparse
import hashlib
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
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import psutil
from playwright.sync_api import expect, sync_playwright
from resource_budget import ResourceBudget, allocated_bytes
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


def stop_owned_profile(root: Path, owned: list[psutil.Process]) -> None:
    """Stop only identities observed in the launched backend's process tree."""
    parent = (ROOT / ".artifacts/native").resolve()
    if root.is_symlink() or root.resolve().parent != parent or not root.name.startswith(("electron-", "desktop-restart-")):
        raise RuntimeError("refusing to stop processes outside an owned Electron test directory")
    processes: dict[int, psutil.Process] = {}
    for process in owned:
        try:
            if not process.is_running():
                continue
            processes[process.pid] = process
            for child in process.children(recursive=True):
                processes[child.pid] = child
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    for process in processes.values():
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive_processes = psutil.wait_procs(list(processes.values()), timeout=5)
    for process in alive_processes:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass
    _, alive_processes = psutil.wait_procs(alive_processes, timeout=5)
    if alive_processes:
        raise RuntimeError("owned Electron test profile still has running processes")


class ElectronRun:
    def __init__(self, root: Path, workspace: Path, wrapper: Path, app: Path | None = None):
        self.app = app
        self.launcher = [str(app / "Contents/MacOS/AmazMe")] if app else [NODE, "dist/start.js"]
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
        self.owned: list[psutil.Process] = []
        self.origin = ""
        self.resource_before: dict[str, object] | None = None
        self.resource_report: dict[str, object] | None = None

    def start(self, port: int) -> None:
        import resource_census

        report = resource_census.collect()
        self.resource_before = report
        resource_census.admit(report, purpose="serve")
        if not NODE:
            raise RuntimeError("node is required to launch Electron")
        if self.app is None:
            lock_fd = int(os.environ["AMAZME_WORKSPACE_LOCK_FD"])
            checked = subprocess.run([NODE, str(ROOT / "scripts/dev-desktop.mjs"), "--check-build"],
                                     cwd=ROOT, capture_output=True, text=True, check=False, pass_fds=(lock_fd,))
            if checked.returncode:
                raise RuntimeError(checked.stderr.strip() or "desktop build check failed")
        env = child_env({
            "AMAZME_GUI_SMOKE": "1",
            "AMAZME_GUI_SMOKE_HOLD": "1",
            "AMAZME_GUI_SMOKE_DATA_DIR": str(self.root),
            "AMAZME_GUI_CWD": str(self.workspace),
            "AMAZME_PYTHON_BACKEND": str(self.wrapper),
            "AMAZME_GUI_READY_TIMEOUT_MS": "120000",
            "AMAZME_CODING_AGENT_DIR": str(self.root / "agent"),
        })
        self.process = subprocess.Popen(
            [*self.launcher, f"--remote-debugging-port={port}",
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
        self.origin = re.search(r"desktop smoke: (http://127\.0\.0\.1:\d+)", captured).group(1)

    def open_second_window(self) -> None:
        assert self.process is not None
        self.opener = subprocess.Popen(
            [*self.launcher, "--amazme-new-window"],
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
                        match = re.fullmatch(r"desktop host pid: (\d+)\s*", line)
                        if match:
                            self.host_pid = int(match.group(1))
                            try:
                                self.owned.append(psutil.Process(self.host_pid))
                            except psutil.NoSuchProcess:
                                pass
                    else:
                        self.stderr += line

        for stream, target in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            thread = threading.Thread(target=pump, args=(stream, target), daemon=True)
            thread.start()
            self._io.append(thread)

    def _more_stdout(self) -> str:
        with self._lock:
            return self.stdout

    def _remember_descendants(self) -> None:
        with self._lock:
            owned = list(self.owned)
        for process in owned:
            try:
                children = process.children(recursive=True)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            with self._lock:
                self.owned.extend(children)

    def quit(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self._remember_descendants()
        self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=10)
            raise
        if self.host_pid and alive(self.host_pid):
            raise RuntimeError("owned backend stayed up after Electron quit")

    def close(self) -> None:
        import resource_census
        try:
            # Save descendants before graceful shutdown can orphan them.
            self._remember_descendants()
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
                stop_owned_profile(self.root, self.owned)
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
            if page.locator("#connection-status").get_attribute("data-state", timeout=1000) == "connected":
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
    return page.evaluate("new URL(location.href).searchParams.get('session') || ''")


@contextmanager
def http_mcp_fixture(marker, *, bearer_token=""):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def authorized(self):
            if bearer_token and self.headers.get("Authorization") != "Bearer " + bearer_token:
                self.send_error(401, "Bearer token required")
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            self.send_error(405)

        def do_DELETE(self):
            if not self.authorized():
                return
            self.send_response(204)
            self.end_headers()

        def do_POST(self):
            if not self.authorized():
                return
            value = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            method, identity = value.get("method"), value.get("id")
            if identity is None:
                self.send_response(202)
                self.end_headers()
                return
            if method == "initialize":
                result = {"protocolVersion": "2025-11-25", "serverInfo": {"name": "frozen-fixture", "version": "1"}, "capabilities": {"tools": {}}}
            elif method == "tools/list":
                result = {"tools": [{"name": "native_echo", "description": "Fixture echo", "inputSchema": {"type": "object"}}]}
            else:
                with marker.open("a") as output:
                    output.write("x")
                result = {"content": [{"type": "text", "text": "FROZEN_HTTP_MCP_OK"}]}
            raw = json.dumps({"jsonrpc": "2.0", "id": identity, "result": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/mcp"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, help="One current local app with its embedded backend")
    args = parser.parse_args()
    app = args.app.resolve() if args.app else None
    if app is not None and not (app / "Contents/MacOS/AmazMe").is_file():
        raise SystemExit("candidate app executable is missing")
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "electron-", 2)
    # The large-image check needs room within the existing artifact cap.
    if allocated_bytes([ROOT / ".artifacts"]) + 64 * 1024**2 > 512 * 1024**2:
        release_named_slot(parent, "electron-", 1)
    root = Path(tempfile.mkdtemp(prefix="electron-", dir=parent))
    workspace = root / "workspace"
    workspace.mkdir()
    (root / "agent").mkdir()
    wrapper = root / "amazme-backend"
    wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(str(PYTHON))} -m amazme_backend "$@"\n')
    wrapper.chmod(0o755)
    if app is not None:
        wrapper = app / "Contents/Resources/amazme-backend/amazme-backend"
    runtime = ElectronRun(root, workspace, wrapper, app)
    report = {"status": "running", "execution": "electron-frozen" if app else "electron-source",
              "provider": "faux", "external_accounts_tested": False, "checks": []}
    decoy = subprocess.Popen(["/bin/sleep", "600"])
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=240)
    try:
        with budget:
            port = free_port()
            runtime.start(port)
            token = (root / "python-profile/web.token").read_text().strip()
            with httpx.Client(base_url=runtime.origin, timeout=30, trust_env=False,
                              headers={"Authorization": "Bearer " + token}) as client:
                boot = client.get("/api/v1/bootstrap").json()
                report["identity"] = {name: boot[name] for name in ("build_id", "profile_id", "host_epoch")}
                fence = {"x-amazme-build": boot["build_id"], "x-amazme-epoch": str(boot["host_epoch"])}
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                    page = until(lambda: product_pages(browser), lambda pages: bool(pages), timeout=30)[0]
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    expect(page.locator("#connection-status")).to_have_attribute("data-state", "connected", timeout=30000)
                    expect(page.locator("#new-chat")).to_be_enabled(timeout=30000)
                    if not session_of(page):
                        page.locator("#new-chat").click()
                    until(lambda: session_of(page), bool, timeout=30)
                    expect(page.locator("#composer")).to_be_visible(timeout=30000)
                    session = session_of(page)
                    expect(page.locator("#prompt")).to_be_enabled(timeout=30000)
                    assert page.locator("#model-form").count() == 0
                    page.locator("#prompt").fill("界面恢复核对")
                    page.locator("#primary").click()
                    expect(page.locator("#transcript")).to_contain_text("已收到：界面恢复核对", timeout=30000)
                    report["checks"].append("original sidebar, conversation, composer and faux model response")

                    marker = workspace / "mcp-effect.txt"
                    with http_mcp_fixture(marker) as url:
                        binding = client.post(f"/api/v1/sessions/{session}/attachments", headers=fence).json()["attachment_id"]
                        headers = {**fence, "x-amazme-attachment": binding}
                        server_id = "cd" * 16
                        connected = client.post(f"/api/v1/sessions/{session}/mcp", headers=headers, json={"server_id": server_id, "command": url, "http": {"url": url}})
                        connected.raise_for_status()
                        assert connected.json()["phase"] == "ready"
                        alias = "mcp_" + hashlib.sha256((server_id + "\nnative_echo").encode()).hexdigest()[:20]
                        request_id = "ef" * 16
                        submitted = client.post(f"/api/v1/sessions/{session}/submissions", headers=headers, json={"request_id": request_id, "text": "/mcp " + json.dumps({"alias": alias, "arguments": {}})})
                        submitted.raise_for_status()
                        approval = page.locator('[data-action="approval:approve"]')
                        expect(approval).to_be_visible(timeout=30000)
                        assert not marker.exists()
                        approval.click()
                        until(lambda: marker.read_text() if marker.exists() else "", lambda value: value == "x", timeout=20)
                        expect(page.locator("#transcript")).to_contain_text("FROZEN_HTTP_MCP_OK", timeout=30000)
                        repeated = client.post(f"/api/v1/sessions/{session}/submissions", headers=headers, json={"request_id": request_id, "text": "/mcp " + json.dumps({"alias": alias, "arguments": {}})})
                        repeated.raise_for_status()
                        assert marker.read_text() == "x"
                        closed = client.post(f"/api/v1/sessions/{session}/mcp/{server_id}/cancel", headers=headers)
                        closed.raise_for_status()
                        assert closed.json()["clean"] is True
                        report["checks"].append("embedded HTTP SDK loaded, original approval controls gated a fixture MCP call, same ID wrote once")

                    page.locator('[data-action="dock:toggle"]').click()
                    page.locator('#dock-tabs [data-tab="terminal"]').click()
                    terminal = page.locator("#dock-body .xterm")
                    expect(terminal).to_be_visible(timeout=20000)
                    terminal.click()
                    page.keyboard.type("printf '%s' '你好🙂' > electron-input.txt")
                    page.keyboard.press("Enter")
                    until(lambda: (workspace / "electron-input.txt").read_text() if (workspace / "electron-input.txt").exists() else "", lambda text: text == "你好🙂", timeout=20)
                    page.keyboard.type("sleep 30")
                    page.keyboard.press("Enter")
                    time.sleep(.2)
                    page.keyboard.press("Control+c")
                    page.keyboard.type("printf ok > electron-interrupt.txt")
                    page.keyboard.press("Enter")
                    until(lambda: (workspace / "electron-interrupt.txt").exists(), bool, timeout=10)
                    page.set_viewport_size({"width": 1280, "height": 900})
                    page.screenshot(path=str(root / "original-client.png"), full_page=True)
                    report["screenshot"] = str(root / "original-client.png")
                    report["checks"].append("xterm fast ordered input, Chinese/emoji, Ctrl-C and resize in the original dock")

                    # A valid PNG bigger than sessionStorage's quota exercises the real IndexedDB path.
                    from PIL import Image
                    image = root / "large.png"
                    Image.frombytes("RGB", (1536, 1536), os.urandom(1536 * 1536 * 3)).save(image)
                    assert 5 * 1024**2 < image.stat().st_size < 8 * 1024**2
                    submitted = []
                    def lose_first_ack(route):
                        submitted.append(route.request.post_data_json["request_id"])
                        if len(submitted) == 1:
                            response = route.fetch(headers=route.request.all_headers(), timeout=30000)
                            report["lost_ack_response"] = {"status": response.status}
                            if response.status != 202:
                                error = response.json()
                                report["lost_ack_response"]["code"] = error.get("code", "invalid_response")
                                route.fulfill(response=response)
                                raise AssertionError(str(report["lost_ack_response"]))
                            route.abort("failed")
                        else:
                            route.continue_()
                    page.route("**/api/v1/sessions/*/submissions", lose_first_ack)
                    page.locator("#file-input").set_input_files(image)
                    page.locator("#prompt").fill("图片原编号核对")
                    page.locator("#primary").click()
                    retry = page.locator('[data-action="write:retry-submit"]')
                    expect(retry).to_be_visible(timeout=30000)
                    def first_ack():
                        page.wait_for_timeout(25)
                        return report.get("lost_ack_response")
                    until(first_ack, bool, timeout=40)
                    assert report["lost_ack_response"]["status"] == 202
                    stored = page.evaluate("Object.entries(sessionStorage).filter(([key]) => key.startsWith('amazme:write:') && key.endsWith(':submission')).map(([key, value]) => ({key, bytes: value.length, payload: JSON.parse(value).payload}))")
                    assert len(stored) == 1 and stored[0]["bytes"] < 1024 and stored[0]["payload"]
                    page.reload()
                    expect(page.locator("#prompt")).to_be_enabled(timeout=30000)
                    retry = page.locator('[data-action="write:retry-submit"]')
                    expect(retry).to_be_visible()
                    retry.click()
                    expect(retry).to_have_count(0, timeout=30000)
                    assert len(submitted) == 2 and submitted[0] == submitted[1]
                    requests = client.get(f"/api/v1/sessions/{session}/snapshot").json()["requests"]
                    assert len([row for row in requests if row["request_id"] == submitted[0]]) == 1
                    report["checks"].append("large PNG body persisted in IndexedDB, lost ACK survived reload, explicit retry retained its ID")

                    runtime.open_second_window()
                    pages = until(lambda: connected_pages(browser), lambda rows: len(rows) == 2 and len({session_of(item) for item in rows}) == 2, timeout=30)
                    other = next(item for item in pages if session_of(item) != session)
                    binding = client.post(f"/api/v1/sessions/{session}/attachments", headers=fence).json()["attachment_id"]
                    request_id = "ab" * 16
                    parked = client.post(f"/api/v1/sessions/{session}/submissions", headers={**fence, "x-amazme-attachment": binding}, json={"request_id": request_id, "text": "窗口任务保留", "not_before_ms": int(time.time() * 1000) + 3600000})
                    parked.raise_for_status()
                    other.close()
                    page.close()
                    until(lambda: product_pages(browser), lambda rows: not rows, timeout=15)
                    receipt = client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
                    assert receipt["status"] == "waiting_time" and not receipt["cancel_requested"]
                    assert alive(runtime.host_pid) and not errors, errors
                    report["page_errors"] = errors
                    report["checks"].append("two windows keep independent sessions; closing both windows preserves accepted work and the backend")
                    # Smoke mode declines the busy-quit consent dialog. End these owned
                    # fixtures explicitly before checking the idle application's real quit path.
                    cancelled = client.post(f"/api/v1/sessions/{session}/requests/{request_id}/cancel",
                        headers={**fence, "x-amazme-attachment": binding})
                    cancelled.raise_for_status()
                    until(lambda: client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json(),
                          lambda value: value["status"] == "cancelled", timeout=30)
                    terminals = client.get(f"/api/v1/sessions/{session}/terminals").json()["terminals"]
                    for terminal in terminals:
                        if terminal["phase"] == "running":
                            closed = client.post(f'/api/v1/sessions/{session}/terminals/{terminal["terminal_id"]}/close',
                                headers={**fence, "x-amazme-attachment": binding})
                            closed.raise_for_status()
                            assert closed.json()["clean"]
                    control = (runtime.root / "python-profile/control.token").read_text().strip()
                    until(lambda: client.get("/control/desktop/activity", headers={"Authorization": "Bearer " + control}).json(),
                          lambda value: value["active"] is False, timeout=30)
                    report["checks"].append("explicit fixture cancellation settled the waiting request and closed its PTY before idle quit")
            runtime.quit()
            assert not alive(runtime.host_pid) and alive(decoy.pid)
            report["checks"].append("explicit quit stops only its owned backend")
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
    from workspace_lock import run_locked

    run_locked(main)
