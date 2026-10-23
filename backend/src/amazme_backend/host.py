import asyncio
import contextlib
import json
import os
import secrets
import socket
import sqlite3
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .common import Peer, Profile, build_id, child_command, lock, private_write, wait_peer
from .contracts import (
    ApprovalDecision,
    ApprovalEnvelope,
    ArchiveSession,
    Attachment,
    BackendError,
    BranchSession,
    Cancel,
    Cleanup,
    Compaction,
    CompactSession,
    CompleteUpdate,
    CreateSession,
    EffectResolution,
    FreezeSupervisor,
    FreezeWorker,
    Health,
    HostFence,
    Identity,
    Message,
    Model,
    ModelCatalog,
    ModelSettings,
    PrepareUpdate,
    ProcessLease,
    Receipt,
    Recovery,
    ResolutionEnvelope,
    RetireSupervisor,
    Session,
    SessionList,
    Snapshot,
    StopWorker,
    Submission,
    Submit,
    SupervisorHealth,
    UpdateModelSettings,
    UpdateRecord,
    WorkerActivity,
    WorkerInfo,
    WorkerSpec,
)
from .faults import Faults
from .host_store import Delivery, HostStore, ServiceRecord
from .processes import ProcessReservation, exited, retain_inherited, wait_exited
from .providers import CATALOG, choose_model, public_settings, summarize
from .storage import (
    TERMINAL,
    SessionStore,
    compaction_basis,
    read_settled_root,
    remove_session_directory,
    session_database,
)
from .transport import app_factory


class Login(Model):
    token: str = Field(min_length=1, max_length=256)


class ReadPeer(Peer):
    """A borrowed diagnostic capability cannot issue business mutations or close its owner."""

    def __init__(self, peer: Peer):
        self.peer = peer

    async def call[T: BaseModel](self, method: str, path: str, response: type[T], body: BaseModel | None = None) -> T:
        if method != "GET" or body is not None:
            raise BackendError("read_only_peer")
        return await self.peer.call(method, path, response)

    async def close(self) -> None:
        pass


