"""Start the fixed computer driver. The permit selects a built-in scenario, not a command."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Literal, cast

from .contracts import BackendError
from .native_execution import tool_environment

Scenario = Literal["unconfigured", "denied", "granted", "plain", "hold", "drop"]
SOURCE = Path(__file__).with_name("computer_driver.py").read_text()


class ComputerDriver:
    def __init__(self, process: subprocess.Popen[str]):
        self.process = process
        self.hello: dict[str, object] = {}

    def request(self, payload: dict[str, object]) -> dict[str, object]:
        stdin = self.process.stdin
        stdout = self.process.stdout
        if stdin is None or stdout is None:
            raise BackendError("computer_driver_lost")
        try:
            stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
            stdin.flush()
            line = stdout.readline()
        except OSError as exc:
            raise BackendError("computer_driver_lost") from exc
        if not line:
            raise BackendError("computer_driver_lost")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise BackendError("computer_driver_lost")
        return {str(key): item for key, item in cast(dict[object, object], value).items()}

    def stop(self) -> int | None:
        try:
            self.request({"op": "stop"})
        except (BackendError, OSError, json.JSONDecodeError):
            pass
        return self.wait()

    def wait(self) -> int | None:
        code = self._wait_once()
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        return code

    def _wait_once(self) -> int | None:
        try:
            return self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, 15)
            except OSError:
                pass
            try:
                return self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, 9)
                except OSError:
                    pass
                try:
                    return self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    return None


def start_driver(directory: Path, scenario: Scenario) -> ComputerDriver:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    process = subprocess.Popen(
        [sys.executable, "-I", "-c", SOURCE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=directory, env=tool_environment(), start_new_session=True, text=True,
    )
    driver = ComputerDriver(process)
    try:
        driver.hello = driver.request({"scenario": scenario})
    except (BackendError, OSError, json.JSONDecodeError):
        driver.wait()
        raise BackendError("computer_driver_lost") from None
    if driver.hello.get("op") != "ready" or driver.hello.get("identity") != "fixed-computer-driver":
        driver.wait()
        raise BackendError("computer_driver_lost")
    return driver
