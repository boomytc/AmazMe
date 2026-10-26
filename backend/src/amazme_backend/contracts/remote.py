from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.shared.model import Model


class SshTarget(Model):
    host: str = Field(min_length=1, max_length=200, pattern=r"^[^-\s\x00-\x1f\x7f][^\s\x00-\x1f\x7f]*$")
    user: str = Field(default="", max_length=100)
    port: int | None = Field(default=None, ge=1, le=65535)
    identity_file: str = Field(default="", max_length=1024)
    config_file: str = Field(default="", max_length=1024)


class RemoteKeyScan(SshTarget):
    remote_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class RemoteHostKey(Model):
    line: str
    fingerprint: str


class RemoteHostKeys(Model):
    keys: list[RemoteHostKey]


class RemoteOpen(RemoteKeyScan):
    host_key: str = Field(min_length=16, max_length=2048)
    generation: int = Field(default=1, ge=1, le=1_000_000)


class RemoteView(Model):
    remote_id: str
    host: str
    phase: Literal["connected", "disconnected", "blocked"]
    generation: int


class RemoteRun(RemoteOpen):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class RemoteCallRequest(Model):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class RemoteCallView(Model):
    call_id: str
    phase: Literal["unknown", "done", "conflict"]
    result: str = ""
