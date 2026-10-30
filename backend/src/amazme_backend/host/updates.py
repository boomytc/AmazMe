from __future__ import annotations

import secrets
from pathlib import Path

from amazme_backend.contracts.events import Snapshot
from amazme_backend.contracts.execution import Cleanup, SupervisorHealth, WorkerInfo
from amazme_backend.contracts.host import CompleteUpdate, Health, PrepareUpdate, UpdateRecord
from amazme_backend.contracts.ipc.supervisor import FreezeSupervisor, Recovery, StopWorker
from amazme_backend.contracts.ipc.worker import FreezeWorker
from amazme_backend.execution.processes import exited, wait_exited
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.host.store import HostStore
from amazme_backend.platform.ipc import Peer
from amazme_backend.profiles.profile import wait_peer
from amazme_backend.shared.errors import BackendError


class UpdateOperations:
    def __init__(self, access: WorkerSessions, lifecycle: HostLifecycle):
        self.access = access
        self.lifecycle = lifecycle

    async def _stop_info(self, info: WorkerInfo) -> WorkerInfo:
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        HostStore.verify_roster([info], health.workers)
        current = next((w for w in health.workers if w.worker_id == info.worker_id))
        if current.process_lease is None:
            raise BackendError("participant_exit_unproven", status=503)
        if current.state != "stopped":
            cleanup = await self.lifecycle.supervisor.call(
                "POST",
                "/workers/stop",
                Cleanup,
                StopWorker(
                    **self.lifecycle.fence.model_dump(),
                    session_id=current.session_id,
                    worker_id=current.worker_id,
                    execution_epoch=current.execution_epoch,
                    reason="update",
                ),
            )
            if (
                cleanup.state != "clean"
                or not cleanup.proof_id
                or cleanup.session_id != current.session_id
                or (cleanup.execution_epoch != current.execution_epoch)
            ):
                raise BackendError("execution_cleanup_pending", status=503)
        await wait_exited(current.process_lease)
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        HostStore.verify_roster([current], health.workers)
        current = next((w for w in health.workers if w.worker_id == info.worker_id))
        self.lifecycle.verify_retired([current])
        active = await self.lifecycle.store.active_update()
        if active:
            await self.lifecycle.update_health(active, health)
        cached = self.access.worker_peers.pop(current.session_id, None)
        if cached:
            await cached[1].close()
        return current

    async def prepare_update(self, value: PrepareUpdate) -> UpdateRecord:
        async with self.lifecycle.update_lock:
            self.lifecycle.admit()
            record = await self.lifecycle.store.begin_update(value, self.lifecycle.build)
            try:
                return await self._prepare(record)
            except Exception as error:
                if not self.lifecycle.storage_failed:
                    record = await self.lifecycle.store.update(record.update_id)
                    record.error = error.code if isinstance(error, BackendError) else type(error).__name__
                    await self.lifecycle.store.save_update(record)
                raise

    async def _prepare(self, record: UpdateRecord) -> UpdateRecord:
        if record.phase in {"prepared", "validating", "completed"}:
            return record
        if self.lifecycle.build != record.source_build:
            raise BackendError("update_source_mismatch")
        try:
            await self.lifecycle.ensure_supervisor()
        except BackendError as error:
            if error.code != "update_prepared":
                raise
        record = await self.lifecycle.store.update(record.update_id)
        if record.phase in {"prepared", "validating", "completed"}:
            return record
        health = await self.lifecycle.supervisor.call(
            "POST",
            "/freeze",
            SupervisorHealth,
            FreezeSupervisor(**self.lifecycle.fence.model_dump(), freeze_id=record.update_id),
        )
        record = await self.lifecycle.update_health(record, health)
        sessions = {s.session_id for s in (await self.lifecycle.store.sessions()).sessions}
        sessions.update((w.session_id for w in health.workers))
        removed = await self.lifecycle.store.removed_sessions()
        for session in sorted(sessions):
            current = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
            record = await self.lifecycle.update_health(record, current)
            live = [w for w in current.workers if w.session_id == session and w.state != "stopped"]
            if len(live) > 1:
                raise BackendError("participant_identity_mismatch", status=503)
            if session in removed:
                if live:
                    await self._stop_info(live[0])
                continue
            if live and (
                live[0].state in {"stopping", "blocked", "unknown"}
                or live[0].process_lease is None
                or exited(live[0].process_lease)
            ):
                await self._stop_info(live[0])
                live = []
            if live:
                info = live[0]
                peer = Peer(Path(info.socket), self.lifecycle.profile.token)
                try:
                    identity = await wait_peer(
                        peer,
                        self.lifecycle.build,
                        instance=info.worker_id,
                        profile=self.lifecycle.profile.config.profile_id,
                    )
                    if identity.role != "worker" or identity.fingerprint != self.lifecycle.build:
                        raise BackendError("worker_identity_mismatch", status=503)
                    snapshot = await peer.call(
                        "POST",
                        "/freeze",
                        Snapshot,
                        FreezeWorker(
                            **self.lifecycle.fence.model_dump(),
                            freeze_id=record.update_id,
                            cancel_work=record.cancel_work,
                        ),
                    )
                finally:
                    await peer.close()
            else:
                peer = await self.access.worker(
                    session, maintenance=True, validation_probe=True, update_id=record.update_id
                )
                snapshot = await peer.call(
                    "POST",
                    "/freeze",
                    Snapshot,
                    FreezeWorker(
                        **self.lifecycle.fence.model_dump(),
                        freeze_id=record.update_id,
                        cancel_work=record.cancel_work,
                    ),
                )
                current = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                record = await self.lifecycle.update_health(record, current)
                info = next((w for w in current.workers if w.session_id == session and w.state != "stopped"))
            await self._stop_info(info)
            self.lifecycle.verify_frozen(snapshot, session, record)
        record = await self.lifecycle.store.update(record.update_id)
        record.phase, record.error = ("retiring", "")
        record = await self.lifecycle.store.save_update(record)
        async with self.lifecycle.service_lock:
            service = await self.lifecycle.store.service()
            if service is None:
                raise BackendError("supervisor_unavailable", status=503)
            record = await self.lifecycle.retire_service(service, record)
        return record

    async def resume_update(self, identity: str) -> UpdateRecord:
        async with self.lifecycle.update_lock:
            self.lifecycle.admit()
            record = await self.lifecycle.store.update(identity)
            if record.activated:
                return record
            if self.lifecycle.build == record.source_build != record.target_build:
                return await self._prepare(record)
            if self.lifecycle.build != record.target_build:
                raise BackendError("update_target_mismatch")
            return await self._validate_target(record)

    async def _validate_target(self, record: UpdateRecord) -> UpdateRecord:
        if self.lifecycle.build != record.target_build:
            raise BackendError("update_target_mismatch")
        if record.source_build == self.lifecycle.build and record.phase in {"freezing", "retiring"}:
            record = await self._prepare(record)
        await self.lifecycle.ensure_supervisor()
        record = await self.lifecycle.store.update(record.update_id)
        for lease in await self.lifecycle.store.source_hosts(self.lifecycle.instance):
            await wait_exited(lease)
        for service in await self.lifecycle.store.services():
            if service.instance_id != self.lifecycle.attached and (not exited(service.process_lease)):
                raise BackendError("old_supervisor_alive", status=503)
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self.lifecycle.update_health(record, health)
        for worker in health.workers:
            if worker.state != "stopped":
                await self._stop_info(worker)
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self.lifecycle.update_health(record, health)
        self.lifecycle.verify_clean(health)
        sessions = {s.session_id for s in (await self.lifecycle.store.sessions()).sessions}
        sessions.update((w.session_id for w in health.workers))
        sessions.difference_update(await self.lifecycle.store.removed_sessions())
        if not sessions:
            sessions.add(secrets.token_hex(16))
        validation: WorkerInfo | None = None
        for session in sorted(sessions):
            peer = await self.access.worker(
                session, maintenance=True, validation_probe=True, update_id=record.update_id
            )
            await peer.call(
                "POST",
                "/freeze",
                Snapshot,
                FreezeWorker(
                    **self.lifecycle.fence.model_dump(),
                    freeze_id=record.update_id,
                    cancel_work=record.cancel_work,
                ),
            )
            snapshot = await peer.call("GET", "/snapshot", Snapshot)
            health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
            record = await self.lifecycle.update_health(record, health)
            info = next((w for w in health.workers if w.session_id == session and w.state != "stopped"), None)
            self.lifecycle.verify_validation(info, health)
            assert info is not None
            validation = await self._stop_info(info)
            self.lifecycle.verify_frozen(snapshot, session, record)
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self.lifecycle.update_health(record, health)
        self.lifecycle.verify_clean(health)
        if health.freeze_id != record.update_id:
            raise BackendError("freeze_identity_mismatch", status=503)
        if validation is None:
            raise BackendError("validation_worker_missing", status=503)
        record.validation = validation
        record.phase = "completed" if record.phase == "completed" else "validating"
        record.error = ""
        record = await self.lifecycle.store.save_update(record)
        return record

    async def complete_update(self, value: CompleteUpdate) -> UpdateRecord:
        async with self.lifecycle.update_lock:
            self.lifecycle.admit()
            record = await self.lifecycle.store.update(value.update_id)
            if record.activated:
                return record
            if self.lifecycle.build != record.target_build:
                raise BackendError("update_target_mismatch")
            if record.revision != value.expected_revision and record.phase != "completed":
                raise BackendError("update_revision_conflict")
            record = await self._validate_target(record)
            sessions = {s.session_id for s in (await self.lifecycle.store.sessions()).sessions}
            sessions.update((w.session_id for w in record.roster))
            sessions.difference_update(await self.lifecycle.store.removed_sessions())
            for session in sorted(sessions):
                peer = await self.access.worker(
                    session, maintenance=True, validation_probe=True, update_id=record.update_id
                )
                await peer.call(
                    "POST",
                    "/freeze",
                    Snapshot,
                    FreezeWorker(**self.lifecycle.fence.model_dump(), freeze_id=record.update_id),
                )
                await peer.call(
                    "POST",
                    "/thaw",
                    Snapshot,
                    FreezeWorker(**self.lifecycle.fence.model_dump(), freeze_id=record.update_id),
                )
                health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                record = await self.lifecycle.update_health(record, health)
                info = next((w for w in health.workers if w.session_id == session and w.state != "stopped"))
                self.lifecycle.verify_validation(info, health)
                await self._stop_info(info)
            health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
            record = await self.lifecycle.update_health(record, health)
            self.lifecycle.verify_clean(health)
            record.phase = "completed"
            record = await self.lifecycle.store.save_update(record)
            thawed = await self.lifecycle.supervisor.call(
                "POST",
                "/thaw",
                SupervisorHealth,
                FreezeSupervisor(
                    **self.lifecycle.fence.model_dump(),
                    freeze_id=record.update_id,
                    expected_revision=health.registry_revision,
                ),
            )
            record = await self.lifecycle.update_health(record, thawed)
            self.lifecycle.verify_clean(thawed)
            if thawed.freeze_id:
                raise BackendError("freeze_identity_mismatch", status=503)
            record.activated = True
            record = await self.lifecycle.store.save_update(record)
            await self.lifecycle.store.demand()
            return record

    async def recover(self, value: Recovery) -> Health:
        self.lifecycle.admit()
        if value.host_epoch != self.lifecycle.fence.host_epoch or value.build_id != self.lifecycle.build:
            raise BackendError("stale_host_epoch")
        await self.lifecycle.store.allow_restart(explicit=True)
        await self.lifecycle.ensure_supervisor()
        await self.lifecycle.supervisor.call("POST", "/recover", SupervisorHealth, value)
        await self.lifecycle.store.demand(value.session_id)
        return await self.lifecycle.health()
