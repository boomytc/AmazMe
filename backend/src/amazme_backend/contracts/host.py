from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.contracts.execution import ServiceInfo, SupervisorHealth
from amazme_backend.contracts.identity import Identity
from amazme_backend.shared.model import Model


class Health(Model):
    identity: Identity
    state: Literal["ready", "recovering", "blocked"]
    supervisor: SupervisorHealth | None = None
    pending_deliveries: int = 0
    errors: list[str] = Field(default_factory=lambda: list[str]())
    supervisors: list[ServiceInfo] = Field(default_factory=lambda: list[ServiceInfo]())
