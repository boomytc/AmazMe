from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.contracts.sessions import ApprovalPolicy
from amazme_backend.shared.model import Model


class Identity(Model):
    version: str = "0.1.0"
    protocol: str = "amazme-http/1"
    build_id: str
    profile_id: str
    instance_id: str
    pid: int
    host_epoch: int = 0
    role: Literal["host", "supervisor", "worker"] = "host"
    state: str = "ready"
    fingerprint: str = ""
    storage_format: Literal[2] = 2
    approval_policy: ApprovalPolicy = "mutations"


class HostReady(Identity):
    url: str = Field(pattern=r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}$")


class HostFence(Model):
    host_epoch: int
    build_id: str