class Host:
    def __init__(self, profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None):
        self.profile = profile
        self.build = build_id()
        self.instance = instance or secrets.token_hex(16)
        self.process_lease = process_lease
        self.store = HostStore(profile.path / "host.sqlite", require_existing=(profile.path / "initialized").exists())
        self.supervisor = Peer(profile.socket("supervisor"), profile.token)
        self.fence = HostFence(host_epoch=0, build_id=self.build)
        self.worker_peers: dict[str, tuple[str, Peer]] = {}
        self.worker_locks: dict[str, asyncio.Lock] = {}
        self.delivery_locks: dict[str, asyncio.Lock] = {}
        self.service_lock = asyncio.Lock()
        self.update_lock = asyncio.Lock()
        self.attached = ""
        self.stop = asyncio.Event()
        self.closing = False
        self.initialized = False
        self.storage_failed = False
        self.background: asyncio.Task[None] | None = None
        self.child: asyncio.subprocess.Process | None = None
        self.web_token = (profile.path / "web.token").read_text().strip()
        self.origin = ""
        self.attachments: dict[str, Attachment] = {}
        self.attachment_seen: dict[str, float] = {}
        self.faults = Faults(profile.path, "host", self.instance, enabled=profile.config.testing)

    @property
    def storage_failed(self) -> bool:
        return self._storage_failed or self.store.failed or bool(self.store.db.failure)

    @storage_failed.setter
    def storage_failed(self, value: bool) -> None:
        self._storage_failed = value

    def _admit(self) -> None:
        if self.storage_failed:
            raise BackendError("storage_blocked", status=503)
        if self.closing:
            raise BackendError("host_stopping", status=503)

    def identity(self, state: str = "ready") -> Identity:
        return self.profile.identity(self.instance, self.build, role="host", state=state, host_epoch=self.fence.host_epoch)

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
        if active is None and previous_build and previous_build != self.build:
            active = await self.store.begin_update(PrepareUpdate(
                update_id="replace-" + self.instance, target_build=self.build), previous_build)
        if active and self.build not in {active.source_build, active.target_build}:
            raise BackendError("update_target_mismatch")
        if not (active and active.phase in {"prepared", "validating", "completed"}
                and self.build == active.source_build != active.target_build):
            try:
                await self.ensure_supervisor()
            except (BackendError, httpx.TransportError, TimeoutError):
                # Preserve the diagnostic/control surface when recovery cannot prove safety.
                self.attached = ""
        await self.store.demand()
        self.background = asyncio.create_task(self.dispatcher())

    async def _spawn_supervisor(self) -> ServiceRecord:
        instance = secrets.token_hex(16)
        required = await self.store.execution_initialized()
        with ProcessReservation(self.profile.path, "supervisor", instance) as reservation:
            record = ServiceRecord(instance_id=instance, build_id=self.build,
                                   process_lease=reservation.lease, state="starting")
            await self.store.save_service(record)
            log_fd = os.open(self.profile.path / "supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                args = child_command("supervisor", "--profile", str(self.profile.path), "--instance", instance,
                                     "--lifetime-fd", str(reservation.fd))
                if required:
                    args.append("--require-existing-store")
                self.child = await asyncio.create_subprocess_exec(*args, pass_fds=(reservation.fd,),
                    stdin=asyncio.subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, start_new_session=True)
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
                    record.instance_id, self.profile.config.profile_id, record.build_id, "supervisor"):
                    raise BackendError("supervisor_identity_mismatch")
                if identity.fingerprint != identity.build_id:
                    raise BackendError("component_fingerprint_mismatch")
                return identity
            except (httpx.TransportError, TimeoutError):
                await asyncio.sleep(0.1)
        raise BackendError("supervisor_startup_timeout", status=503)

    def _check_supervisor(self, identity: Identity, record: ServiceRecord, *, fenced: bool = False) -> None:
        if (identity.instance_id, identity.profile_id, identity.build_id, identity.role, identity.fingerprint) != (
            record.instance_id, self.profile.config.profile_id, record.build_id, "supervisor", record.build_id
        ) or identity.protocol != "amazme-http/1" or (fenced and identity.host_epoch != self.fence.host_epoch):
            raise BackendError("supervisor_identity_mismatch", status=503)

    async def _update_health(self, record: UpdateRecord, health: SupervisorHealth,
                             service: ServiceRecord | None = None) -> UpdateRecord:
        fenced = service is None
        service = service or await self.store.service()
        if service is None:
            raise BackendError("supervisor_unavailable", status=503)
        self._check_supervisor(health.identity, service, fenced=fenced)
        if fenced and health.identity.state == "stopping":
            raise BackendError("supervisor_retirement_pending", status=503)
        return await self.store.source_roster(record.update_id, health.workers)

    @classmethod
    def _verify_clean(cls, health: SupervisorHealth) -> None:
        cls._verify_retired(health.workers)
        workers = {worker.worker_id: worker for worker in health.workers}
        if health.blocked or health.identity.state == "blocked":
            raise BackendError("update_health_blocked", status=503)
        for epoch in health.epochs:
            cleanup = epoch.cleanup
            worker = workers.get(epoch.worker_id)
            if (epoch.state != "clean" or cleanup is None or cleanup.state != "clean" or not cleanup.proof_id
                    or cleanup.session_id != epoch.session_id or cleanup.execution_epoch != epoch.execution_epoch
                    or worker is None or worker.session_id != epoch.session_id):
                raise BackendError("execution_cleanup_pending", status=503)

    async def _retire_service(self, service: ServiceRecord, record: UpdateRecord) -> UpdateRecord:
        before = await self.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self._update_health(record, before, service)
        service.state = "stopping"
        await self.store.save_service(service)
        health = await self.supervisor.call("POST", "/retire", SupervisorHealth, RetireSupervisor(
            host_epoch=self.fence.host_epoch, build_id=service.build_id, freeze_id=record.update_id))
        record = await self._update_health(record, health, service)
        self._check_supervisor(health.identity, service, fenced=True)
        if health.freeze_id != record.update_id:
            raise BackendError("freeze_identity_mismatch", status=503)
        self._verify_clean(health)
        await wait_exited(service.process_lease, 30)
        service.state = "stopped"
        await self.store.save_service(service)
        self.attached = ""
        await self.supervisor.close()
        self.supervisor = Peer(self.profile.socket("supervisor"), self.profile.token)
        if record.phase in {"freezing", "retiring"}:
            record.phase = "prepared"
        return await self.store.save_update(record)

    async def ensure_supervisor(self) -> Identity:
        async with self.service_lock:
            self._admit()
            active = await self.store.active_update()
            if (active and active.phase in {"prepared", "validating", "completed"}
                    and self.build == active.source_build != active.target_build):
                raise BackendError("update_prepared", status=503)
            records = await self.store.services()
            # Capture the build change before a dead service is removed from selection.
            if active is None and records and records[-1].build_id != self.build:
                active = await self.store.begin_update(PrepareUpdate(
                    update_id="replace-" + self.instance, target_build=self.build), records[-1].build_id)
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
                    self.supervisor = Peer(self.profile.socket("supervisor"), self.profile.token)
                    if unexpected:
                        await self.store.allow_restart()
            record = await self.store.service()
            if record and (record.build_id != self.build or record.state == "stopping"):
                await self._await_service(record)
                if active is None:
                    active = await self.store.begin_update(PrepareUpdate(
                        update_id="replace-" + self.instance, target_build=self.build), record.build_id)
                active = await self._retire_service(record, active)
                record = None
                if self.build == active.source_build != active.target_build:
                    raise BackendError("update_prepared", status=503)
            if record is None:
                if await self.store.blocked():
                    raise BackendError("supervisor_restart_budget", status=503)
                record = await self._spawn_supervisor()
            identity = await self._await_service(record)
            self._check_supervisor(identity, record)
            if identity.state == "stopping":
                raise BackendError("supervisor_retirement_pending", status=503)
            if self.attached != record.instance_id:
                identity = await self.supervisor.call("POST", "/takeover", Identity, self.fence)
                self._check_supervisor(identity, record, fenced=True)
                if identity.state == "stopping":
                    raise BackendError("supervisor_retirement_pending", status=503)
                record.state = "running"
                await self.store.save_service(record)
                self.attached = record.instance_id
            # Also re-freeze after a lost thaw ACK on the same Host instance.
            active = await self.store.active_update()
            if active:
                health = await self.supervisor.call("POST", "/freeze", SupervisorHealth,
                    FreezeSupervisor(**self.fence.model_dump(), freeze_id=active.update_id))
                self._check_supervisor(health.identity, record, fenced=True)
                if health.freeze_id != active.update_id:
                    raise BackendError("freeze_identity_mismatch", status=503)
                await self._update_health(active, health, record)
            return identity

    async def sessions(self) -> SessionList:
        return await self.store.sessions()

    def model_catalog(self) -> ModelCatalog:
        self._admit()
        self.profile.reload_provider()
        return ModelCatalog(models=list(CATALOG), current=public_settings(self.profile.config.provider))

    async def update_model(self, value: UpdateModelSettings) -> ModelSettings:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        self.profile.reload_provider()
        chosen = choose_model(self.profile.config.provider, value)
        self.profile.save_provider(chosen)
        return public_settings(self.profile.config.provider)

    async def create_session(self, value: CreateSession) -> Session:
        self._admit()
        return await self.store.create_session(secrets.token_hex(16), value)

    async def branch_session(self, parent: str, value: BranchSession) -> Session:
        self._admit()
        if not await self.store.exists(parent):
            raise BackendError("session_not_found", status=404)
        parent_path = session_database(self.profile.path, parent)
        read_settled_root(parent_path, value.request_id)
        source = next(item for item in (await self.sessions()).sessions if item.session_id == parent)
        if source.archived:
            raise BackendError("session_archived")
        title = value.title.strip() or f"分支：{source.title}"
        child_id = secrets.token_hex(16)
        created = await self.store.create_branch(child_id, parent, value.request_id, title[:100])
        directory = session_database(self.profile.path, child_id).parent
        child: SessionStore | None = None
        try:
            directory.mkdir(parents=True, mode=0o700)
            child = SessionStore(directory / "session.sqlite", child_id, build=self.build,
                                 config=self.profile.config.provider,
                                 approval_policy=self.profile.config.approval_policy)
            await child.initialize()
            await child.import_settled_root(parent_path, value.request_id)
        except Exception:
            if child is not None:
                await child.db.close()
                child = None
            await self.store.discard_unopened_branch(child_id)
            remove_session_directory(directory)
            raise
        await child.db.close()
        return created

    async def archive_session(self, session: str, archived: bool) -> Session:
        self._admit()
        updated = await self.store.set_archived(session, archived)
        if archived:
            await self._cancel_unstarted(session)
        return updated

    async def _cancel_unstarted(self, session: str) -> None:
        path = session_database(self.profile.path, session)
        if not path.is_file():
            return
        worker = SessionStore(path, session, build=self.build, config=self.profile.config.provider,
                             approval_policy=self.profile.config.approval_policy, require_existing=True)
        try:
            await worker.initialize()
            fence = HostFence(host_epoch=await worker.host_epoch(), build_id=self.build)
            for receipt in (await worker.snapshot()).requests:
                if receipt.kind == "root" and receipt.status not in TERMINAL and not receipt.cancel_requested:
                    await worker.cancel(receipt.request_id, fence)
        finally:
            await worker.db.close()

    async def compact_session(self, session: str, value: CompactSession) -> Compaction:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        source = next(item for item in (await self.sessions()).sessions if item.session_id == session)
        if source.archived:
            raise BackendError("session_archived")
        path = session_database(self.profile.path, session)
        if not path.is_file():
            raise BackendError("compaction_unsettled")
        worker = SessionStore(path, session, build=self.build, config=self.profile.config.provider,
                             approval_policy=self.profile.config.approval_policy, require_existing=True)
        try:
            await worker.initialize()
            payloads = await worker.message_payloads(value.through_request_id)
            if not payloads:
                raise BackendError("compaction_unsettled")
            basis = compaction_basis(payloads)
            # Summarize before the commit. A failed summary does not replace or delete history.
            summary = await summarize(self.profile.config.provider, [
                Message.model_validate_json(payload) for payload in payloads])
            return await worker.commit_compaction(value.compaction_id, value.through_request_id, summary, basis)
        finally:
            await worker.db.close()

    async def reader(self, session: str) -> ReadPeer:
        self._admit()
        async with self.worker_locks.setdefault(session, asyncio.Lock()):
            if not await self.store.exists(session):
                raise BackendError("session_not_found", status=404)
            active = await self.store.active_update()
            service = await self.store.service()
            if service and not exited(service.process_lease):
                if service.state in {"stopping", "stopped"} or service.build_id != self.build:
                    raise BackendError("supervisor_retirement_pending", status=503)
                health = await self.supervisor.call("GET", "/health", SupervisorHealth)
                self._check_supervisor(health.identity, service, fenced=True)
                if health.identity.state == "stopping":
                    raise BackendError("supervisor_retirement_pending", status=503)
                owners = [w for w in health.workers if w.session_id == session and w.state != "stopped"]
                if len(owners) > 1:
                    raise BackendError("participant_identity_mismatch", status=503)
                if owners:
                    info = owners[0]
                    if (info.build_id != self.build or info.host_epoch != self.fence.host_epoch
                            or info.fingerprint != self.build or info.process_lease is None
                            or exited(info.process_lease) or info.state == "stopping"):
                        raise BackendError("worker_identity_mismatch", status=503)
                    cached = self.worker_peers.get(session)
                    if cached and cached[0] != info.worker_id:
                        await cached[1].close()
                        self.worker_peers.pop(session, None)
                        cached = None
                    peer = cached[1] if cached else Peer(Path(info.socket), self.profile.token)
                    try:
                        identity = await wait_peer(peer, self.build, timeout=3, instance=info.worker_id,
                                                   profile=self.profile.config.profile_id)
                        if (identity.role != "worker" or identity.fingerprint != self.build
                                or identity.host_epoch != self.fence.host_epoch or identity.state == "stopping"
                                or exited(info.process_lease)):
                            raise BackendError("worker_identity_mismatch", status=503)
                    except BaseException:
                        await peer.close()
                        self.worker_peers.pop(session, None)
                        raise
                    self.worker_peers[session] = (info.worker_id, peer)
                    return ReadPeer(peer)
                # The restart budget is already on the health list once the dead worker is retired.
                # Reporting it as a missing diagnostic hides the durable refusal and never reaches spawn.
                budget = "worker_restart_budget_exhausted:" + session
                if (budget in health.blocked and health.identity.state != "blocked"
                        and all(item == budget for item in health.blocked)):
                    raise BackendError("worker_restart_budget_exhausted", status=503)
                if health.blocked or health.identity.state == "blocked":
                    raise BackendError("diagnostic_worker_unavailable", status=503)
            if active:
                raise BackendError("update_frozen", status=503)
        # A healthy profile may initialize an unopened session through normal admission.
        return ReadPeer(await self.worker(session))

    async def worker(self, session: str, *, maintenance: bool = False, validation_probe: bool = False,
                     update_id: str = "") -> Peer:
        self._admit()
        if maintenance and not update_id and not validation_probe:
            return await self.reader(session)
        async with self.worker_locks.setdefault(session, asyncio.Lock()):
            if not await self.store.exists(session) and not validation_probe:
                raise BackendError("session_not_found", status=404)
            active = await self.store.active_update()
            if active and (not maintenance or update_id != active.update_id):
                raise BackendError("update_frozen", status=503)
            if validation_probe and (active is None or not update_id):
                raise BackendError("validation_requires_update")
            await self.ensure_supervisor()
            active = await self.store.active_update()
            if active and (not maintenance or update_id != active.update_id):
                raise BackendError("update_frozen", status=503)
            purpose = "validation" if active else "business"
            info = await self.supervisor.call("POST", "/workers/ensure", WorkerInfo, WorkerSpec(
                **self.fence.model_dump(), session_id=session, frozen=active is not None, purpose=purpose))
            if (info.session_id != session or info.build_id != self.build or info.purpose != purpose
                    or info.process_lease is None or exited(info.process_lease)
                    or info.fingerprint not in {"", self.build}
                    or info.state not in {"starting", "ready", "frozen"}):
                raise BackendError("worker_identity_mismatch", status=503)
            cached = self.worker_peers.get(session)
            if cached and cached[0] == info.worker_id:
                return cached[1]
            if cached:
                await cached[1].close()
            peer = Peer(Path(info.socket), self.profile.token)
            try:
                identity = await wait_peer(peer, self.build, timeout=30, instance=info.worker_id,
                                           profile=self.profile.config.profile_id)
                if (identity.role != "worker" or identity.fingerprint != self.build
                        or identity.host_epoch != self.fence.host_epoch):
                    raise BackendError("worker_identity_mismatch", status=503)
                if active:
                    await self._update_health(active, await self.supervisor.call("GET", "/health", SupervisorHealth))
            except BaseException:
                await peer.close()
                raise
            self.worker_peers[session] = (info.worker_id, peer)
            return peer

    def check_attachment(self, identity: str, session: str) -> Attachment:
        value = self.attachments.get(identity)
        if (value is None or value.session_id != session or value.host_epoch != self.fence.host_epoch
                or value.build_id != self.build or time.monotonic() - self.attachment_seen.get(identity, 0) > 300):
            raise BackendError("stale_client_binding")
        self.attachment_seen[identity] = time.monotonic()
        return value

    async def deliver(self, session: str, kind: Literal["submit", "cancel", "approval", "resolve"], key: str, value: Model) -> Receipt:
        self._admit()
        delivery = await self.store.enqueue(session, kind, key, value)
        if delivery.state == "rejected":
            raise BackendError(delivery.error_code, status=delivery.error_status)
        if delivery.receipt is not None:
            # A duplicate acceptance returns the current durable receipt when available.
            with contextlib.suppress(httpx.TransportError, BackendError):
                return await (await self.worker(session, maintenance=True)).call(
                    "GET", "/requests/" + quote(delivery.receipt.request_id, safe=""), Receipt)
            return delivery.receipt
        async with self.delivery_locks.setdefault(session, asyncio.Lock()):
            for pending in await self.store.pending(session):
                result = await self._dispatch(pending)
                if pending.delivery_id == delivery.delivery_id:
                    if result.receipt is not None:
                        return result.receipt
                    raise BackendError(result.error_code, status=result.error_status)
        # Another dispatcher may have adopted this receipt while we waited.
        result = await self.store.enqueue(session, kind, key, value)
        if result.receipt is not None:
            return result.receipt
        raise BackendError(result.error_code or "delivery_pending", status=result.error_status or 503)

    async def _dispatch(self, delivery: Delivery) -> Delivery:
        self._admit()
        peer = await self.worker(delivery.session_id)
        expected_request = ""
        try:
            if delivery.kind == "submit":
                value = Submit.model_validate_json(delivery.payload)
                expected_request = value.request_id
                receipt = await peer.call("POST", "/submissions", Receipt, Submission(**self.fence.model_dump(), value=value))
            elif delivery.kind == "cancel":
                value = Cancel.model_validate_json(delivery.payload)
                expected_request = value.request_id
                receipt = await peer.call("POST", "/requests/" + quote(value.request_id, safe="") + "/cancel", Receipt,
                                         Cancel(**self.fence.model_dump(), request_id=value.request_id))
            elif delivery.kind == "approval":
                approval = ApprovalDecision.model_validate_json(delivery.payload)
                receipt = await peer.call("POST", "/approvals", Receipt, ApprovalEnvelope(**self.fence.model_dump(), value=approval))
            else:
                resolution = EffectResolution.model_validate_json(delivery.payload)
                receipt = await peer.call("POST", "/effects/resolve", Receipt, ResolutionEnvelope(**self.fence.model_dump(), value=resolution))
            if expected_request and receipt.request_id != expected_request:
                raise BackendError("receipt_identity_mismatch", status=503)
            await self.faults.hit("delivery", session_id=delivery.session_id, request_id=receipt.request_id)
            result = await self.store.delivered(delivery.delivery_id, receipt)
            return result
        except BackendError as error:
            if error.code in {
                "request_conflict", "queue_full", "session_busy", "scheduled_steer_unsupported",
                "steer_target_settled", "context_limit", "approval_decision_conflict", "approval_not_found",
                "stale_approval", "resolution_conflict", "effect_not_found", "invalid_effect_resolution",
                "stale_effect_resolution",
            }:
                return await self.store.rejected(delivery.delivery_id, error)
            raise

    async def dispatcher(self) -> None:
        async def dispatch_session(session: str) -> None:
            try:
                async with self.delivery_locks.setdefault(session, asyncio.Lock()):
                    for delivery in await self.store.pending(session):
                        await self._dispatch(delivery)
                    peer = await self.worker(session)
                    await self.store.activity(session, await peer.call("GET", "/activity", WorkerActivity))
            except sqlite3.Error:
                self.storage_failed = True
            except (BackendError, httpx.TransportError, TimeoutError):
                return

        tasks: dict[str, asyncio.Task[None]] = {}
        try:
            while not self.stop.is_set():
                for session, task in list(tasks.items()):
                    if task.done():
                        task.result()
                        del tasks[session]
                try:
                    self._admit()
                    if await self.store.active_update() is None:
                        await self.ensure_supervisor()
                        sessions = {d.session_id for d in await self.store.pending()}
                        sessions.update(await self.store.due())
                        # A blocked call owns only its session, never a batch-wide barrier.
                        for session in sorted(sessions - tasks.keys()):
                            tasks[session] = asyncio.create_task(dispatch_session(session))
                except sqlite3.Error:
                    self.storage_failed = True
                except (BackendError, httpx.TransportError, TimeoutError):
                    pass
                await asyncio.sleep(0.5)
        finally:
            for task in tasks.values():
                task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    @staticmethod
    def _verify_retired(workers: list[WorkerInfo]) -> None:
        for worker in workers:
            if worker.process_lease is None or not exited(worker.process_lease) or worker.state != "stopped":
                raise BackendError("participant_exit_unproven", worker.worker_id, 503)

    @staticmethod
    def _verify_frozen(snapshot: Snapshot, session: str, record: UpdateRecord) -> None:
        if snapshot.session_id != session or snapshot.state != "frozen":
            raise BackendError("session_freeze_unproven", status=503)
        if record.cancel_work and snapshot.pending:
            raise BackendError("update_cancellation_pending", status=503)

    def _verify_validation(self, info: WorkerInfo | None, health: SupervisorHealth) -> None:
        if (info is None or info.build_id != self.build or info.fingerprint != self.build
                or info.purpose != "validation" or info.host_epoch != self.fence.host_epoch
                or info.execution_epoch <= 0):
            raise BackendError("validation_worker_mismatch", status=503)
        probes = [epoch for epoch in health.epochs if epoch.worker_id == info.worker_id
                  and epoch.session_id == info.session_id and epoch.execution_epoch == info.execution_epoch]
        if len(probes) != 1:
            raise BackendError("validation_probe_missing", status=503)
        probe = probes[0]
        proof = probe.cleanup
        if (probe.state != "clean" or proof is None or proof.state != "clean" or not proof.proof_id
                or proof.vm_id != health.vm_id or proof.session_id != info.session_id
                or proof.execution_epoch != info.execution_epoch or proof.containers):
            raise BackendError("validation_probe_unproven", status=503)

    async def health(self) -> Health:
        try:
            return await self._health()
        except BackendError:
            if not self.storage_failed:
                raise
            return Health(identity=self.identity("blocked"), state="blocked", supervisor=None, update=None,
                          pending_deliveries=0, errors=["storage_failed"])

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
                self._check_supervisor(current.identity, service, fenced=True)
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
        state = "blocked" if errors else ("frozen" if active else "ready")
        return Health(identity=self.identity(state), state=state, supervisor=current, update=active,
                      pending_deliveries=len(await self.store.pending()), errors=errors, supervisors=records)

    async def _stop_info(self, info: WorkerInfo) -> WorkerInfo:
        health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        HostStore.verify_roster([info], health.workers)
        current = next(w for w in health.workers if w.worker_id == info.worker_id)
        if current.process_lease is None:
            raise BackendError("participant_exit_unproven", status=503)
        if current.state != "stopped":
            cleanup = await self.supervisor.call("POST", "/workers/stop", Cleanup, StopWorker(
                **self.fence.model_dump(), session_id=current.session_id, worker_id=current.worker_id,
                execution_epoch=current.execution_epoch, reason="update"))
            if (cleanup.state != "clean" or not cleanup.proof_id or cleanup.session_id != current.session_id
                    or cleanup.execution_epoch != current.execution_epoch):
                raise BackendError("execution_cleanup_pending", status=503)
        await wait_exited(current.process_lease)
        health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        HostStore.verify_roster([current], health.workers)
        current = next(w for w in health.workers if w.worker_id == info.worker_id)
        self._verify_retired([current])
        active = await self.store.active_update()
        if active:
            await self._update_health(active, health)
        cached = self.worker_peers.pop(current.session_id, None)
        if cached:
            await cached[1].close()
        return current

    async def prepare_update(self, value: PrepareUpdate) -> UpdateRecord:
        async with self.update_lock:
            self._admit()
            record = await self.store.begin_update(value, self.build)
            try:
                return await self._prepare(record)
            except Exception as error:
                if not self.storage_failed:
                    record = await self.store.update(record.update_id)
                    record.error = error.code if isinstance(error, BackendError) else type(error).__name__
                    await self.store.save_update(record)
                raise

    async def _prepare(self, record: UpdateRecord) -> UpdateRecord:
        if record.phase in {"prepared", "validating", "completed"}:
            return record
        if self.build != record.source_build:
            raise BackendError("update_source_mismatch")
        try:
            await self.ensure_supervisor()
        except BackendError as error:
            if error.code != "update_prepared":
                raise
        record = await self.store.update(record.update_id)
        if record.phase in {"prepared", "validating", "completed"}:
            return record
        health = await self.supervisor.call("POST", "/freeze", SupervisorHealth,
            FreezeSupervisor(**self.fence.model_dump(), freeze_id=record.update_id))
        record = await self._update_health(record, health)
        await self.faults.hit("update_freeze", update_id=record.update_id)
        # Persist every discovered owner before stopping it. Replays retain the full history.
        sessions = {s.session_id for s in (await self.store.sessions()).sessions}
        sessions.update(w.session_id for w in health.workers)
        for session in sorted(sessions):
            current = await self.supervisor.call("GET", "/health", SupervisorHealth)
            record = await self._update_health(record, current)
            live = [w for w in current.workers if w.session_id == session and w.state != "stopped"]
            if len(live) > 1:
                raise BackendError("participant_identity_mismatch", status=503)
            if live and (live[0].state in {"stopping", "blocked", "unknown"}
                         or live[0].process_lease is None or exited(live[0].process_lease)):
                await self._stop_info(live[0])
                live = []
            if live:
                info = live[0]
                peer = Peer(Path(info.socket), self.profile.token)
                try:
                    identity = await wait_peer(peer, self.build, instance=info.worker_id, profile=self.profile.config.profile_id)
                    if identity.role != "worker" or identity.fingerprint != self.build:
                        raise BackendError("worker_identity_mismatch", status=503)
                    snapshot = await peer.call("POST", "/freeze", Snapshot, FreezeWorker(**self.fence.model_dump(),
                        freeze_id=record.update_id, cancel_work=record.cancel_work))
                finally:
                    await peer.close()
            else:
                peer = await self.worker(session, maintenance=True, validation_probe=True, update_id=record.update_id)
                snapshot = await peer.call("POST", "/freeze", Snapshot, FreezeWorker(**self.fence.model_dump(),
                    freeze_id=record.update_id, cancel_work=record.cancel_work))
                current = await self.supervisor.call("GET", "/health", SupervisorHealth)
                record = await self._update_health(record, current)
                info = next(w for w in current.workers if w.session_id == session and w.state != "stopped")
            await self._stop_info(info)
            self._verify_frozen(snapshot, session, record)
        record = await self.store.update(record.update_id)
        record.phase, record.error = "retiring", ""
        record = await self.store.save_update(record)
        async with self.service_lock:
            service = await self.store.service()
            if service is None:
                raise BackendError("supervisor_unavailable", status=503)
            record = await self._retire_service(service, record)
        await self.faults.hit("update_prepared", update_id=record.update_id)
        return record

    async def resume_update(self, identity: str) -> UpdateRecord:
        async with self.update_lock:
            self._admit()
            record = await self.store.update(identity)
            if record.activated:
                return record
            if self.build == record.source_build != record.target_build:
                return await self._prepare(record)
            if self.build != record.target_build:
                raise BackendError("update_target_mismatch")
            return await self._validate_target(record)

    async def _validate_target(self, record: UpdateRecord) -> UpdateRecord:
        if self.build != record.target_build:
            raise BackendError("update_target_mismatch")
        if record.source_build == self.build and record.phase in {"freezing", "retiring"}:
            record = await self._prepare(record)
        await self.ensure_supervisor()
        record = await self.store.update(record.update_id)
        for lease in await self.store.source_hosts(self.instance):
            await wait_exited(lease)
        for service in await self.store.services():
            if service.instance_id != self.attached and not exited(service.process_lease):
                raise BackendError("old_supervisor_alive", status=503)
        health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self._update_health(record, health)
        # No pre-existing business owner can be used for target metadata validation/thaw.
        for worker in health.workers:
            if worker.state != "stopped":
                await self._stop_info(worker)
        health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self._update_health(record, health)
        self._verify_clean(health)
        sessions = {s.session_id for s in (await self.store.sessions()).sessions}
        sessions.update(w.session_id for w in health.workers)
        if not sessions:
            sessions.add(secrets.token_hex(16))
        validation: WorkerInfo | None = None
        for session in sorted(sessions):
            peer = await self.worker(session, maintenance=True, validation_probe=True, update_id=record.update_id)
            await peer.call("POST", "/freeze", Snapshot, FreezeWorker(**self.fence.model_dump(),
                freeze_id=record.update_id, cancel_work=record.cancel_work))
            snapshot = await peer.call("GET", "/snapshot", Snapshot)
            health = await self.supervisor.call("GET", "/health", SupervisorHealth)
            record = await self._update_health(record, health)
            info = next((w for w in health.workers if w.session_id == session and w.state != "stopped"), None)
            self._verify_validation(info, health)
            assert info is not None
            validation = await self._stop_info(info)
            self._verify_frozen(snapshot, session, record)
        health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        record = await self._update_health(record, health)
        self._verify_clean(health)
        if health.freeze_id != record.update_id:
            raise BackendError("freeze_identity_mismatch", status=503)
        if validation is None:
            raise BackendError("validation_worker_missing", status=503)
        record.validation = validation
        record.phase = "completed" if record.phase == "completed" else "validating"
        record.error = ""
        record = await self.store.save_update(record)
        await self.faults.hit("update_health", update_id=record.update_id)
        return record

    async def complete_update(self, value: CompleteUpdate) -> UpdateRecord:
        async with self.update_lock:
            self._admit()
            record = await self.store.update(value.update_id)
            if record.activated:
                return record
            if self.build != record.target_build:
                raise BackendError("update_target_mismatch")
            if record.revision != value.expected_revision and record.phase != "completed":
                raise BackendError("update_revision_conflict")
            record = await self._validate_target(record)
            # Validation instances never start a driver, even after clearing the durable session freeze.
            sessions = {s.session_id for s in (await self.store.sessions()).sessions}
            sessions.update(w.session_id for w in record.roster)
            for session in sorted(sessions):
                peer = await self.worker(session, maintenance=True, validation_probe=True, update_id=record.update_id)
                await peer.call("POST", "/freeze", Snapshot, FreezeWorker(**self.fence.model_dump(), freeze_id=record.update_id))
                await peer.call("POST", "/thaw", Snapshot, FreezeWorker(**self.fence.model_dump(), freeze_id=record.update_id))
                health = await self.supervisor.call("GET", "/health", SupervisorHealth)
                record = await self._update_health(record, health)
                info = next(w for w in health.workers if w.session_id == session and w.state != "stopped")
                self._verify_validation(info, health)
                await self._stop_info(info)
            health = await self.supervisor.call("GET", "/health", SupervisorHealth)
            record = await self._update_health(record, health)
            self._verify_clean(health)
            record.phase = "completed"
            record = await self.store.save_update(record)
            await self.faults.hit("update_completed", update_id=record.update_id)
            thawed = await self.supervisor.call("POST", "/thaw", SupervisorHealth, FreezeSupervisor(
                **self.fence.model_dump(), freeze_id=record.update_id, expected_revision=health.registry_revision))
            record = await self._update_health(record, thawed)
            self._verify_clean(thawed)
            if thawed.freeze_id:
                raise BackendError("freeze_identity_mismatch", status=503)
            record.activated = True
            record = await self.store.save_update(record)
            await self.store.demand()
            return record

    async def recover(self, value: Recovery) -> Health:
        self._admit()
        if value.host_epoch != self.fence.host_epoch or value.build_id != self.build:
            raise BackendError("stale_host_epoch")
        await self.store.allow_restart(explicit=True)
        await self.ensure_supervisor()
        await self.supervisor.call("POST", "/recover", SupervisorHealth, value)
        await self.store.demand(value.session_id)
        return await self.health()

    async def close(self) -> None:
        self.closing = True
        self.stop.set()
        if self.background:
            self.background.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.background
        try:
            async with self.service_lock:
                if self.initialized:
                    service = await self.store.service()
                    if service and not exited(service.process_lease):
                        identity = await self._await_service(service)
                        self._check_supervisor(identity, service)
                        service.state = "stopping"
                        await self.store.save_service(service)
                        await self.supervisor.call("POST", "/shutdown", Identity,
                            HostFence(host_epoch=self.fence.host_epoch, build_id=service.build_id))
                        await wait_exited(service.process_lease, 30)
                        service.state = "stopped"
                        await self.store.save_service(service)
        finally:
            for _, peer in self.worker_peers.values():
                await peer.close()
            await self.supervisor.close()
            await self.store.db.close()


