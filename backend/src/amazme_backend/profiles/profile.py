from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Literal

import httpx

from amazme_backend.contracts.identity import Identity
from amazme_backend.contracts.profiles import ProfileConfig, ProviderConfig
from amazme_backend.platform.ipc import Peer
from amazme_backend.platform.private_files import private_write
from amazme_backend.shared.errors import BackendError


class Profile:
    def __init__(self, path: Path):
        self.path = path.resolve(strict=True)
        self.config = ProfileConfig.model_validate_json((self.path / "config.json").read_bytes())
        self.token = (self.path / "control.token").read_text().strip()
        key = hashlib.sha256(str(self.path).encode()).hexdigest()[:16]
        self.ipc = Path(f"/tmp/amazme-{os.getuid()}-{key}")
        self.ipc.mkdir(mode=0o700, exist_ok=True)
        info = self.ipc.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise BackendError("unsafe_ipc_directory")

    @property
    def account_path(self) -> Path:
        # Linked history profiles use the original locked vault; refresh ownership stays there.
        return Path(self.config.account_profile).resolve(strict=True) if self.config.account_profile else self.path

    def reload_provider(self) -> None:
        fresh = ProfileConfig.model_validate_json((self.path / "config.json").read_bytes())
        if (fresh.profile_id != self.config.profile_id or fresh.workspace != self.config.workspace
                or fresh.format != self.config.format or fresh.account_profile != self.config.account_profile):
            raise BackendError("profile_identity_mismatch")
        self.config = fresh

    def save_provider(self, provider: ProviderConfig, *, credential_revision: int | None = None) -> None:
        raw = json.loads((self.path / "config.json").read_text())
        raw["provider"] = {**provider.model_dump(mode="json"), "api_key": provider.api_key.get_secret_value()}
        if credential_revision is not None:
            raw["credential_revision"] = credential_revision
        private_write(self.path / "config.json", json.dumps(raw))
        self.reload_provider()

    def socket(self, name: str) -> Path:
        return self.ipc / f"{name}.sock"

    def worker_socket(self, session: str) -> Path:
        return self.socket("w-" + hashlib.sha256(session.encode()).hexdigest()[:16])

    def identity(self, instance: str, build: str, *, role: Literal["host", "supervisor", "worker"] = "host",
                 state: str = "ready", host_epoch: int = 0) -> Identity:
        return Identity(build_id=build, profile_id=self.config.profile_id, instance_id=instance, pid=os.getpid(),
                        role=role, state=state, host_epoch=host_epoch, fingerprint=build)


async def wait_peer(peer: Peer, expected_build: str, timeout: float = 20,
                    *, instance: str | None = None, profile: str | None = None) -> Identity:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            identity = await asyncio.wait_for(peer.call("GET", "/identity", Identity), 2)
            if identity.build_id != expected_build:
                raise BackendError("build_mismatch")
            if identity.protocol != "amazme-http/1" or (profile and identity.profile_id != profile):
                raise BackendError("peer_identity_mismatch")
            if instance and identity.instance_id != instance:
                await asyncio.sleep(0.1)
                continue
            return identity
        except (httpx.TransportError, FileNotFoundError, TimeoutError):
            await asyncio.sleep(0.1)
    raise BackendError("startup_timeout", status=503)
