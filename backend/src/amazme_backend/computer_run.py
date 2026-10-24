"""Python port of the existing CUA bundle, private socket and capture-bound MCP path."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import plistlib
import secrets
import select
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psutil
from pydantic import JsonValue, TypeAdapter

from .contracts import (
    BackendError,
    ComputerClick,
    ComputerElement,
    ComputerHotkey,
    ComputerKey,
    ComputerMutation,
    ComputerPixel,
    ComputerScroll,
    ComputerText,
    ComputerWindow,
)
from .native_execution import tool_environment

RECORD = TypeAdapter(dict[str, JsonValue])
PIN = {"version": "0.38.0-amazme.2", "sourceCommit": "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19",
       "patchSha256": "7b00cf51a49ec367ff1b2d92eaf40ecdd376a762fca2699d74471ff1d0a8d91d"}
APP = "AmazMe Computer Use.app"
IDENTITY = "com.amazme.computer-use"


def installation() -> tuple[Path, Path]:
    if sys.platform != "darwin":
        raise BackendError("computer_requires_macos")
    root = Path.home() / "Library/Application Support/AmazMe/ComputerUse" / PIN["version"]
    if not root.exists():
        raise BackendError("computer_runtime_not_installed")
    if root.is_symlink() or not root.is_dir():
        raise BackendError("computer_runtime_invalid")
    manifest = RECORD.validate_json((root / "manifest.json").read_bytes())
    expected = {**PIN, "platform": "darwin", "arch": "arm64" if platform.machine() == "arm64" else "x64"}
    app = root / APP
    binary, host, plist = app / "Contents/MacOS/cua-driver", app / "Contents/MacOS/amazme-computer-use", app / "Contents/Info.plist"
    for name, path in (("binarySha256", binary), ("hostSha256", host), ("plistSha256", plist)):
        if not path.resolve().is_relative_to(root.resolve()):
            raise BackendError("computer_runtime_invalid")
        expected[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if any(manifest.get(name) != value for name, value in expected.items()):
        raise BackendError("computer_runtime_changed")
    props = plistlib.loads(plist.read_bytes())
    if any(props.get(name) != value for name, value in {
        "CFBundleIdentifier": IDENTITY, "CFBundleExecutable": "amazme-computer-use",
        "AmazMeRuntimeVersion": PIN["version"], "CFBundleShortVersionString": "0.38.0", "CFBundleVersion": "4",
    }.items()):
        raise BackendError("computer_runtime_changed")
    checked = subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
                             capture_output=True, timeout=10, env=tool_environment())
    if checked.returncode or not os.access(binary, os.X_OK) or not os.access(host, os.X_OK):
        raise BackendError("computer_runtime_invalid")
    return app, binary


def environment() -> dict[str, str]:
    env = tool_environment()
    env.update({"CUA_DRIVER_RS_TELEMETRY_ENABLED": "false", "CUA_TELEMETRY_ENABLED": "false"})
    return env


def launch_arguments(app: Path, env: dict[str, str]) -> list[str]:
    return ["/usr/bin/open", "-n", "-g", "-W", "-a", str(app),
            *(part for key, value in env.items() for part in ("--env", f"{key}={value}"))]


def owned_processes(app: Path, marker: str) -> list[psutil.Process]:
    executables = {(app / "Contents/MacOS" / name).resolve() for name in ("cua-driver", "amazme-computer-use")}
    found: list[psutil.Process] = []
    for process in psutil.process_iter():
        try:
            if marker in process.cmdline() and Path(process.exe()).resolve() in executables:
                process.create_time()
                found.append(process)
        except (psutil.Error, OSError):
            continue
    return found


def permissions(app: Path, directory: Path) -> dict[str, JsonValue]:
    output = directory / ("permissions-" + secrets.token_hex(8) + ".json")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    env = environment()
    probe = subprocess.Popen([*launch_arguments(app, env), "--stdout", str(output), "--stderr", "/dev/null",
                              "--args", "check-permissions"], env=env, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if output.stat().st_size:
                report = RECORD.validate_json(output.read_bytes())
                if (type(report.get("accessibility")) is bool and type(report.get("screen_recording")) is bool
                        and report.get("host_bundle_id") == IDENTITY):
                    return report
                raise BackendError("computer_permission_report")
            if probe.poll() is not None:
                break
            time.sleep(0.025)
        raise BackendError("computer_permission_report")
    finally:
        # A private stdout identifies this probe even when another session uses the same app.
        owners = subprocess.run(["/usr/sbin/lsof", "-t", "-a", "-d", "1", str(output)],
                                capture_output=True, text=True, timeout=2)
        pids = {int(line) for line in owners.stdout.splitlines() if line.isdecimal()}
        for pid in pids:
            try:
                process = psutil.Process(pid)
                if (Path(process.exe()).resolve() == (app / "Contents/MacOS/amazme-computer-use").resolve()
                        and process.cmdline()[-1:] == ["check-permissions"]):
                    process.kill()
                    process.wait(2)
            except psutil.NoSuchProcess:
                pass
        if probe.poll() is None:
            probe.terminate()
        try:
            probe.wait(2)
        except subprocess.TimeoutExpired:
            probe.kill()
            probe.wait(2)


class ComputerDriver:
    def __init__(self, app: Path, binary: Path, directory: Path):
        self.app, self.binary, self.directory = app, binary, directory
        self.process: subprocess.Popen[bytes] | None = None
        self.host: subprocess.Popen[bytes] | None = None
        self.lifetime: int | None = None
        self.children: list[psutil.Process] = []
        self.hello: dict[str, object] = {}
        self.sequence = 0
        self.buffer = bytearray()
        self.tools: dict[str, dict[str, JsonValue]] = {}
        self.capture_id, self.driver_capture = "", ""
        self.target: ComputerWindow | None = None
        self.snapshot_id = ""
        self.elements: list[dict[str, JsonValue]] = []
        self.session = "amazme-" + directory.name

    @property
    def alive(self) -> bool:
        return self.process is None or self.process.poll() is None

    def send(self, payload: dict[str, JsonValue]) -> None:
        if self.process is None or self.process.stdin is None:
            raise BackendError("computer_driver_lost")
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        self.process.stdin.flush()

    def rpc(self, method: str, params: dict[str, JsonValue]) -> dict[str, JsonValue]:
        self.sequence += 1
        identity = self.sequence
        self.send({"jsonrpc": "2.0", "id": identity, "method": method, "params": params})
        if self.process is None or self.process.stdout is None:
            raise BackendError("computer_driver_lost")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                line, _, tail = self.buffer.partition(b"\n")
                self.buffer[:] = tail
                reply = RECORD.validate_json(line)
                if "method" in reply:
                    if "id" in reply:
                        self.send({"jsonrpc": "2.0", "id": reply["id"], "error": {"code": -32601, "message": "unsupported"}})
                    continue
                if reply.get("id") != identity or "error" in reply:
                    raise BackendError("computer_driver_protocol")
                return RECORD.validate_python(reply.get("result"))
            ready, _, _ = select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                break
            self.buffer.extend(data)
            if len(self.buffer) > 64 * 1024 * 1024:
                raise BackendError("computer_driver_limit")
        raise BackendError("computer_driver_lost")

    def connect(self) -> None:
        env = environment()
        socket, lifetime = self.directory / "driver.sock", self.directory / "lifetime"
        os.mkfifo(lifetime, 0o600)
        self.lifetime = os.open(lifetime, os.O_RDWR | os.O_NOFOLLOW)
        self.host = subprocess.Popen([*launch_arguments(self.app, env), "--stdin", str(lifetime),
            "--stdout", "/dev/null", "--stderr", "/dev/null", "--args", "serve", "--socket", str(socket)],
            env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while not socket.exists():
            if self.host.poll() is not None or time.monotonic() >= deadline:
                raise BackendError("computer_host_start_failed")
            time.sleep(0.025)
        if not stat.S_ISSOCK(socket.lstat().st_mode):
            raise BackendError("computer_host_start_failed")
        self.children = owned_processes(self.app, str(socket))
        if not self.children:
            raise BackendError("computer_owner_missing")
        self.process = subprocess.Popen([str(self.binary), "mcp", "--embedded", "--socket", str(socket),
            "--host-bundle-id", IDENTITY], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "AmazMe computer-use", "version": "0.1.0"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        result = self.rpc("tools/list", {})
        advertised = result.get("tools", [])
        if not isinstance(advertised, list):
            raise BackendError("computer_driver_protocol")
        for raw in advertised:
            tool = RECORD.validate_python(raw)
            name = tool.get("name")
            if isinstance(name, str):
                self.tools[name] = RECORD.validate_python(tool.get("inputSchema"))
        if not {"get_desktop_state", "click"} <= self.tools.keys():
            raise BackendError("computer_driver_protocol")

    def call(self, name: str, arguments: dict[str, JsonValue]) -> dict[str, JsonValue]:
        schema = self.tools.get(name)
        if schema is None:
            raise BackendError("computer_tool_missing")
        properties = RECORD.validate_python(schema.get("properties", {}))
        if "session" in properties:
            arguments["session"] = self.session
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        data = RECORD.validate_python(result.get("structuredContent", {}))
        content = result.get("content", [])
        if not isinstance(content, list):
            raise BackendError("computer_driver_protocol")
        if not data:
            for part in content:
                entry = RECORD.validate_python(part)
                if entry.get("type") == "text" and isinstance(entry.get("text"), str):
                    data = RECORD.validate_json(str(entry["text"]))
                    break
        if result.get("isError") or data.get("success") is False or data.get("error"):
            raise BackendError("computer_rejected")
        return {"data": data, "content": content}

    def request(self, payload: dict[str, object]) -> dict[str, object]:
        try:
            return self._request(payload)
        except (OSError, ValueError, KeyError) as exc:
            raise BackendError("computer_driver_lost") from exc

    def _request(self, payload: dict[str, object]) -> dict[str, object]:
        if payload.get("op") == "permissions":
            report = permissions(self.app, self.directory)
            self.hello.update(accessibility=report["accessibility"], screen=report["screen_recording"])
            return {"accessibility": report["accessibility"], "screen": report["screen_recording"]}
        if payload.get("op") == "inspect":
            name = "list_apps" if payload.get("action") == "apps" else "list_windows"
            pid = payload.get("pid")
            return {"data": self.call(name, {"pid": pid} if isinstance(pid, int) else {})["data"]}
        if payload.get("op") == "observe":
            self.capture_id, self.driver_capture = "", ""
            self.target = ComputerWindow.model_validate(payload["target"]) if payload.get("target") else None
            self.elements = []
            # CUA records the resize transform in capture_id. Keep RGBA PNGs within the model's 8 MiB image budget.
            if self.target:
                tool = "get_window_state"
                fields = RECORD.validate_python(self.tools.get(tool, {}).get("properties", {}))
                args: dict[str, JsonValue] = {**self.target.model_dump(), "include_accessibility_tree": True,
                    "include_screenshot": True, "max_elements": 500, "max_image_dimension": 1400}
                if "tree_format" in fields:
                    args["tree_format"] = "both"
            else:
                tool = "get_desktop_state"
                args = {"max_image_dimension": 1400}
            result = self.call(tool, args)
            data = RECORD.validate_python(result["data"])
            if self.target and (data.get("pid") != self.target.pid or data.get("window_id") != self.target.window_id):
                raise BackendError("computer_target_mismatch")
            content = result["content"]
            if not isinstance(content, list):
                raise BackendError("computer_driver_protocol")
            empty_image: dict[str, JsonValue] = {}
            image = next((RECORD.validate_python(part) for part in content
                          if isinstance(part, dict) and part.get("type") == "image"), empty_image)
            encoded = image.get("data")
            capture = data.get("capture_id")
            if (not isinstance(encoded, str) or len(encoded) > 48 * 1024 * 1024
                    or image.get("mimeType") != "image/png" or not isinstance(capture, str) or not capture
                    or data.get("screenshot_frame_valid") is False):
                raise BackendError("computer_capture_invalid")
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n":
                raise BackendError("computer_capture_invalid")
            width, height = int.from_bytes(raw[16:20]), int.from_bytes(raw[20:24])
            if (not width or not height or width * height > 40000000
                    or data.get("screenshot_width") != width or data.get("screenshot_height") != height):
                raise BackendError("computer_capture_invalid")
            # CUA normalizes PNG orientation and maps screenshot pixels to Retina screen points itself.
            self.hello.update(raw_width=width, raw_height=height, orientation=1, scale=1)
            self.capture_id, self.driver_capture = str(payload["capture_id"]), capture
            self.snapshot_id = str(data.get("snapshot_id") or "")
            self.elements = TypeAdapter(list[dict[str, JsonValue]]).validate_python(data.get("elements", []))[:500]
            return {"op": "capture", "capture_id": self.capture_id, "image_base64": encoded,
                    "snapshot_id": self.snapshot_id, "elements": self.elements,
                    "tree": str(data.get("tree_markdown") or "")[:20000]}
        if payload.get("op") != "act" or payload.get("capture_id") != self.capture_id or not self.driver_capture:
            return {"op": "rejected", "error": "computer_stale"}
        value = ComputerMutation.model_validate({key: payload[key] for key in ("capture_id", "action", "target", "delivery_mode")})
        if value.target != self.target:
            return {"op": "rejected", "error": "computer_target_mismatch"}
        try:
            tool, args = self.plan(value)
        except BackendError as exc:
            return {"op": "rejected", "error": exc.code}
        self.capture_id, self.driver_capture = "", ""
        self.call(tool, args)
        return {"op": "acted"}

    def plan(self, value: ComputerMutation) -> tuple[str, dict[str, JsonValue]]:
        action = value.action
        tool = "click" if isinstance(action, ComputerClick) else action.action
        fields = RECORD.validate_python(self.tools.get(tool, {}).get("properties", {}))
        if "delivery_mode" not in fields:
            raise BackendError("computer_driver_protocol")
        args: dict[str, JsonValue] = {"delivery_mode": value.delivery_mode}
        if "target" in fields:
            args["target"] = {"kind": "window", **value.target.model_dump()} if value.target else {"kind": "desktop", "display_id": "primary"}
        elif value.target and {"pid", "window_id"} <= fields.keys():
            args.update(value.target.model_dump())
        else:
            raise BackendError("computer_driver_protocol")
        token = action.point.element_token if isinstance(action, ComputerClick) and isinstance(action.point, ComputerElement) else (
            action.element_token if isinstance(action, ComputerText) else "")
        if token:
            element = next((item for item in self.elements if item.get("element_token") == token), None)
            if (value.target is None or not self.snapshot_id or not token.startswith(self.snapshot_id + ":")
                    or element is None or element.get("enabled") is False or element.get("visible") is False
                    or element.get("offscreen") is True):
                raise BackendError("computer_element_stale")
            if isinstance(action, ComputerText):
                role = str(element.get("role", "")).lower().removeprefix("ax")
                if role not in {"textfield", "textarea", "searchfield", "securetextfield", "edit", "entry", "text", "passwordtext"} and not (
                        action.action == "set_value" and role in {"popupbutton", "combobox", "menubutton"}):
                    raise BackendError("computer_text_target")
            args["element_token"] = token
        if isinstance(action, ComputerClick):
            if isinstance(action.point, ComputerPixel):
                args.update(x=action.point.x, y=action.point.y, capture_id=self.driver_capture)
            if action.action == "double_click":
                args["count"] = 2
            elif action.action == "right_click":
                args["button"] = "right"
        elif isinstance(action, ComputerText):
            args["value" if action.action == "set_value" else "text"] = action.text
        elif isinstance(action, ComputerKey):
            args["key"] = action.key
        elif isinstance(action, ComputerHotkey):
            args["keys"] = list(action.keys)
        elif isinstance(action, ComputerScroll):
            args.update(x=action.x, y=action.y, direction=action.direction, amount=action.amount)
        else:
            args.update(from_x=action.x, from_y=action.y, to_x=action.to_x, to_y=action.to_y)
        if not args.keys() <= fields.keys():
            raise BackendError("computer_driver_protocol")
        return tool, args

    def stop(self) -> int | None:
        if self.lifetime is not None:
            os.close(self.lifetime)
            self.lifetime = None
        if self.process is not None:
            if self.process.stdin is not None and not self.process.stdin.closed:
                self.process.stdin.close()
            try:
                self.process.wait(2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(2)
            if self.process.stdout is not None:
                self.process.stdout.close()
        children = self.children or owned_processes(self.app, str(self.directory / "driver.sock"))
        _, alive = psutil.wait_procs(children, timeout=2)
        for child in alive:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(alive, timeout=2)
        if alive:
            return None
        if self.host is not None:
            try:
                self.host.wait(2)
            except subprocess.TimeoutExpired:
                self.host.terminate()
                self.host.wait(2)
        if self.directory.exists():
            shutil.rmtree(self.directory)
        return 0


def start_driver(directory: Path) -> ComputerDriver:
    app, binary = installation()
    owned = Path(tempfile.mkdtemp(prefix="amcu-", dir="/tmp"))
    owned.chmod(0o700)
    driver = ComputerDriver(app, binary, owned)
    driver.session = "amazme-" + directory.name
    try:
        report = permissions(app, owned)
        driver.hello = {"identity": IDENTITY, "accessibility": report["accessibility"],
                        "screen": report["screen_recording"]}
        if report["accessibility"] and report["screen_recording"]:
            driver.connect()
        return driver
    except BaseException:
        driver.stop()
        raise
