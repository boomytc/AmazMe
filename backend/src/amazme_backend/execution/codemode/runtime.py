"""Run one Codemode script in the QuickJS helper. State commits only after success."""

from __future__ import annotations

import contextlib
import json
import os
import socket
import subprocess
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Literal, cast

from amazme_backend.contracts.code import CodeCall, CodeImage, CodeText, CodeView
from amazme_backend.execution.native import read_report, tool_environment
from amazme_backend.execution.processes import ProcessReservation, exited
from amazme_backend.platform.ipc import child_command
from amazme_backend.platform.resources import package_resource, resource_root
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError

HELPER = package_resource("codemode_helper")
SOURCE_LIMIT = 8000
MEMORY_LIMIT = 1_000_000
DEFAULT_TIMEOUT_MS = 300000


def json_object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    mapped: dict[str, object] = {}
    for key, item in cast(dict[object, object], value).items():
        if isinstance(key, str):
            mapped[key] = item
    return mapped


class CodemodeOutcome:
    def __init__(self, phase: Literal["success", "failed", "cancelled", "unknown"], *,
                 value: object = None, state: dict[str, object] | None = None, output: str = "",
                 exit_code: int | None = None, items: list[CodeText | CodeImage] | None = None,
                 calls: list[CodeCall] | None = None, error: str = "", clean: bool = False) -> None:
        self.phase: Literal["success", "failed", "cancelled", "unknown"] = phase
        self.value = value
        self.state = state
        self.output = output
        self.exit_code = exit_code
        self.items = items or []
        self.calls = calls or []
        self.error = error
        self.clean = clean

    @property
    def committed(self) -> bool:
        return self.phase == "success" and self.state is not None


def _finish(outcome: CodemodeOutcome, code: int | None, cancel: threading.Event | None) -> CodemodeOutcome:
    if code is None:
        outcome = CodemodeOutcome("unknown")
    else:
        outcome.exit_code = code
        outcome.clean = True
        if cancel is not None and cancel.is_set() and outcome.phase != "success":
            outcome.phase = "cancelled"
        elif outcome.phase == "unknown":
            outcome.phase = "failed"
    if outcome.phase != "success":
        outcome.state = None
    return outcome


def bundled_node(runtime_root: Path | None = None) -> Path:
    """The Node binary shipped beside the backend. A PATH lookup is never a substitute."""
    root = (runtime_root or resource_root()).resolve()
    candidate = root / "node" / "bin" / "node"
    if candidate.is_symlink() or not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise BackendError("codemode_runtime_missing", status=503)
    if not candidate.resolve().is_relative_to(root):
        raise BackendError("codemode_runtime_missing", status=503)
    return candidate


