from __future__ import annotations

import asyncio
import os
import secrets
import time
from typing import NoReturn

import httpx

from amazme_backend.contracts.events import Snapshot
from amazme_backend.contracts.execution import ProcessLease, SupervisorHealth, WorkerInfo
from amazme_backend.contracts.host import Health, PrepareUpdate, UpdateRecord
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.contracts.ipc.supervisor import FreezeSupervisor, RetireSupervisor
from amazme_backend.diagnostics.faults import Faults
from amazme_backend.execution.client import SupervisorClient
from amazme_backend.execution.processes import ProcessReservation, exited, wait_exited
from amazme_backend.host.store import HostStore, ServiceRecord
from amazme_backend.platform.identity import build_id
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
        self.build = build_id()
        self.instance = instance or secrets.token_hex(16)
        self.process_lease = process_lease
        self.store = HostStore(
            profile.path / "host.sqlite", require_existing=(profile.path / "initialized").exists()
        )
        self.supervisor = SupervisorClient(profile.socket("supervisor"), profile.token)
        self.fence = HostFence(host_epoch=0, build_id=self.build)
        self.service_lock = asyncio.Lock()
        self.update_lock = asyncio.Lock()
        self.attached = ""
        self.stop = asyncio.Event()
        self.closing = False
        self.initialized = False
        self.storage_failed = False
        self.child: asyncio.subprocess.Process | None = None
        self.faults = Faults(profile.path, "host", self.instance, enabled=profile.config.testing)

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
            self.instance, self.build, role="host", state=state, host_epoch=self.fence.host_epoch
        ).model_copy(update={"approval_policy": self.profile.config.approval_policy})

    async def initialize(self) -> None:
        if self.process_lease is None:
            raise BackendError("missing_process_lease")
        self.fence.host_epoch = await self.store.initialize(self.instance, self.build, self.process_lease)
        self.initialized = True
        private_write(self.profile.path / "initialized", "2\n")
        for lease in await self.store.source_hosts(self.instance):
            await wait_exited(lease)
        active = await self.store.active_update()
        previous_build = await self.store.last_build(self.instance)
        if active is None and previous_build and (previous_build != self.build):
            active = await self.store.begin_update(
                PrepareUpdate(update_id="replace-" + self.instance, target_build=self.build), previous_build
            )
        if active and self.build not in {active.source_build, active.target_build}:
            active = await self.store.supersede_local_replacement(active.update_id, active.revision, self.build)
        if not (
            active
            and active.phase in {"prepared", "validating", "completed"}
            and (self.build == active.source_build != active.target_build)
        ):
            try:
                await self.ensure_supervisor()
            except (BackendError, httpx.TransportError, TimeoutError):
                self.attached = ""
        await self.store.demand()

    async def _spawn_supervisor(self) -> ServiceRecord:
        instance = secrets.token_hex(16)
        required = await self.store.execution_initialized()
        with ProcessReservation(self.profile.path, "supervisor", instance) as reservation:
            record = ServiceRecord(
                instance_id=instance, build_id=self.build, process_lease=reservation.lease, state="starting"
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
                if (identity.instance_id, identity.profile_id, identity.build_id, identity.role) != (
                    record.instance_id,
                    self.profile.config.profile_id,
                    record.build_id,
                    "supervisor",
                ):
                    raise BackendError("supervisor_identity_mismatch")
                if identity.fingerprint != identity.build_id:
                    raise BackendError("component_fingerprint_mismatch")
                return identity
            except (httpx.TransportError, TimeoutError):
                await asyncio.sleep(0.1)
        raise BackendError("supervisor_startup_timeout", status=503)

    def check_supervisor(self, identity: Identity, record: ServiceRecord, *, fenced: bool = False) -> None:
        if (
            (
                identity.instance_id,
                identity.profile_id,
                identity.build_id,
                identity.role,
                identity.fingerprint,
            )
            != (
                record.instance_id,
                self.profile.config.profile_id,
                record.build_id,
                "supervisor",
                record.build_id,
            )
            or identity.protocol != "amazme-http/1"
            or (fenced and identity.host_epoch != self.fence.host_epoch)
        ):
            raise BackendError("supervisor_identity_mismatch", status=503)

    async def update_health(
        self, record: UpdateRecord, health: SupervisorHealth, service: ServiceRecord | None = None
    ) -> UpdateRecord:
        fenced = service is None
        service = service or await self.store.service()
        if service is None:
            raise BackendError("supervisor_unavailable", status=503)
        self.check_supervisor(health.identity, service, fenced=fenced)
        if fenced and health.identity.state == "stopping":
            raise BackendError("supervisor_retirement_pending", status=503)
        return await self.store.source_roster(record.update_id, health.workers)

    @classmethod
    def verify_clean(cls, health: SupervisorHealth) -> None:
        cls.verify_retired(health.workers)
        workers = {worker.worker_id: worker for worker in health.workers}
        session_blocked = any(
            (
                error != "worker_restart_budget_exhausted"
                for errors in health.session_errors.values()
                for error in errors
            )
        )
        if health.blocked or session_blocked or health.identity.state == "blocked":
            raise BackendError("update_health_blocked", status=503)
        if any((not terminal.clean for terminal in health.terminals)):
            raise BackendError("execution_cleanup_pending", status=503)
        if any((not server.clean for server in health.mcp_servers)):
            raise BackendError("execution_cleanup_pending", status=503)
        if any(resource.state != "exited" for resource in health.resources):
            raise BackendError("execution_cleanup_pending", status=503)
        for epoch in health.epochs:
            cleanup = epoch.cleanup
            worker = workers.get(epoch.worker_id)
            if (
                epoch.state != "clean"
                or cleanup is None
                or cleanup.state != "clean"
                or (not cleanup.proof_id)
                or (cleanup.session_id != epoch.session_id)
                or (cleanup.execution_epoch != epoch.execution_epoch)
                or (worker is None)
                or (worker.session_id != epoch.session_id)
            ):
                raise BackendError("execution_cleanup_pending", status=503)

    async def retire_service(self, service: ServiceRecord, record: UpdateRecord) -> UpdateRecord:
        before = await self.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self.update_health(record, before, service)
        service.state = "stopping"
        await self.store.save_service(service)
        health = await self.supervisor.call(
            "POST",
            "/retire",
            SupervisorHealth,
            RetireSupervisor(
                host_epoch=self.fence.host_epoch, build_id=service.build_id, freeze_id=record.update_id
            ),
        )
        record = await self.update_health(record, health, service)
        self.check_supervisor(health.identity, service, fenced=True)
        if health.freeze_id != record.update_id:
            raise BackendError("freeze_identity_mismatch", status=503)
        self.verify_clean(health)
        await wait_exited(service.process_lease, 30)
        service.state = "stopped"
        await self.store.save_service(service)
        self.attached = ""
        await self.supervisor.close()
        self.supervisor = SupervisorClient(self.profile.socket("supervisor"), self.profile.token)
        if record.phase in {"freezing", "retiring"}:
            record.phase = "prepared"
        return await self.store.save_update(record)

    async def ensure_supervisor(self, *, for_shutdown: bool = False) -> Identity:
        async with self.service_lock:
            if for_shutdown:
                if self.storage_failed:
                    raise BackendError("storage_blocked", status=503)
                if not self.closing:
                    raise BackendError("shutdown_not_admitted", status=503)
            else:
                self.admit()
            active = await self.store.active_update()
            if (
                active
                and active.phase in {"prepared", "validating", "completed"}
                and (self.build == active.source_build != active.target_build)
            ):
                raise BackendError("update_prepared", status=503)
            records = await self.store.services()
            if active is None and records and (records[-1].build_id != self.build):
                active = await self.store.begin_update(
                    PrepareUpdate(update_id="replace-" + self.instance, target_build=self.build),
                    records[-1].build_id,
                )
            if active and self.build not in {active.source_build, active.target_build}:
                raise BackendError("update_target_mismatch")
            for service in records:
                dead = exited(service.process_lease)
                if service.state == "stopped":
                    if not dead:
                        raise BackendError("supervisor_exit_unproven", status=503)
                    continue
                if dead:
                    unexpected = service.state != "stopping"
                    service.state = "stopped"
                    await self.store.save_service(service)
                    self.attached = ""
                    await self.supervisor.close()
                    self.supervisor = SupervisorClient(self.profile.socket("supervisor"), self.profile.token)
                    if unexpected:
                        await self.store.allow_restart()
            record = await self.store.service()
            if record and (record.build_id != self.build or record.state == "stopping"):
                await self._await_service(record)
                if active is None:
                    active = await self.store.begin_update(
                        PrepareUpdate(update_id="replace-" + self.instance, target_build=self.build),
                        record.build_id,
                    )
                active = await self.retire_service(record, active)
                record = None
                if self.build == active.source_build != active.target_build:
                    raise BackendError("update_prepared", status=503)
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
                if identity.state == "stopping":
                    raise BackendError("supervisor_retirement_pending", status=503)
                record.state = "running"
                await self.store.save_service(record)
                self.attached = record.instance_id
            active = await self.store.active_update()
            if active:
                health = await self.supervisor.call(
                    "POST",
                    "/freeze",
                    SupervisorHealth,
                    FreezeSupervisor(**self.fence.model_dump(), freeze_id=active.update_id),
                )
                self.check_supervisor(health.identity, record, fenced=True)
                if health.freeze_id != active.update_id:
                    raise BackendError("freeze_identity_mismatch", status=503)
                await self.update_health(active, health, record)
            return identity

    async def update_matches_supervisor(self) -> bool:
        active = await self.store.active_update()
        if active is None:
            return False
        try:
            health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        except httpx.TransportError as error:
            raise BackendError("update_prepared", status=503) from error
        if health.freeze_id != active.update_id:
            raise BackendError("update_frozen", status=503)
        return True

    def stored_during_update(self, frozen: bool, error: BackendError) -> NoReturn:
        if frozen and error.code == "supervisor_frozen":
            raise BackendError("update_frozen", status=503) from error
        raise error

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

    @staticmethod
    def verify_retired(workers: list[WorkerInfo]) -> None:
        for worker in workers:
            if worker.process_lease is None or not exited(worker.process_lease) or worker.state != "stopped":
                raise BackendError("participant_exit_unproven", worker.worker_id, 503)

    @staticmethod
    def verify_frozen(snapshot: Snapshot, session: str, record: UpdateRecord) -> None:
        if snapshot.session_id != session or snapshot.state != "frozen":
            raise BackendError("session_freeze_unproven", status=503)
        if record.cancel_work and snapshot.pending:
            raise BackendError("update_cancellation_pending", status=503)

    def verify_validation(self, info: WorkerInfo | None, health: SupervisorHealth) -> None:
        if (
            info is None
            or info.build_id != self.build
            or info.fingerprint != self.build
            or (info.purpose != "validation")
            or (info.host_epoch != self.fence.host_epoch)
            or (info.execution_epoch <= 0)
        ):
            raise BackendError("validation_worker_mismatch", status=503)
        probes = [
            epoch
            for epoch in health.epochs
            if epoch.worker_id == info.worker_id
            and epoch.session_id == info.session_id
            and (epoch.execution_epoch == info.execution_epoch)
        ]
        if len(probes) != 1:
            raise BackendError("validation_probe_missing", status=503)
        probe = probes[0]
        proof = probe.cleanup
        if (
            probe.state != "clean"
            or proof is None
            or proof.state != "clean"
            or (not proof.proof_id)
            or (proof.session_id != info.session_id)
            or (proof.execution_epoch != info.execution_epoch)
            or proof.resources
        ):
            raise BackendError("validation_probe_unproven", status=503)

    async def health(self) -> Health:
        try:
            return await self._health()
        except BackendError:
            if not self.storage_failed:
                raise
            return Health(
                identity=self.identity("blocked"),
                state="blocked",
                supervisor=None,
                update=None,
                pending_deliveries=0,
                errors=["storage_failed"],
            )

    async def _health(self) -> Health:
        active = await self.store.active_update()
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
                if current.identity.build_id != self.build:
                    errors.append("build_mismatch")
                if active:
                    HostStore.verify_roster(active.roster, current.workers)
                    if current.freeze_id != active.update_id:
                        errors.append("freeze_identity_mismatch")
                elif current.freeze_id:
                    errors.append("unexpected_freeze")
            except (BackendError, httpx.TransportError, TimeoutError):
                errors.append("supervisor_unavailable")
        elif not active or active.phase not in {"prepared", "validating", "completed"}:
            errors.append("supervisor_unavailable")
        if self.storage_failed:
            errors.append("storage_failed")
        blocked = await self.store.blocked()
        if blocked:
            errors.append(blocked)
        state = "blocked" if errors else "frozen" if active else "ready"
        return Health(
            identity=self.identity(state),
            state=state,
            supervisor=current,
            update=active,
            pending_deliveries=len(await self.store.pending()),
            errors=errors,
            supervisors=records,
        )

    async def stop_owned_supervisor(self) -> None:
        """Persist supervisor shutdown before any caller treats the host as stopped."""
        async with self.service_lock:
            if not self.initialized:
                return
            service = await self.store.service()
            if service is None or service.state == "stopped":
                return
            if exited(service.process_lease):
                service.state = "stopped"
                await self.store.save_service(service)
                return
            identity = await self._await_service(service)
            self.check_supervisor(identity, service)
            service.state = "stopping"
            await self.store.save_service(service)
            await self.supervisor.call(
                "POST",
                "/shutdown",
                Identity,
                HostFence(host_epoch=self.fence.host_epoch, build_id=service.build_id),
            )
            await wait_exited(service.process_lease, 30)
            service.state = "stopped"
            await self.store.save_service(service)
