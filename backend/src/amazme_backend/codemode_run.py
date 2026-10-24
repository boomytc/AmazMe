"""Run one Codemode script in the QuickJS helper. State commits only after success."""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Literal, cast

from .common import resource_root
from .contracts import BackendError
from .native_execution import tool_environment

HELPER = Path(__file__).with_name("codemode_helper.mjs")
SOURCE_LIMIT = 8000
MEMORY_LIMIT = 1_000_000
DEFAULT_TIMEOUT_MS = 2000


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
                 exit_code: int | None = None) -> None:
        self.phase = phase
        self.value = value
        self.state = state
        self.output = output
        self.exit_code = exit_code

    @property
    def committed(self) -> bool:
        return self.phase == "success" and self.state is not None


def _reply(message: dict[str, object], mark_path: Path | None) -> dict[str, object] | None:
    name = str(message.get("name", ""))
    arguments = json_object(message.get("arguments"))
    if name not in {"echo", "mark", "block"} or message.get("id") is None:
        return {"op": "tool_result", "id": message.get("id"), "error": "tool rejected"}
    if name == "block":
        return None
    if name == "mark" and mark_path is not None:
        mark_path.write_text(mark_path.read_text() + "x" if mark_path.exists() else "x")
        return {"op": "tool_result", "id": message["id"], "result": {"ok": True}}
    text = arguments.get("text", "")
    return {"op": "tool_result", "id": message["id"], "result": {"text": text if isinstance(text, str) else ""}}


def _finish(outcome: CodemodeOutcome, code: int | None, cancel: threading.Event | None) -> CodemodeOutcome:
    if code is None:
        outcome = CodemodeOutcome("unknown")
    else:
        outcome.exit_code = code
        if cancel is not None and cancel.is_set() and outcome.phase != "success":
            outcome.phase = "cancelled"
        elif outcome.phase == "unknown":
            outcome.phase = "failed"
    if outcome.phase != "success":
        outcome.state = None
    return outcome


def bundled_node() -> Path:
    """The Node binary shipped beside the backend. A PATH lookup is never a substitute."""
    root = resource_root().resolve()
    candidate = root / "node" / "bin" / "node"
    if candidate.is_symlink() or not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise BackendError("codemode_runtime_missing", status=503)
    if not candidate.resolve().is_relative_to(root):
        raise BackendError("codemode_runtime_missing", status=503)
    return candidate


def run_codemode(source: str, state: dict[str, object], *, mark_path: Path | None = None,
                 timeout_ms: int = DEFAULT_TIMEOUT_MS, cancel: threading.Event | None = None) -> CodemodeOutcome:
    if len(source) > SOURCE_LIMIT:
        raise BackendError("codemode_source_limit")
    node = bundled_node()
    if not HELPER.is_file():
        raise BackendError("codemode_runtime_missing", status=503)
    process = subprocess.Popen(
        [str(node), str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=tool_environment(), start_new_session=True, text=True,
    )
    stdin = process.stdin
    stdout = process.stdout
    if stdin is None or stdout is None:
        process.kill()
        raise BackendError("codemode_runtime_missing", status=503)

    def watch() -> None:
        if cancel is None or not cancel.wait(timeout_ms / 1000 + 1):
            return
        if process.poll() is not None:
            return
        try:
            stdin.write(json.dumps({"op": "cancel"}) + "\n")
            stdin.flush()
        except OSError:
            pass
        try:
            os.killpg(process.pid, 9)
        except OSError:
            pass

    watcher = threading.Thread(target=watch, daemon=True)
    outcome = CodemodeOutcome("unknown")
    try:
        try:
            stdin.write(json.dumps({
                "source": source, "state": state, "timeout_ms": timeout_ms, "memory_limit": MEMORY_LIMIT,
            }, ensure_ascii=False) + "\n")
            stdin.flush()
        except OSError:
            outcome = CodemodeOutcome("failed", output="ipc")
        else:
            watcher.start()
            for line in stdout:
                if len(line) > 65536:
                    outcome = CodemodeOutcome("failed", output="ipc limit")
                    os.killpg(process.pid, 9)
                    break
                try:
                    parsed: object = json.loads(line)
                except json.JSONDecodeError:
                    outcome = CodemodeOutcome("failed", output="ipc")
                    os.killpg(process.pid, 9)
                    break
                message = json_object(parsed)
                if not message:
                    outcome = CodemodeOutcome("failed", output="ipc")
                    os.killpg(process.pid, 9)
                    break
                op = message.get("op")
                if op == "tool":
                    reply = _reply(message, mark_path)
                    if reply is None:
                        continue
                    try:
                        stdin.write(json.dumps(reply) + "\n")
                        stdin.flush()
                    except OSError:
                        outcome = CodemodeOutcome("failed", output="ipc")
                        break
                elif op == "success":
                    raw_state = message.get("state")
                    kept = json_object(cast(object, raw_state)) if isinstance(raw_state, dict) else None
                    outcome = CodemodeOutcome(
                        "success", value=message.get("value"), state=kept, output=str(message.get("output", "")),
                    )
                    break
                elif op == "failure":
                    outcome = CodemodeOutcome(
                        "cancelled" if message.get("message") == "cancelled" else "failed",
                        output=str(message.get("output", "")) or str(message.get("message", "")),
                    )
                    break
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, 9)
            except OSError:
                pass
        try:
            code: int | None = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            code = None
        outcome = _finish(outcome, code, cancel)
        stdin.close()
        if process.stderr is not None:
            process.stderr.close()
    return outcome
