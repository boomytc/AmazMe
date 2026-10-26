from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.contracts.execution import ServiceInfo, SupervisorHealth, WorkerInfo
from amazme_backend.contracts.identity import Identity
from amazme_backend.shared.model import Model


class PrepareUpdate(Model):
    update_id: str = Field(min_length=1, max_length=128)
    target_build: str = Field(pattern=r"^[a-f0-9]{64}$")
    cancel_work: bool = False


class UpdateRecord(Model):
    update_id: str
    source_build: str
    target_build: str
    phase: Literal["freezing", "retiring", "prepared", "validating", "completed"]
    revision: str
    cancel_work: bool
    error: str = ""
    roster: list[WorkerInfo] = Field(default_factory=lambda: list[WorkerInfo]())
    validation: WorkerInfo | None = None
    activated: bool = False


class CompleteUpdate(Model):
    update_id: str
    expected_revision: str


class Health(Model):
    identity: Identity
    state: Literal["ready", "recovering", "frozen", "blocked"]
    supervisor: SupervisorHealth | None = None
    update: UpdateRecord | None = None
    pending_deliveries: int = 0
    errors: list[str] = Field(default_factory=lambda: list[str]())
    supervisors: list[ServiceInfo] = Field(default_factory=lambda: list[ServiceInfo]())