def application(owner: Host) -> FastAPI:
    app = app_factory()

    @app.middleware("http")
    async def authenticate(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if request.headers.get("host") != owner.origin.removeprefix("http://"):
            return JSONResponse({"code": "invalid_host", "message": "Invalid Host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != owner.origin:
            return JSONResponse({"code": "invalid_origin", "message": "Invalid Origin"}, status_code=403)
        path = request.url.path
        if path.startswith("/control/"):
            valid = secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + owner.profile.token)
        elif path.startswith("/api/"):
            bearer = secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + owner.web_token)
            cookie = secrets.compare_digest(request.cookies.get("amazme", ""), owner.web_token)
            valid = bearer or (cookie and (request.method in {"GET", "HEAD"} or origin == owner.origin))
            if valid and request.method not in {"GET", "HEAD"}:
                if (request.headers.get("x-amazme-build"), request.headers.get("x-amazme-epoch")) != (owner.build, str(owner.fence.host_epoch)):
                    return JSONResponse({"code": "stale_client_binding", "message": "Reconnect before writing"}, status_code=409)
                parts = path.split("/")
                if len(parts) > 5 and parts[3] == "sessions" and not (
                    len(parts) == 6 and parts[5] == "attachments" and request.method == "POST"
                ):
                    try:
                        owner.check_attachment(request.headers.get("x-amazme-attachment", ""), parts[4])
                    except BackendError:
                        return JSONResponse({"code": "stale_client_binding", "message": "Attach before writing"}, status_code=409)
        else:
            valid = True
        if not valid:
            return JSONResponse({"code": "unauthenticated", "message": "Authentication required"}, status_code=401)
        try:
            response = await call_next(request)
        except sqlite3.Error:
            owner.storage_failed = True
            return JSONResponse({"code": "storage_failed", "message": "Storage unavailable; admission closed"}, status_code=503)
        except httpx.TransportError:
            return JSONResponse({"code": "runtime_recovering", "message": "Runtime recovering; retry the same request ID"}, status_code=503)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; connect-src 'self'; style-src 'self'"
        return response

    @app.post("/auth")
    async def login(value: Login, request: Request, response: Response) -> dict[str, bool]:
        if request.headers.get("origin") != owner.origin or not secrets.compare_digest(value.token, owner.web_token):
            raise BackendError("invalid_pairing", status=403)
        response.set_cookie("amazme", owner.web_token, httponly=True, samesite="strict", path="/")
        return {"ok": True}

    @app.get("/api/v1/bootstrap")
    async def bootstrap() -> Identity:
        return owner.identity((await owner.health()).state)

    @app.get("/api/v1/models")
    async def models() -> ModelCatalog:
        return owner.model_catalog()

    @app.post("/api/v1/models")
    async def update_model(value: UpdateModelSettings) -> ModelSettings:
        return await owner.update_model(value)

    @app.get("/api/v1/health")
    async def health() -> Health:
        return await owner.health()

    @app.get("/api/v1/sessions")
    async def sessions() -> SessionList:
        return await owner.sessions()

    @app.post("/api/v1/sessions", status_code=201)
    async def create(value: CreateSession) -> Session:
        return await owner.create_session(value)

    @app.post("/api/v1/sessions/{session}/branches", status_code=201)
    async def branch(session: str, value: BranchSession) -> Session:
        return await owner.branch_session(session, value)

    @app.post("/api/v1/sessions/{session}/archive")
    async def archive(session: str, value: ArchiveSession) -> Session:
        return await owner.archive_session(session, value.archived)

    @app.post("/api/v1/sessions/{session}/compactions", status_code=201)
    async def compact(session: str, value: CompactSession) -> Compaction:
        return await owner.compact_session(session, value)

    @app.post("/api/v1/sessions/{session}/attachments", status_code=201)
    async def attach(session: str) -> Attachment:
        if not await owner.store.exists(session):
            raise BackendError("session_not_found", status=404)
        expired = [key for key in owner.attachments if time.monotonic() - owner.attachment_seen.get(key, 0) > 300]
        for key in expired:
            owner.attachments.pop(key, None)
            owner.attachment_seen.pop(key, None)
        if len(owner.attachments) >= 128:
            raise BackendError("attachment_capacity", status=429)
        value = Attachment(attachment_id=secrets.token_hex(16), session_id=session,
                           host_epoch=owner.fence.host_epoch, build_id=owner.build)
        owner.attachments[value.attachment_id] = value
        owner.attachment_seen[value.attachment_id] = time.monotonic()
        return value

    @app.delete("/api/v1/sessions/{session}/attachments/{identity}")
    async def detach(session: str, identity: str) -> dict[str, bool]:
        existing = owner.attachments.get(identity)
        if existing and existing.session_id != session:
            raise BackendError("attachment_conflict")
        owner.attachments.pop(identity, None)
        owner.attachment_seen.pop(identity, None)
        return {"detached": True}

    @app.get("/api/v1/sessions/{session}/snapshot")
    async def snapshot(session: str) -> Snapshot:
        return await (await owner.reader(session)).call("GET", "/snapshot", Snapshot)

    @app.post("/api/v1/sessions/{session}/submissions", status_code=202)
    async def submit(session: str, value: Submit) -> Receipt:
        return await owner.deliver(session, "submit", value.request_id, value)

    @app.get("/api/v1/sessions/{session}/requests/{request_id}")
    async def lookup(session: str, request_id: str) -> Receipt:
        return await (await owner.reader(session)).call("GET", "/requests/" + quote(request_id, safe=""), Receipt)

    @app.post("/api/v1/sessions/{session}/requests/{request_id}/cancel", status_code=202)
    async def cancel(session: str, request_id: str) -> Receipt:
        # Canonical cancellation identity excludes changing transport epochs.
        value = Cancel(host_epoch=0, build_id="", request_id=request_id)
        return await owner.deliver(session, "cancel", request_id, value)

    @app.post("/api/v1/sessions/{session}/approvals", status_code=202)
    async def approve(session: str, value: ApprovalDecision) -> Receipt:
        return await owner.deliver(session, "approval", value.decision_id, value)

    @app.post("/api/v1/sessions/{session}/effects/resolve", status_code=202)
    async def resolve(session: str, value: EffectResolution) -> Receipt:
        return await owner.deliver(session, "resolve", value.resolution_id, value)

    @app.websocket("/api/v1/events/{session}")
    async def events(socket: WebSocket, session: str) -> None:
        from .streams import serve_stream
        if socket.headers.get("origin") != owner.origin or not secrets.compare_digest(socket.cookies.get("amazme", ""), owner.web_token):
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            await serve_stream(owner, socket, session)
        except (WebSocketDisconnect, httpx.TransportError, BackendError, TimeoutError):
            with contextlib.suppress(RuntimeError):
                await socket.close(code=1012)

    @app.post("/control/updates/prepare")
    async def prepare(value: PrepareUpdate) -> UpdateRecord:
        return await owner.prepare_update(value)

    @app.post("/control/updates/{identity}/resume")
    async def resume(identity: str) -> UpdateRecord:
        return await owner.resume_update(identity)

    @app.post("/control/updates/complete")
    async def complete(value: CompleteUpdate) -> UpdateRecord:
        return await owner.complete_update(value)

    @app.get("/control/updates/{identity}")
    async def update(identity: str) -> UpdateRecord:
        return await owner.store.update(identity)

    @app.post("/control/recover")
    async def recover(value: Recovery) -> Health:
        return await owner.recover(value)

    @app.post("/control/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        if value != owner.fence:
            raise BackendError("stale_host_epoch")
        owner.closing = True
        owner.stop.set()
        return owner.identity("stopping")

    app.mount("/", StaticFiles(directory=Path(__file__).with_name("web"), html=True), name="web")
    return app


def loopback_listener(port: int) -> socket.socket:
    # create_server reclaims TIME_WAIT on POSIX without enabling SO_REUSEPORT.
    return socket.create_server(("127.0.0.1", port), backlog=128)


async def serve(profile: Profile, port: int = 0) -> None:
    with lock(profile.path / "host.lock"):
        instance = secrets.token_hex(16)
        with ProcessReservation(profile.path, "host", instance) as reservation:
            # Keep only an unexposed raw duplicate alive until kernel exit.
            descriptor = os.dup(reservation.fd)
            process_lease = retain_inherited(descriptor, profile.path, "host", instance)
        owner = Host(profile, instance, process_lease)
        try:
            await owner.initialize()
            with loopback_listener(port or await owner.store.port()) as listener:
                listener.setblocking(False)
                actual_port = listener.getsockname()[1]
                await owner.store.port(actual_port)
                owner.origin = f"http://127.0.0.1:{actual_port}"
                server = uvicorn.Server(uvicorn.Config(application(owner), log_level="error", access_log=False,
                                                      ws="websockets-sansio", ws_max_size=4096,
                                                      timeout_graceful_shutdown=3))
                ready = {"url": owner.origin, **owner.identity((await owner.health()).state).model_dump()}
                private_write(profile.path / "ready.json", json.dumps(ready))
                print(json.dumps(ready), flush=True)

                async def watch() -> None:
                    await owner.stop.wait()
                    server.should_exit = True
                watcher = asyncio.create_task(watch())
                try:
                    await server.serve(sockets=[listener])
                finally:
                    watcher.cancel()
        finally:
            await owner.close()
