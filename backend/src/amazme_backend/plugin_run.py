"""Run the fixed plugin gate. Plugin code never receives a database handle."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Literal, cast

from .contracts import BackendError
from .native_execution import tool_environment

GATE = Path(__file__).with_name("plugin_gate.py").read_text()
CAPABILITY = "stamp"
_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}")
_FORBIDDEN = {"sqlite", "command", "shell", "path", "entry"}


class PluginOutcome:
    def __init__(self, phase: Literal["done", "failed", "unknown"], *, exit_code: int | None = None) -> None:
        self.phase = phase
        self.exit_code = exit_code


def stored_config(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, str] = {}
    for key, item in cast(dict[object, object], value).items():
        if isinstance(key, str) and isinstance(item, str):
            result[key] = item
    return result


def validate_config(config: dict[str, str]) -> dict[str, str]:
    if len(config) > 8:
        raise BackendError("plugin_config_rejected")
    clean: dict[str, str] = {}
    for key, value in config.items():
        if key.lower() in _FORBIDDEN or _KEY.fullmatch(key) is None:
            raise BackendError("plugin_config_rejected")
        if len(value) > 200 or "\n" in value or "\x00" in value:
            raise BackendError("plugin_config_rejected")
        clean[key] = value
    return dict(sorted(clean.items()))


def plugin_fingerprint(plugin_id: str, name: str, config: dict[str, str]) -> str:
    body = {"capabilities": [CAPABILITY], "config": config, "id": plugin_id, "name": name}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def set_fingerprint(fingerprints: list[str]) -> str:
    return hashlib.sha256(json.dumps(sorted(fingerprints), separators=(",", ":")).encode()).hexdigest()


def run_plugin_gate(workspace: Path, text: str) -> PluginOutcome:
    """Start the shipped gate. The permit names the capability, not a command or database."""
    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    permit = {"capability": CAPABILITY, "text": text}
    process = subprocess.Popen(
        [sys.executable, "-I", "-c", GATE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=workspace, env=tool_environment(), start_new_session=True, text=True,
    )
    stdin = process.stdin
    stdout = process.stdout
    if stdin is None or stdout is None:
        process.kill()
        return PluginOutcome("failed")
    try:
        stdin.write(json.dumps(permit) + "\n")
        stdin.flush()
    except OSError:
        pass
    line = ""
    try:
        line = stdout.readline(65536)
    except OSError:
        line = ""
    try:
        code: int | None = process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, 9)
        except OSError:
            pass
        try:
            code = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            code = None
    stdin.close()
    if process.stderr is not None:
        process.stderr.close()
    if code is None:
        return PluginOutcome("unknown")
    accepted = False
    try:
        parsed: object = json.loads(line) if line else {}
    except json.JSONDecodeError:
        parsed = {}
    if isinstance(parsed, dict) and cast(dict[object, object], parsed).get("ok") is True:
        accepted = True
    if code == 0 and accepted:
        return PluginOutcome("done", exit_code=code)
    return PluginOutcome("failed", exit_code=code)
