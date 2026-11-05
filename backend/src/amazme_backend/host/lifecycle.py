from __future__ import annotations

import asyncio
import os
import secrets
import time

import httpx

from amazme_backend.contracts.execution import ProcessLease, SupervisorHealth
from amazme_backend.contracts.host import Health
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.execution.client import SupervisorClient
from amazme_backend.execution.processes import ProcessReservation, exited, wait_exited
from amazme_backend.host.store import HostStore, ServiceRecord
from amazme_backend.platform.ipc import child_command
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY, validate_workspace


class HostLifecycle:
    def __init__(
        self, profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None
    ):
        self.profile = profile
        self.instance = instance or secrets.token_hex(16)
        self.process_lease = process_lease
        self.store = HostStore(
            profile.path / "host.sqlite", require_existing=(profile.path / "initialized").exists()
        )
        self.supervisor = SupervisorClient(profile.socket("supervisor"), profile.token)
        self.fence = HostFence(host_epoch=0)
        self.service_lock = asyncio.Lock()
        self.management_lock = asyncio.Lock()
        self.attached = ""
        self.stop = asyncio.Event()
        self.closing = False
        self.initialized = False
        self.storage_failed = False
        self.child: asyncio.subprocess.Process | None = None

    @property
    def storage_failed(self) -> bool:
        return self._storage_failed or self.store.failed or bool(self.store.db.failure)

    @storage_failed.setter
    def storage_failed(self, value: bool) -> None:
        self._storage_failed = value

    def admit(self) -> None:
        if self.storage_failed:
            raise BackendError("storage_blocked", status=503)
        if self.closing:
            raise BackendError("host_stopping", status=503)

    def identity(self, state: str = "ready") -> Identity:
        return self.profile.identity(
            self.instance, role="host", state=state, host_epoch=self.fence.host_epoch
        ).model_copy(update={"approval_policy": self.profile.config.approval_policy})

    async def _spawn_supervisor(self) -> ServiceRecord:
        instance = secrets.token_hex(16)
        required = await self.store.execution_initialized()
        with ProcessReservation(self.profile.path, "supervisor", instance) as reservation:
            record = ServiceRecord(
                instance_id=instance, process_lease=reservation.lease, state="starting"
            )
            await self.store.save_service(record)
            log_fd = os.open(
                self.profile.path / "supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 384
            )
            try:
                args = child_command(
                    "supervisor",
                    "--profile",
                    str(self.profile.path),
                    "--instance",
                    instance,
                    "--lifetime-fd",
                    str(reservation.fd),
                )
                if required:
                    args.append("--require-existing-store")
                self.child = await asyncio.create_subprocess_exec(
                    *args,
                    pass_fds=(reservation.fd,),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=log_fd,
                    stderr=log_fd,
                    start_new_session=True,
                )
            finally:
                os.close(log_fd)
            record.pid = self.child.pid
            await self.store.save_service(record)
        return record

    async def _await_service(self, record: ServiceRecord) -> Identity:
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if exited(record.process_lease):
                raise BackendError("supervisor_startup_failed", status=503)
            try:
                identity = await asyncio.wait_for(self.supervisor.call("GET", "/identity", Identity), 2)
                if (identity.instance_id, identity.profile_id, identity.role) != (record.instance_id, self.profile.config.profile_id, "supervisor"):
                    raise BackendError("supervisor_identity_mismatch")
                return identity
            except (httpx.TransportError, TimeoutError):
                await asyncio.sleep(0.1)
        raise BackendError("supervisor_startup_timeout", status=503)

    def check_supervisor(self, identity: Identity, record: ServiceRecord, *, fenced: bool = False) -> None:
        if (
            (identity.instance_id, identity.profile_id, identity.role)
            != (record.instance_id, self.profile.config.profile_id, "supervisor")
            or identity.protocol != "amazme-http/1"
            or (fenced and identity.host_epoch != self.fence.host_epoch)
        ):
            raise BackendError("supervisor_identity_mismatch", status=503)

    async def require_workspace(self, name: str) -> None:
        if name == PRIMARY:
            return
        validate_workspace(name)
        if name not in {item for item, _host in await self.store.workspace_grants()}:
            raise BackendError("workspace_not_found", status=404)

    async def require_session(self, session_id: str) -> None:
        """A missing session must not fall through to the primary directory."""
        session = await self.store.session(session_id)
        if session is None:
            raise BackendError("session_not_found", status=404)
        if not session.prepared:
            raise BackendError("branch_preparation_pending", status=409)


    async def initialize(self) -> None:
        if self.process_lease is None:
            raise BackendError("missing_process_lease")
        self.fence.host_epoch = await self.store.initialize(self.instance, self.process_lease)
        self.initialized = True
        private_write(self.profile.path / "initialized", "2\n")
        await self.store.allow_restart(explicit=True)
        for lease in await self.store.source_hosts(self.instance):
            await wait_exited(lease)
        await self.ensure_supervisor()
        await self.store.demand()

    async def _stop_service(self, service: ServiceRecord) -> None:
        if not exited(service.process_lease):
            identity = await self._await_service(service)
            self.check_supervisor(identity, service)
            service.state = "stopping"
            await self.store.save_service(service)
            await self.supervisor.call("POST", "/shutdown", Identity,
                HostFence(host_epoch=identity.host_epoch))
            await wait_exited(service.process_lease, 30)
        service.state = "stopped"
        await self.store.save_service(service)
        self.attached = ""
        await self.supervisor.close()
        self.supervisor = SupervisorClient(self.profile.socket("supervisor"), self.profile.token)

    async def ensure_supervisor(self, *, for_shutdown: bool = False) -> Identity:
        async with self.service_lock:
            if for_shutdown:
                if self.storage_failed:
                    raise BackendError("storage_blocked", status=503)
                if not self.closing:
                    raise BackendError("shutdown_not_admitted", status=503)
            else:
                self.admit()
            for service in await self.store.services():
                dead = exited(service.process_lease)
                if service.state == "stopped":
                    if not dead:
                        raise BackendError("supervisor_exit_unproven", status=503)
                elif dead or service.state == "stopping":
                    unexpected = dead and service.state != "stopping"
                    await self._stop_service(service)
                    if unexpected:
                        await self.store.allow_restart()
            record = await self.store.service()
            if record is None:
                if await self.store.blocked():
                    raise BackendError("supervisor_restart_budget", status=503)
                record = await self._spawn_supervisor()
            identity = await self._await_service(record)
            self.check_supervisor(identity, record)
            if identity.state == "stopping":
                raise BackendError("supervisor_retirement_pending", status=503)
            if self.attached != record.instance_id:
                identity = await self.supervisor.call("POST", "/takeover", Identity, self.fence)
                self.check_supervisor(identity, record, fenced=True)
                record.state = "running"
                await self.store.save_service(record)
                self.attached = record.instance_id
            return identity

    async def health(self) -> Health:
        try:
            return await self._health()
        except BackendError:
            if not self.storage_failed:
                raise
            return Health(identity=self.identity("blocked"), state="blocked", errors=["storage_failed"])

    async def _health(self) -> Health:
        errors: list[str] = []
        current: SupervisorHealth | None = None
        records = await self.store.services()
        for record in records:
            try:
                dead = exited(record.process_lease)
                if not dead and record.instance_id != self.attached:
                    errors.append("unattached_supervisor:" + record.instance_id)
                if not dead and record.state in {"stopping", "stopped", "unknown"}:
                    errors.append("supervisor_exit_unproven:" + record.instance_id)
                record.state = "stopped" if dead else record.state
            except BackendError as error:
                errors.append(error.code + ":" + record.instance_id)
                record.state = "unknown"
        if self.attached:
            try:
                current = await self.supervisor.call("GET", "/health", SupervisorHealth)
                errors.extend(current.blocked)
                service = next((record for record in records if record.instance_id == self.attached), None)
                if service is None:
                    raise BackendError("supervisor_identity_mismatch")
                self.check_supervisor(current.identity, service, fenced=True)
            except (BackendError, httpx.TransportError, TimeoutError):
                errors.append("supervisor_unavailable")
        else:
            errors.append("supervisor_unavailable")
        if self.storage_failed:
            errors.append("storage_failed")
        blocked = await self.store.blocked()
        if blocked:
            errors.append(blocked)
        state = "blocked" if errors else "ready"
        return Health(identity=self.identity(state), state=state, supervisor=current,
            pending_deliveries=len(await self.store.pending()), errors=errors, supervisors=records)

    async def stop_owned_supervisor(self) -> None:
        async with self.service_lock:
            if self.initialized:
                service = await self.store.service()
                if service is not None and service.state != "stopped":
                    await self._stop_service(service)
