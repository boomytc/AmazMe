"""CLI terminal receipt records, scoped by host and protected by the existing OS lock."""

import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Literal

from pydantic import Field

from .common import lock, private_write
from .contracts import BackendError, Model


class PendingInput(Model):
    inputId: str = Field(pattern=r"^[a-f0-9]{32}$")
    prompt: str = Field(max_length=65536)
    terminalId: str = Field(min_length=1, max_length=128)


class OutboxCommand(Model):
    directory: str = Field(min_length=1, max_length=4096)
    profile: str = Field(min_length=1, max_length=128)
    session: str = Field(min_length=1, max_length=128)
    operation: Literal["read", "reserve", "ack"]
    pending: PendingInput | None = None
    expected_id: str = ""


def execute(value: OutboxCommand) -> PendingInput | bool | None:
    root = Path(value.directory)
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise BackendError("unsafe_client_outbox")
    scope = hashlib.sha256(
        json.dumps([value.profile, value.session], separators=(",", ":")).encode()
    ).hexdigest()
    path = root / (scope + ".json")
    with lock(root / (scope + ".lock")):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            current = None
        else:
            with os.fdopen(fd) as stream:
                current = PendingInput.model_validate_json(stream.read(1024 * 1024 + 1))
        if value.operation == "read":
            return current
        if value.operation == "reserve":
            if current is not None:
                return current
            if value.pending is None:
                raise BackendError("terminal_input_required")
            private_write(path, value.pending.model_dump_json())
            return value.pending
        if current is None or current.inputId != value.expected_id:
            return False
        path.unlink()
        return True


def main() -> int:
    try:
        value = OutboxCommand.model_validate_json(sys.stdin.buffer.read(1024 * 1024 + 1))
        result = execute(value)
        print(
            json.dumps(
                result.model_dump() if isinstance(result, PendingInput) else result, ensure_ascii=False
            )
        )
        return 0
    except (BackendError, OSError, ValueError) as exc:
        print(json.dumps({"error": exc.code if isinstance(exc, BackendError) else type(exc).__name__}))
        return 1
