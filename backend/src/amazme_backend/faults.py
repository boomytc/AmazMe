"""Opt-in local fault rendezvous for owned test profiles; never an HTTP capability."""

import asyncio
import json
import os
import time
from pathlib import Path

from pydantic import Field

from .common import private_write
from .contracts import BackendError, Model


class FaultPlan(Model):
    nonce: str = Field(pattern=r"^[a-f0-9]{16}$")
    match: dict[str, str] = Field(default_factory=dict)


class Faults:
    def __init__(self, profile: Path, role: str, instance: str, *, enabled: bool = False):
        self.root = profile / "faults"
        self.role, self.instance, self.enabled = role, instance, enabled
        if enabled:
            self.root.mkdir(mode=0o700, exist_ok=True)

    def _arm(self, point: str, context: dict[str, str]) -> Path | None:
        if not self.enabled:
            return None
        path = self.root / f"{self.role}.{point}.json"
        try:
            plan = FaultPlan.model_validate_json(path.read_bytes())
        except FileNotFoundError:
            return None
        if any(context.get(key) != value for key, value in plan.match.items()):
            return None
        try:
            path.rename(self.root / f"{plan.nonce}.consumed.json")
        except FileNotFoundError:
            return None
        private_write(self.root / f"{plan.nonce}.reached.json", json.dumps({
            "nonce": plan.nonce, "role": self.role, "point": point, "instance": self.instance,
            "pid": os.getpid(), "context": context,
        }))
        return self.root / f"{plan.nonce}.release"

    async def hit(self, point: str, **context: str) -> None:
        release = self._arm(point, context)
        if release is None:
            return
        deadline = time.monotonic() + 120
        while not release.exists():
            if time.monotonic() >= deadline:
                raise BackendError("test_fault_timeout", point, 503)
            await asyncio.sleep(0.02)

    def sync_hit(self, point: str, **context: str) -> None:
        release = self._arm(point, context)
        if release is None:
            return
        deadline = time.monotonic() + 120
        while not release.exists():
            if time.monotonic() >= deadline:
                raise BackendError("test_fault_timeout", point, 503)
            time.sleep(0.02)