def run_codemode(source: str, state: dict[str, object], *, profile: Path, run_id: str, tools: list[dict[str, object]] | None = None,
                 call_tool: Callable[[dict[str, object]], dict[str, object]] | None = None,
                 timeout_ms: int = DEFAULT_TIMEOUT_MS, cancel: threading.Event | None = None) -> CodemodeOutcome:
    if len(source) > SOURCE_LIMIT:
        raise BackendError("codemode_source_limit")
    import sys
    root = None if getattr(sys, "frozen", False) else Path(Profile(profile).config.resources)
    bundled_node(root)
    if not HELPER.is_file():
        raise BackendError("codemode_runtime_missing", status=503)
    instance = "code-" + run_id
    directory = profile / "executions" / instance
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    parent, child = socket.socketpair()
    try:
        with ProcessReservation(profile,"execution",instance) as reservation:
            process = subprocess.Popen(child_command("service-runner","--kind","codemode","--profile",str(profile),
                "--instance",instance,"--lifetime-fd",str(reservation.fd),"--directory",str(directory)),
                stdin=child.fileno(),stdout=child.fileno(),stderr=subprocess.DEVNULL,pass_fds=(reservation.fd,),
                env=tool_environment(),start_new_session=True)
    except BaseException:
        parent.close()
        raise
    finally:
        child.close()
    stdin = parent.makefile("w",encoding="utf8")
    stdout = parent.makefile("r",encoding="utf8")
    finished = threading.Event()
    stopping = cancel or threading.Event()
    writing = threading.Lock()
    executor = ThreadPoolExecutor(max_workers=2,thread_name_prefix="code-tool")
    calls: list[Future[None]] = []

    def reply_tool(message: dict[str, object]) -> None:
        name = message.get("name")
        names = {tool["name"] for tool in tools or []}
        if name not in names or call_tool is None:
            reply = {"op":"tool_result", "id":message.get("id"), "error":"tool_not_offered"}
        else:
            try:
                reply = call_tool(message)
            except Exception as error:
                reply = {"op":"tool_result", "id":message.get("id"), "error":str(error)[:500]}
        with writing:
            with contextlib.suppress(OSError,ValueError):
                stdin.write(json.dumps(reply) + "\n")
                stdin.flush()

    def watch() -> None:
        deadline = time.monotonic() + timeout_ms / 1000 + 1
        while not finished.wait(.02):
            if not stopping.is_set() and time.monotonic() < deadline:
                continue
            if process.poll() is not None:
                return
            stopping.set()
            try:
                parent.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return

    watcher = threading.Thread(target=watch, daemon=True)
    outcome = CodemodeOutcome("unknown")
    try:
        try:
            stdin.write(json.dumps({
                "source": source, "state": state, "timeout_ms": timeout_ms, "memory_limit": MEMORY_LIMIT, "tools":tools or [],
            }, ensure_ascii=False) + "\n")
            stdin.flush()
        except OSError:
            outcome = CodemodeOutcome("failed", output="ipc")
        else:
            watcher.start()
            while line := stdout.readline(8 * 1024 * 1024 + 1):
                if len(line) > 8 * 1024 * 1024:
                    outcome = CodemodeOutcome("failed", output="ipc limit")
                    parent.shutdown(socket.SHUT_RDWR)
                    break
                try:
                    parsed: object = json.loads(line)
                except json.JSONDecodeError:
                    outcome = CodemodeOutcome("failed", output="ipc")
                    parent.shutdown(socket.SHUT_RDWR)
                    break
                message = json_object(parsed)
                if not message:
                    outcome = CodemodeOutcome("failed", output="ipc")
                    parent.shutdown(socket.SHUT_RDWR)
                    break
                op = message.get("op")
                if op == "tool":
                    if sum(not call.done() for call in calls) >= 2 or len(calls) >= 128:
                        outcome = CodemodeOutcome("failed",error="codemode_tool_limit")
                        break
                    calls.append(executor.submit(reply_tool,message))
                elif op == "success":
                    view = CodeView.model_validate({"run_id":run_id,"phase":"success",
                        "output":message.get("items",[]),"calls":message.get("calls",[])})
                    raw_state = message.get("state")
                    kept = json_object(cast(object, raw_state)) if isinstance(raw_state, dict) else None
                    outcome = CodemodeOutcome(
                        "success", value=message.get("value"), state=kept, output=str(message.get("output", "")),
                        items=view.output,calls=view.calls,
                    )
                    break
                elif op == "failure":
                    view = CodeView.model_validate({"run_id":run_id,"phase":"failed",
                        "output":message.get("items",[]),"calls":message.get("calls",[])})
                    outcome = CodemodeOutcome(
                        "cancelled" if message.get("kind") == "aborted" else "failed",
                        output=str(message.get("output", "")) or str(message.get("message", "")),
                        items=view.output,calls=view.calls,error=str(message.get("message","")),
                    )
                    break
    finally:
        if any(not call.done() for call in calls):
            stopping.set()
        finished.set()
        try:
            parent.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        with contextlib.suppress(OSError):
            stdin.close()
        with contextlib.suppress(OSError):
            stdout.close()
        parent.close()
        executor.shutdown(wait=True,cancel_futures=True)
        try:
            code: int | None = process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            code = None
        clean = False
        if code is not None and exited(reservation.lease):
            try:
                clean = read_report(directory).stopped
            except BackendError:
                pass
        outcome = _finish(outcome,code if clean else None,cancel)
    return outcome
