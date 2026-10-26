"""Execution owner: admission, fenced epochs, recovery and independent effect holds."""

from __future__ import annotations

import asyncio
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Literal

import httpx

from amazme_backend.contracts.code import CodeView
from amazme_backend.contracts.execution import (
    Cleanup,
    EffectHold,
    EpochHealth,
    ExecutionResource,
    Lease,
    ProcessLease,
    SupervisorHealth,
    WorkerInfo,
)
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.contracts.ipc.supervisor import (
    FreezeSupervisor,
    Recovery,
    ResolveEffect,
    RetireSupervisor,
    StopWorker,
    TaskActivity,
    TerminalSession,
    WorkerRequest,
    WorkerSpec,
)
from amazme_backend.diagnostics.faults import Faults
from amazme_backend.execution.codemode.operations import CodeOperations
from amazme_backend.execution.dependencies import CodeToolDefinitions, ExecutionQueries, ResolveModelCall
from amazme_backend.execution.invocations import InvocationOperations
from amazme_backend.execution.mcp.operations import McpOperations
from amazme_backend.execution.plugins.operations import PluginOperations
from amazme_backend.execution.processes import ProcessReservation, exited, wait_exited
from amazme_backend.execution.pty.operations import TerminalOperations
from amazme_backend.execution.remote.operations import RemoteOperations
from amazme_backend.execution.retirement import retirement_proof
from amazme_backend.execution.state import (
    check_admission,
    check_host_fence,
    failure_reason,
    resource_state,
    supervisor_state,
)
from amazme_backend.execution.store import ExecutionDB
from amazme_backend.platform.identity import build_id
from amazme_backend.platform.ipc import Peer, child_command
from amazme_backend.platform.private_files import lock, private_write
from amazme_backend.profiles.layout import SessionRuntimeFile
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError


class Supervisor:
    def __init__(self, profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None,
                 *, queries: ExecutionQueries, code_tool_definitions: CodeToolDefinitions,
                 resolve_model_call: ResolveModelCall, require_existing: bool = False):
        self.profile = profile
        self.queries = queries
        self.code_tool_definitions = code_tool_definitions
        self.resolve_model_call = resolve_model_call
        self.build = build_id()
        self.instance = instance or secrets.token_hex(16)
        self.process_lease = process_lease
        self.initialized_marker = profile.path / "execution.initialized"
        if self.initialized_marker.exists() and self.initialized_marker.read_text() != "3":
            raise BackendError("unsupported_storage_format")
        self.db = ExecutionDB(profile.path / "execution.sqlite",
                              require_existing=require_existing or self.initialized_marker.exists())
        if build_id() != self.build:
            raise BackendError("build_changed_during_capture")
        self.registered = False
        self.host_epoch = 0
        self.fence_ready = True
        self.freeze_id = ""
        self.blocked = ""
        self.draining = False
        self.control = asyncio.Lock()
        self.children: dict[str, asyncio.subprocess.Process] = {}
        self.heartbeats: dict[str, float] = {}
        self.monitor_task: asyncio.Task[None] | None = None
        self.faults = Faults(profile.path, "supervisor", self.instance, enabled=profile.config.testing)
        self.invocations = InvocationOperations(self)
        self.pty = TerminalOperations(self)
        self.mcp = McpOperations(self)
        self.plugins = PluginOperations(self)
        self.code = CodeOperations(self)
        self.remote = RemoteOperations(self)

    def identity(self) -> Identity:
        return Identity(build_id=self.build, profile_id=self.profile.config.profile_id,
                        instance_id=self.instance, pid=os.getpid(), host_epoch=self.host_epoch,
                        role="supervisor", fingerprint=self.build,
                        state=supervisor_state(blocked=self.blocked, storage_failure=self.db.failed,
                                               fence_ready=self.fence_ready, draining=self.draining, freeze_id=self.freeze_id))

    async def initialize(self) -> None:
        old = await self.db.initialize()
        # This is independent of Host's first ACK and precedes execution/worker side effects.
        private_write(self.initialized_marker, "3")
        if build_id() != self.build:
            raise BackendError("build_changed_during_capture")
        self.host_epoch, self.freeze_id = int(old["epoch"]), str(old["freeze"])
        self.fence_ready, self.blocked = bool(old["fence_ready"]), str(old["blocked"])
        self.registered = True
        async with self.control:
            if old["owner"] and old["owner"] != self.instance:
                await self._close_services(require_clean=False)
                # Reconcile registered invocations before accepting work from a replacement owner.
                try:
                    remaining_jobs = await self.db.call(lambda db: bool(db.execute(
                        "SELECT 1 FROM scopes WHERE background=1 AND clean=0 LIMIT 1").fetchone()))
                    if await self._unclean_epochs() or remaining_jobs:
                        await self._reconcile_scopes("supervisor_restarted")
                    for worker in await self.workers():
                        if worker.state != "stopped":
                            try:
                                await self.retire_worker(worker, "recovery", failed=self._unexpected_worker_exit(worker))
                            except BackendError:
                                worker.state = "blocked"
                                await self.save_worker(worker)
                    await self._set_blocked("")
                except Exception as error:
                    await self._set_blocked(failure_reason(error))
            await self.db.call(lambda db: db.execute("UPDATE control SET owner=? WHERE id=1", (self.instance,)), write=True)
        self.monitor_task = asyncio.create_task(self.monitor())

    async def _set_blocked(self, reason: str) -> None:
        self.blocked = reason
        await self.db.call(lambda db: db.execute("UPDATE control SET blocked=? WHERE id=1", (reason,)), write=True)

    def check_host(self, fence: HostFence) -> None:
        check_host_fence(fence, build=self.build, host_epoch=self.host_epoch)

    def admit(self, session: str = "", *, validation: bool = False) -> None:
        check_admission(storage_failure=self.db.failed, blocked=self.blocked, draining=self.draining,
                        fence_ready=self.fence_ready, freeze_id=self.freeze_id, validation=validation)
        if session:
            self.queries.session_workspace(session, active=True)

    async def workers(self, session: str = "") -> list[WorkerInfo]:
        return await self.db.call(lambda db: [WorkerInfo.model_validate_json(str(r[0])) for r in db.execute(
            "SELECT info FROM workers" + (" WHERE session=?" if session else "") + " ORDER BY rowid",
            (session,) if session else ())])

    @staticmethod
    def _put_worker(db: sqlite3.Connection, worker: WorkerInfo) -> None:
        row = db.execute("SELECT info FROM workers WHERE worker=?", (worker.worker_id,)).fetchone()
        if row is None:
            raise BackendError("stale_worker")
        previous = WorkerInfo.model_validate_json(str(row[0]))
        worker.storage_ready = worker.storage_ready or previous.storage_ready
        db.execute("UPDATE workers SET info=? WHERE worker=?", (worker.model_dump_json(), worker.worker_id))

    async def save_worker(self, worker: WorkerInfo) -> None:
        await self.db.call(lambda db: self._put_worker(db, worker), write=True)

    async def worker_info(self, session: str) -> WorkerInfo | None:
        rows = await self.workers(session)
        active = [w for w in rows if w.state != "stopped"]
        return active[-1] if active else rows[-1] if rows else None

    async def worker(self, worker_id: str) -> WorkerInfo:
        row = await self.db.call(lambda db: db.execute("SELECT info FROM workers WHERE worker=?", (worker_id,)).fetchone())
        if row is None:
            raise BackendError("stale_worker")
        return WorkerInfo.model_validate_json(str(row[0]))

    async def peer_identity(self, worker: WorkerInfo, method: str = "GET", path: str = "/identity",
                             body: HostFence | StopWorker | None = None) -> Identity:
        peer = Peer(Path(worker.socket), self.profile.token)
        try:
            result = await asyncio.wait_for(peer.call(method, path, Identity, body), 3)
        finally:
            await peer.close()
        if (result.instance_id, result.profile_id, result.build_id, result.role, result.fingerprint) != (
            worker.worker_id, self.profile.config.profile_id, worker.build_id, "worker", worker.build_id
        ):
            raise BackendError("worker_identity_mismatch", status=503)
        return result

    async def takeover(self, value: HostFence) -> Identity:
        async with self.control:
            if self.draining:
                raise BackendError("supervisor_stopping", status=503)
            await self._fence(value)
            return self.identity()

    async def _fence(self, value: HostFence) -> None:
        if value.build_id != self.build:
            raise BackendError("build_mismatch")
        if value.host_epoch < self.host_epoch:
            raise BackendError("stale_host_epoch")
        await self.db.call(lambda db: db.execute("UPDATE control SET epoch=?,fence_ready=0 WHERE id=1",
                                                (value.host_epoch,)), write=True)
        self.host_epoch, self.fence_ready = value.host_epoch, False
        for worker in await self.workers():
            if worker.state == "stopped":
                continue
            try:
                if worker.process_lease is None:
                    raise BackendError("process_exit_unproven", status=503)
                if (worker.state not in {"starting", "ready", "frozen"}
                        or exited(worker.process_lease)):
                    receipt = await self.retire_worker(worker, "recovery", failed=self._unexpected_worker_exit(worker))
                    if receipt.state != "clean" and not exited(worker.process_lease):
                        raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                    continue
                ack = await self.peer_identity(worker, "POST", "/fence", value)
                if ack.host_epoch != value.host_epoch:
                    raise BackendError("worker_fence_pending", status=503)
                if ack.state in {"stopping", "blocked"}:
                    receipt = await self.retire_worker(worker, "recovery", failed=self._unexpected_worker_exit(worker))
                    if receipt.state != "clean":
                        raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                    continue
                worker.host_epoch = ack.host_epoch
                if worker.state == "starting":
                    worker.state = "frozen" if ack.state == "frozen" else "ready" if ack.state == "ready" else "starting"
                worker.fingerprint = ack.fingerprint
                await self.save_worker(worker)
            except (httpx.TransportError, TimeoutError) as error:
                raise BackendError("worker_fence_pending", worker.worker_id, 503) from error
        await self.db.call(lambda db: db.execute("UPDATE control SET fence_ready=1 WHERE id=1"), write=True)
        self.fence_ready = True

    async def ensure_worker(self, value: WorkerSpec) -> WorkerInfo:
        async with self.control:
            self.check_host(value)
            self.admit(validation=value.purpose == "validation")
            live: list[WorkerInfo] = []
            for worker in await self.workers(value.session_id):
                if worker.state == "stopped":
                    continue
                if worker.purpose != value.purpose or worker.build_id != self.build:
                    raise BackendError("worker_identity_conflict")
                if worker.process_lease is None:
                    raise BackendError("process_exit_unproven", status=503)
                if exited(worker.process_lease):
                    receipt = await self.retire_worker(worker, "recovery", failed=self._unexpected_worker_exit(worker))
                    if receipt.state != "clean":
                        raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                    continue
                if worker.state not in {"starting", "ready", "frozen"}:
                    raise BackendError("worker_retirement_pending", status=503)
                if value.frozen and worker.state == "ready":
                    raise BackendError("worker_not_frozen")
                live.append(worker)
            if len(live) > 1:
                raise BackendError("worker_identity_conflict", status=503)
            if live:
                return live[0]
            # Validation probes never drive business work or participate in automatic restarts.
            if value.purpose == "business":
                attempts = await self.db.call(lambda db: db.execute(
                    "SELECT attempts FROM budgets WHERE session=?", (value.session_id,)).fetchone())
                if attempts and int(attempts[0]) > 3:
                    raise BackendError("worker_restart_budget_exhausted", status=503)
            if len([w for w in await self.workers() if w.state != "stopped"]) >= 8:
                raise BackendError("worker_capacity", status=429)
            if await self._unclean_epochs(value.session_id):
                raise BackendError("execution_cleanup_pending", status=503)
            previous = await self.workers(value.session_id)
            requires_store = any(worker.storage_ready for worker in previous)
            if (requires_store and value.purpose == "validation"
                    and all(worker.purpose == "validation" and worker.state == "stopped"
                            and worker.process_lease is not None and exited(worker.process_lease)
                            for worker in previous)
                    and self.queries.branch_pending(value.session_id)):
                requires_store = False
            directory = self.profile.path / "sessions" / value.session_id
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                with lock(directory / SessionRuntimeFile.WRITER_LOCK):
                    pass
            except BlockingIOError as error:
                raise BackendError("worker_still_owns_session", status=503) from error
            instance = secrets.token_hex(16)
            with ProcessReservation(self.profile.path, "worker", instance) as reservation:
                worker = WorkerInfo(session_id=value.session_id, worker_id=instance, pid=0,
                                    socket=str(self.profile.worker_socket(value.session_id)), build_id=self.build,
                                    process_lease=reservation.lease, purpose=value.purpose, host_epoch=self.host_epoch,
                                    plugin_fingerprint=await self.plugins.set_fingerprint(value.session_id))
                # This row is committed before spawn; even death before PID publication leaves an exact lease.
                await self.db.call(lambda db: db.execute("INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
                    (instance, value.session_id, worker.model_dump_json())), write=True)
                self.heartbeats[instance] = time.monotonic()
                await self.faults.hit("worker_reserved", session_id=value.session_id)
                log_fd = os.open(directory / SessionRuntimeFile.WORKER_LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    args = child_command("worker", "--profile", str(self.profile.path), "--session", value.session_id,
                                         "--instance", instance, "--lifetime-fd", str(reservation.fd))
                    if value.frozen or self.freeze_id:
                        args.append("--frozen")
                    if value.purpose == "validation":
                        args.append("--validation")
                    if requires_store:
                        args.append("--require-existing-store")
                    child = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.DEVNULL,
                        stdout=log_fd, stderr=log_fd, pass_fds=(reservation.fd,), start_new_session=True)
                    self.children[instance] = child
                    worker.pid = child.pid
                    await self.save_worker(worker)
                finally:
                    os.close(log_fd)
            self.heartbeats[instance] = time.monotonic()
            await self.faults.hit("worker_spawned", session_id=value.session_id)
            return worker

    async def validate_worker(self, value: WorkerRequest) -> WorkerInfo:
        worker = await self.worker(value.worker_id)
        if (worker.session_id != value.session_id or value.build_id != self.build or worker.build_id != self.build
                or worker.state not in {"starting", "ready", "frozen"}):
            raise BackendError("stale_worker")
        if worker.process_lease is None or exited(worker.process_lease):
            raise BackendError("worker_process_exited", status=503)
        return worker

    async def heartbeat(self, value: WorkerRequest) -> Identity:
        # Read-only heartbeat must remain available while Host waits for worker fence/startup ACK.
        worker = await self.validate_worker(value)
        if value.storage_ready and not worker.storage_ready:
            def acknowledge(db: sqlite3.Connection) -> None:
                row = db.execute("SELECT info FROM workers WHERE worker=?", (value.worker_id,)).fetchone()
                info = WorkerInfo.model_validate_json(str(row[0]))
                if info.state not in {"starting", "ready", "frozen"}:
                    raise BackendError("stale_worker")
                info.storage_ready = True
                db.execute("UPDATE workers SET info=? WHERE worker=?", (info.model_dump_json(), info.worker_id))
            await self.db.call(acknowledge, write=True)
        self.heartbeats[value.worker_id] = time.monotonic()
        return self.identity()

    async def _unclean_epochs(self, session: str = "") -> list[sqlite3.Row]:
        return await self.db.call(lambda db: db.execute(
            "SELECT * FROM epochs WHERE state!='clean'" + (" AND session=?" if session else ""),
            (session,) if session else ()).fetchall())

    async def open_epoch(self, value: WorkerRequest) -> Lease:
        async with self.control:
            worker = await self.validate_worker(value)
            self.admit(validation=worker.purpose == "validation")
            pending = await self._unclean_epochs(value.session_id)
            if pending:
                row = pending[0]
                if len(pending) == 1 and (row["worker"], row["supervisor"], row["build"], row["state"]) == (
                    value.worker_id, self.instance, value.build_id, "open"
                ):
                    return Lease(**value.model_dump(exclude={"storage_ready"}),
                                 execution_epoch=int(row["epoch"]), supervisor_id=self.instance)
                raise BackendError("execution_cleanup_pending", status=503)
            if worker.purpose == "business" and worker.state == "frozen":
                raise BackendError("worker_frozen")
            def opened(db: sqlite3.Connection) -> int:
                epoch = int(db.execute("SELECT COALESCE(MAX(epoch),0)+1 FROM epochs WHERE session=?",
                                       (value.session_id,)).fetchone()[0])
                db.execute("INSERT INTO epochs(session,epoch,worker,supervisor,build,state) VALUES(?,?,?,?,?,'open')",
                           (value.session_id, epoch, value.worker_id, self.instance, self.build))
                worker.execution_epoch = epoch
                self._put_worker(db, worker)
                return epoch
            epoch = await self.db.call(opened, write=True)
            await self.faults.hit("epoch_opened", session_id=value.session_id)
            return Lease(session_id=value.session_id, worker_id=value.worker_id, build_id=value.build_id,
                         execution_epoch=epoch, supervisor_id=self.instance)

    async def check_lease(self, value: Lease, *, admit: bool = True) -> None:
        worker = await self.validate_worker(WorkerRequest(session_id=value.session_id, worker_id=value.worker_id,
                                                        build_id=value.build_id))
        if admit:
            self.admit(validation=worker.purpose == "validation")
        if value.supervisor_id != self.instance:
            raise BackendError("stale_supervisor")
        row = await self.db.call(lambda db: db.execute("SELECT * FROM epochs WHERE session=? AND epoch=?",
            (value.session_id, value.execution_epoch)).fetchone())
        if row is None or (row["worker"], row["supervisor"], row["build"], row["state"]) != (
            value.worker_id, value.supervisor_id, value.build_id, "open"
        ):
            raise BackendError("execution_epoch_closed", status=503)

    async def _holds(self) -> list[EffectHold]:
        active_plugins = {key for key, task in self.plugins.jobs.items() if not task.done()}
        active_codes = set(self.code.jobs)
        def read(db: sqlite3.Connection) -> list[EffectHold]:
            native = [EffectHold(call_id=str(row["id"]), session_id=str(row["session"]), request_id=str(row["request"]),
                reason="tool_outcome_unknown", resource_clean=bool(row["clean"]), reconciled=bool(row["resolved"]))
                for row in db.execute("SELECT s.*,EXISTS(SELECT 1 FROM resolutions r WHERE r.call=s.id) resolved "
                    "FROM scopes s WHERE effect='write' AND outcome='unknown' ORDER BY rowid")]
            plugins = [EffectHold(call_id=str(row["step_id"]), session_id=str(row["session"]), request_id=str(row["request_id"]),
                reason="plugin_outcome_unknown", resource_clean=bool(row["clean"]), reconciled=bool(row["resolved"]))
                for row in db.execute("SELECT p.*,EXISTS(SELECT 1 FROM resolutions r WHERE r.call=p.step_id) resolved "
                    "FROM plugin_calls p WHERE origin='model' AND phase='unknown' AND step_id!='' ORDER BY rowid") if str(row["id"]) not in active_plugins]
            codes: list[EffectHold] = []
            for row in db.execute("SELECT c.*,r.document,EXISTS(SELECT 1 FROM resolutions x WHERE x.call=c.parent_step) resolved "
                                  "FROM code_runs c LEFT JOIN code_results r ON r.id=c.id WHERE c.phase='unknown' AND c.parent_step!=''"):
                if str(row["id"]) in active_codes:
                    continue
                view = CodeView.model_validate_json(row["document"]) if row["document"] else CodeView(run_id=str(row["id"]), phase="unknown")
                codes.append(EffectHold(call_id=str(row["parent_step"]), session_id=str(row["session"]), request_id=str(row["parent_request"]),
                                        reason="codemode_outcome_unknown", resource_clean=view.clean, reconciled=bool(row["resolved"])))
            return [*native, *plugins, *codes]
        return await self.db.call(read)

    async def write_conflict(self, session: str) -> bool:
        active_codes = set(self.code.jobs)
        def read(db: sqlite3.Connection) -> bool:
            native = db.execute("SELECT 1 FROM scopes s WHERE session=? AND effect='write' AND ((outcome='unknown' AND NOT EXISTS "
                "(SELECT 1 FROM resolutions r WHERE r.call=s.id)) OR (outcome='completed' AND clean=0)) LIMIT 1", (session,)).fetchone()
            plugin = db.execute("SELECT 1 FROM plugin_calls p WHERE session=? AND origin='model' AND phase='unknown' AND step_id!='' "
                "AND (clean=0 OR NOT EXISTS (SELECT 1 FROM resolutions r WHERE r.call=p.step_id)) LIMIT 1", (session,)).fetchone()
            codes = db.execute("SELECT c.id FROM code_runs c LEFT JOIN code_results r ON r.id=c.id WHERE c.session=? AND c.parent_step!='' AND c.phase='unknown' "
                               "AND (coalesce(json_extract(r.document,'$.clean'),0)=0 OR NOT EXISTS (SELECT 1 FROM resolutions x WHERE x.call=c.parent_step))", (session,))
            return native is not None or plugin is not None or any(str(row[0]) not in active_codes for row in codes)
        return await self.db.call(read)

    async def resolve_effect(self, value: ResolveEffect) -> EffectHold:
        async with self.control:
            worker = await self.validate_worker(value)
            if worker.purpose == "validation":
                raise BackendError("validation_effects_forbidden")
            resolution = value.resolution
            if not resolution.evidence.strip():
                raise BackendError("effect_evidence_required")
            scope = await self.invocations.scope(resolution.call_id)
            plugin = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE step_id=? AND origin='model'",
                (resolution.call_id,)).fetchone()) if scope is None else None
            code = await self.db.call(lambda db: db.execute("SELECT c.*,r.document FROM code_runs c LEFT JOIN code_results r ON r.id=c.id WHERE c.parent_step=?",
                (resolution.call_id,)).fetchone()) if scope is None and plugin is None else None
            if plugin is not None:
                if str(plugin["session"]) != value.session_id or str(plugin["phase"]) != "unknown":
                    raise BackendError("effect_scope_mismatch")
                clean, request_id, reason = bool(plugin["clean"]), str(plugin["request_id"]), "plugin_outcome_unknown"
            elif scope is not None and scope["session"] == value.session_id and scope["effect"] == "write" and scope["outcome"] == "unknown":
                clean, request_id, reason = bool(scope["clean"]), str(scope["request"]), "tool_outcome_unknown"
            elif code is not None and str(code["session"]) == value.session_id and str(code["phase"]) == "unknown" and str(code["id"]) not in self.code.jobs:
                view = CodeView.model_validate_json(code["document"]) if code["document"] else CodeView(run_id=str(code["id"]), phase="unknown")
                clean, request_id, reason = view.clean, str(code["parent_request"]), "codemode_outcome_unknown"
            else:
                raise BackendError("effect_scope_mismatch")
            if not clean:
                raise BackendError("execution_cleanup_pending", status=503)
            def resolve(db: sqlite3.Connection) -> None:
                old = db.execute("SELECT * FROM resolutions WHERE id=? OR call=?",
                                 (resolution.resolution_id, resolution.call_id)).fetchone()
                if old:
                    if old["payload"] != resolution.model_dump_json() or old["session"] != value.session_id:
                        raise BackendError("effect_resolution_conflict")
                else:
                    db.execute("INSERT INTO resolutions(id,call,session,payload,native_call,plugin_call,code_call) VALUES(?,?,?,?,?,?,?)",
                               (resolution.resolution_id, resolution.call_id, value.session_id, resolution.model_dump_json(),
                                resolution.call_id if scope is not None else None, str(plugin["id"]) if plugin is not None else None, str(code["id"]) if code is not None else None))
                    if code is not None:
                        db.execute("INSERT OR IGNORE INTO code_cancellations(id,session) VALUES(?,?)", (str(code["id"]), value.session_id))
            await self.db.call(resolve, write=True)
            return EffectHold(call_id=resolution.call_id, session_id=value.session_id, request_id=request_id,
                              reason=reason, resource_clean=True, reconciled=True)

    async def _reconcile_scopes(self, reason: str) -> None:
        await self.invocations.cancel_all()
        await self.db.call(lambda db: db.execute("UPDATE scopes SET outcome='unknown' WHERE outcome='pending'"), write=True)
        for row in await self._unclean_epochs():
            await self._cleanup_epoch(row)
        await self._cleanup_background()

    async def _cleanup_background(self, session: str = "") -> None:
        rows = await self.db.call(lambda db: db.execute(
            "SELECT * FROM scopes WHERE background=1 AND clean=0" + (" AND session=?" if session else ""),
            (session,) if session else ()).fetchall())
        for scope in rows:
            await self.invocations.clean_scope(scope)

    async def cleanup(self, session: str, lease: Lease | None = None) -> Cleanup:
        async with self.control:
            if lease is not None:
                # Historical exact leases may only close/query their original epoch.
                row = await self.db.call(lambda db: db.execute("SELECT * FROM epochs WHERE session=? AND epoch=?",
                    (session, lease.execution_epoch)).fetchone())
                if row is None or (lease.session_id, lease.worker_id, lease.build_id, lease.supervisor_id) != (
                    session, row["worker"], row["build"], row["supervisor"]
                ):
                    raise BackendError("stale_execution_epoch")
                return await self._cleanup_epoch(row)
            rows = await self._unclean_epochs(session)
            result = Cleanup(session_id=session, execution_epoch=0, state="clean", resources=[],
                             proof_id=secrets.token_hex(16))
            for row in rows:
                result = await self._cleanup_epoch(row)
                if result.state != "clean":
                    return result
            return result

    async def _cleanup_epoch(self, row: sqlite3.Row) -> Cleanup:
        session, epoch = str(row["session"]), int(row["epoch"])
        if row["state"] == "clean":
            return Cleanup.model_validate_json(str(row["receipt"]))
        await self.db.call(lambda db: db.execute("UPDATE epochs SET state='closing' WHERE session=? AND epoch=?",
                                                (session, epoch)), write=True)
        await self.invocations.cancel_all(session, epoch, include_background=False)
        scopes = await self.db.call(lambda db: db.execute("SELECT * FROM scopes WHERE session=? AND epoch=? AND background=0",
                                                          (session, epoch)).fetchall())
        ids = [str(scope["id"]) for scope in scopes]
        reason = ""
        for scope in scopes:
            try:
                await self.invocations.clean_scope(scope)
            except BackendError as error:
                reason = error.code
        result = Cleanup(session_id=session, execution_epoch=epoch, state="blocked" if reason else "clean",
                         resources=ids, reason=reason, proof_id=secrets.token_hex(16) if not reason else "")
        await self.db.call(lambda db: db.execute("UPDATE epochs SET state=?,receipt=? WHERE session=? AND epoch=?",
                          (result.state, result.model_dump_json(), session, epoch)), write=True)
        if result.state == "clean":
            await self.faults.hit("closed", session_id=session)
        return result

    def _unexpected_worker_exit(self, worker: WorkerInfo) -> bool:
        child = self.children.get(worker.worker_id)
        return child is None or child.returncode != 0

    async def retire_worker(self, worker: WorkerInfo, reason: Literal["shutdown", "recovery", "update"], *, failed: bool = False) -> Cleanup:
        worker = await self.worker(worker.worker_id)
        if worker.state == "stopped":
            row = await self.db.call(lambda db: db.execute("SELECT retirement FROM workers WHERE worker=?",
                                                          (worker.worker_id,)).fetchone())
            return Cleanup.model_validate_json(str(row[0]))
        worker.state = "stopping"
        await self.save_worker(worker)
        receipt = Cleanup(session_id=worker.session_id, execution_epoch=worker.execution_epoch, state="clean",
                          resources=[], proof_id=secrets.token_hex(16))
        for row in await self._unclean_epochs(worker.session_id):
            if row["worker"] == worker.worker_id:
                receipt = await self._cleanup_epoch(row)
                if receipt.state != "clean":
                    worker.state = "blocked"
                    await self.save_worker(worker)
                    return receipt
        lease = worker.process_lease
        if lease is None:
            raise BackendError("process_exit_unproven", status=503)
        if not exited(lease):
            fence = HostFence(build_id=worker.build_id, host_epoch=self.host_epoch)
            try:
                ack = await self.peer_identity(worker, "POST", "/fence", fence)
                if ack.host_epoch != self.host_epoch:
                    raise BackendError("worker_fence_pending", status=503)
                stop = StopWorker(**fence.model_dump(), session_id=worker.session_id, worker_id=worker.worker_id,
                                  execution_epoch=worker.execution_epoch, reason=reason)
                await self.peer_identity(worker, "POST", "/stop", stop)
            except (httpx.TransportError, TimeoutError):
                pass
            await wait_exited(lease, timeout=3)
        with retirement_proof(self.profile, worker):
            worker.state = "stopped"
            def retired(db: sqlite3.Connection) -> None:
                row = db.execute("SELECT failure_counted FROM workers WHERE worker=?", (worker.worker_id,)).fetchone()
                if failed and worker.purpose == "business" and not row[0]:
                    db.execute("INSERT INTO budgets(session,attempts) VALUES(?,1) ON CONFLICT(session) "
                               "DO UPDATE SET attempts=attempts+1", (worker.session_id,))
                self._put_worker(db, worker)
                db.execute("UPDATE workers SET retirement=?,failure_counted=MAX(failure_counted,?) WHERE worker=?",
                           (receipt.model_dump_json(), int(failed), worker.worker_id))
            await self.db.call(retired, write=True)
        self.heartbeats.pop(worker.worker_id, None)
        child = self.children.pop(worker.worker_id, None)
        if child is not None:
            await child.wait()
        return receipt

    async def stop_worker(self, value: StopWorker) -> Cleanup:
        async with self.control:
            self.check_host(value)
            worker = await self.worker(value.worker_id)
            if worker.session_id != value.session_id or worker.build_id != value.build_id:
                raise BackendError("stale_worker")
            if value.execution_epoch != worker.execution_epoch:
                raise BackendError("stale_execution_epoch")
            return await self.retire_worker(worker, value.reason)

    async def retire_session(self, value: TerminalSession) -> Cleanup:
        self.check_host(value)
        self.queries.session_workspace(value.session_id)
        await self.code.stop_all(value.session_id)
        async with self.control:
            self.check_host(value)
            codes = await self.db.call(lambda db: db.execute("SELECT * FROM code_runs WHERE session=?", (value.session_id,)).fetchall())
            for code in codes:
                if not (await self.code.retire_run(code)).clean:
                    raise BackendError("codemode_cleanup_pending", status=503)
            for worker in await self.workers(value.session_id):
                if worker.state != "stopped":
                    result = await self.retire_worker(worker, "shutdown")
                    if result.state != "clean":
                        raise BackendError("execution_cleanup_pending", status=503)
            for epoch in await self._unclean_epochs(value.session_id):
                result = await self._cleanup_epoch(epoch)
                if result.state != "clean":
                    raise BackendError("execution_cleanup_pending", status=503)
            await self.db.call(lambda db: db.execute(
                "UPDATE scopes SET job_cancel=1 WHERE session=? AND background=1 AND clean=0", (value.session_id,)), write=True)
            await self.invocations.cancel_all(value.session_id, background_only=True)
            await self._cleanup_background(value.session_id)
            await self._close_services(value.session_id)
            return Cleanup(session_id=value.session_id, execution_epoch=0, state="clean", resources=[],
                           proof_id=secrets.token_hex(16))

    async def _refresh_workers(self) -> list[WorkerInfo]:
        workers = await self.workers()
        for worker in workers:
            if worker.state not in {"starting", "ready", "frozen"}:
                continue
            if worker.process_lease is None or exited(worker.process_lease):
                worker.state = "unknown"
            else:
                try:
                    identity = await self.peer_identity(worker)
                except (httpx.TransportError, TimeoutError, BackendError) as error:
                    if worker.state != "starting" or isinstance(error, BackendError):
                        worker.state = "unknown"
                else:
                    worker.fingerprint = identity.fingerprint
                    worker.host_epoch = identity.host_epoch
                    worker.state = "frozen" if identity.state == "frozen" else "ready" if identity.state == "ready" else "starting"
            previous = await self.worker(worker.worker_id)
            worker.storage_ready |= previous.storage_ready
            if worker != previous and not self.db.failed:
                await self.save_worker(worker)
        return workers

    async def health(self) -> SupervisorHealth:
        async with self.control:
            return await self._health()

    async def task_activity(self) -> TaskActivity:
        async with self.control:
            jobs = sum(not task.done() for registry in (self.invocations.jobs, self.code.jobs, self.plugins.jobs)
                       for task in registry.values())
            row = await self.db.call(lambda db: db.execute(
                "SELECT (SELECT count(*) FROM mcp_calls WHERE phase IN ('waiting_approval','running')),"
                "(SELECT count(*) FROM terminals WHERE phase='running'),"
                "(SELECT count(*) FROM scopes WHERE clean=0 AND (background=1 OR phase IN ('registered','running')))").fetchone())
            assert row is not None
            tasks = jobs + sum(int(value or 0) for value in row)
            return TaskActivity(active=tasks > 0, tasks=tasks)

    async def _health(self) -> SupervisorHealth:
        workers = await self._refresh_workers()
        rows = await self.db.call(lambda db: db.execute("SELECT * FROM epochs ORDER BY session,epoch").fetchall())
        revision = await self.db.call(lambda db: str(db.execute("SELECT revision FROM control WHERE id=1").fetchone()[0]))
        budgets = await self.db.call(lambda db: [str(r[0]) for r in db.execute("SELECT session FROM budgets WHERE attempts>3")])
        blocked = ([self.blocked] if self.blocked else []) + ([self.db.failed] if self.db.failed else [])
        if not self.fence_ready:
            blocked.append("worker_fence_pending")
        session_errors = {session: ["worker_restart_budget_exhausted"] for session in budgets}
        terminals = await self.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE clean=0").fetchall())
        mcps = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE clean=0").fetchall())
        for row in mcps:
            if row["phase"] == "unknown":
                session_errors.setdefault(str(row["session"]), []).append("mcp_stop_unconfirmed:" + str(row["id"]))
        for row in terminals:
            if row["phase"] == "unknown":
                session_errors.setdefault(str(row["session"]), []).append("terminal_stop_unconfirmed:" + str(row["id"]))
        for worker in workers:
            if worker.state in {"blocked", "unknown", "stopping"}:
                session_errors.setdefault(worker.session_id, []).append("worker_retirement_pending:" + worker.worker_id)
        scopes = await self.db.call(lambda db: db.execute(
            "SELECT s.*,e.state AS epoch_state FROM scopes s JOIN epochs e "
            "ON s.session=e.session AND s.epoch=e.epoch ORDER BY s.clean,s.rowid DESC LIMIT 200").fetchall())
        resources = [ExecutionResource.model_validate({
            "call_id": row["id"], "session_id": row["session"], "request_id": row["request"],
            "outcome": row["outcome"], "state": resource_state(clean=bool(row["clean"]),
                epoch_state=("blocked" if row["outcome"] == "unknown" else "open") if row["background"] else str(row["epoch_state"]),
                phase=str(row["phase"])),
        }) for row in scopes]
        return SupervisorHealth(identity=self.identity(), registry_revision=revision, freeze_id=self.freeze_id,
            workers=workers, epochs=[EpochHealth(session_id=str(r["session"]), worker_id=str(r["worker"]),
                execution_epoch=int(r["epoch"]), state=str(r["state"]),
                cleanup=Cleanup.model_validate_json(str(r["receipt"])) if r["receipt"] else None) for r in rows],
            effects=await self._holds(), execution="native", resources=resources, session_errors=session_errors,
            terminals=[self.pty.view(row) for row in terminals], mcp_servers=[self.mcp.view(row) for row in mcps], blocked=blocked)

    async def freeze(self, value: FreezeSupervisor) -> SupervisorHealth:
        async with self.control:
            self.check_host(value)
            if not value.freeze_id or (self.freeze_id and self.freeze_id != value.freeze_id):
                raise BackendError("freeze_identity_mismatch")
            await self.db.call(lambda db: db.execute("UPDATE control SET freeze=? WHERE id=1", (value.freeze_id,)), write=True)
            self.freeze_id = value.freeze_id
            return await self._health()

    async def thaw(self, value: FreezeSupervisor) -> SupervisorHealth:
        async with self.control:
            self.check_host(value)
            if not value.freeze_id:
                raise BackendError("freeze_identity_mismatch")
            if not self.freeze_id:
                previous = await self.db.call(lambda db: db.execute("SELECT build FROM thaws WHERE id=?",
                                                                     (value.freeze_id,)).fetchone())
                if previous and previous[0] == self.build:
                    return await self._health()
            if self.freeze_id != value.freeze_id:
                raise BackendError("freeze_identity_mismatch")
            before = await self.db.call(lambda db: str(db.execute("SELECT revision FROM control WHERE id=1").fetchone()[0]))
            if value.expected_revision and value.expected_revision != before:
                raise BackendError("registry_revision_mismatch")
            health = await self._health()
            if value.expected_revision and health.registry_revision != value.expected_revision:
                raise BackendError("registry_revision_mismatch")
            for worker in health.workers:
                if worker.state == "stopped":
                    if worker.process_lease is None or not exited(worker.process_lease):
                        raise BackendError("process_exit_unproven", status=503)
                    with retirement_proof(self.profile, worker):
                        pass
            if (health.blocked or any(e.state != "clean" for e in health.epochs)
                    or any(resource.state != "exited" for resource in health.resources)
                    or any(not terminal.clean for terminal in health.terminals)
                    or any(not server.clean for server in health.mcp_servers)
                    or any(w.state != "stopped" for w in health.workers)):
                raise BackendError("update_health_unproven", status=503)
            def thawed(db: sqlite3.Connection) -> None:
                db.execute("UPDATE control SET freeze='' WHERE id=1")
                db.execute("INSERT INTO thaws VALUES(?,?) ON CONFLICT(id) DO UPDATE SET build=excluded.build",
                           (value.freeze_id, self.build))
            await self.db.call(thawed, write=True)
            self.freeze_id = ""
            return await self._health()

    async def recover(self, value: Recovery) -> SupervisorHealth:
        async with self.control:
            self.check_host(value)
            old = await self.db.call(lambda db: db.execute("SELECT * FROM recoveries WHERE id=?", (value.recovery_id,)).fetchone())
            if old and old["session"] != value.session_id:
                raise BackendError("recovery_conflict")
            if old and old["state"] == "complete":
                return await self._health()
            await self.db.call(lambda db: db.execute("INSERT OR IGNORE INTO recoveries VALUES(?,?,'pending')",
                                                     (value.recovery_id, value.session_id)), write=True)
            for worker in await self.workers(value.session_id):
                if worker.state != "stopped":
                    receipt = await self.retire_worker(worker, "recovery")
                    if receipt.state != "clean":
                        raise BackendError("execution_cleanup_pending", receipt.reason, 503)
            if not value.session_id or self.blocked:
                await self._reconcile_scopes("explicit_recovery")
            def recovered(db: sqlite3.Connection) -> None:
                db.execute("UPDATE budgets SET attempts=0" + (" WHERE session=?" if value.session_id else ""),
                           (value.session_id,) if value.session_id else ())
                db.execute("UPDATE recoveries SET state='complete' WHERE id=?", (value.recovery_id,))
                db.execute("UPDATE control SET blocked='' WHERE id=1")
            await self.db.call(recovered, write=True)
            self.blocked = ""
            return await self._health()

    async def _shutdown(self, value: HostFence) -> None:
        self.check_host(value)
        self.draining = True
        await self._close_services()
        # Stop registered invocation resources first. Every registry instance still needs its independent process proof.
        await self._reconcile_scopes("registered_processes_stopped")
        for worker in await self.workers():
            if worker.state != "stopped":
                result = await self.retire_worker(worker, "update")
                if result.state != "clean":
                    raise BackendError("execution_cleanup_pending", result.reason, 503)
        await self._set_blocked("")

    async def shutdown(self, value: HostFence) -> Identity:
        # Drop the control lock before waiting for worker exit. A worker still in
        # initialize is blocked on this same lock, so waiting while holding it never
        # observes the process exit and leaves the supervisor running.
        async with self.control:
            self.check_host(value)
            self.draining = True
        await self.code.stop_all()
        async with self.control:
            await self._close_services()
            await self._reconcile_scopes("registered_processes_stopped")
            pending: list[WorkerInfo] = []
            for worker in await self.workers():
                if worker.state == "stopped":
                    continue
                worker.state = "stopping"
                await self.save_worker(worker)
                for row in await self._unclean_epochs(worker.session_id):
                    if row["worker"] == worker.worker_id:
                        receipt = await self._cleanup_epoch(row)
                        if receipt.state != "clean":
                            raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                pending.append(await self.worker(worker.worker_id))
        for worker in pending:
            lease = worker.process_lease
            if lease is not None and not exited(lease):
                fence = HostFence(build_id=worker.build_id, host_epoch=self.host_epoch)
                try:
                    ack = await self.peer_identity(worker, "POST", "/fence", fence)
                    if ack.host_epoch != self.host_epoch:
                        raise BackendError("worker_fence_pending", status=503)
                    await self.peer_identity(worker, "POST", "/stop", StopWorker(
                        **fence.model_dump(), session_id=worker.session_id, worker_id=worker.worker_id,
                        execution_epoch=worker.execution_epoch, reason="shutdown"))
                except (httpx.TransportError, TimeoutError, BackendError):
                    pass
                try:
                    await wait_exited(lease, timeout=5)
                except BackendError:
                    pass
        async with self.control:
            for worker in pending:
                current = await self.worker(worker.worker_id)
                if current.state == "stopped":
                    continue
                result = await self.retire_worker(current, "shutdown")
                if result.state != "clean":
                    raise BackendError("execution_cleanup_pending", result.reason, 503)
            await self._set_blocked("")
            return self.identity()

    async def retire(self, value: RetireSupervisor) -> SupervisorHealth:
        async with self.control:
            # Target Host must address this source build; cross-build business takeover remains forbidden.
            if value.build_id != self.build or value.host_epoch < self.host_epoch:
                raise BackendError("retire_fence_mismatch")
            if not value.freeze_id or (self.freeze_id and self.freeze_id != value.freeze_id):
                raise BackendError("freeze_identity_mismatch")
            self.draining = True
            if not self.freeze_id:
                self.freeze_id = value.freeze_id
                await self.db.call(lambda db: db.execute("UPDATE control SET freeze=? WHERE id=1", (self.freeze_id,)), write=True)
            await self.db.call(lambda db: db.execute("UPDATE control SET epoch=? WHERE id=1", (value.host_epoch,)), write=True)
            self.host_epoch = value.host_epoch
        await self.code.stop_all()
        async with self.control:
            await self._shutdown(value)
            self.fence_ready = True
            await self.db.call(lambda db: db.execute("UPDATE control SET fence_ready=1 WHERE id=1"), write=True)
            return await self._health()

    async def monitor(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            try:
                async with self.control:
                    if self.draining:
                        continue
                    await self.mcp.poll()
                    await self.pty.poll()
                    for worker in await self.workers():
                        if worker.state == "stopped":
                            continue
                        dead = worker.process_lease is not None and exited(worker.process_lease)
                        last = self.heartbeats.setdefault(worker.worker_id, time.monotonic())
                        if dead or time.monotonic() - last > 15:
                            try:
                                await self.retire_worker(worker, "recovery", failed=self._unexpected_worker_exit(worker))
                            except Exception:
                                worker = await self.worker(worker.worker_id)
                                worker.state = "blocked"
                                await self.save_worker(worker)
            except Exception as error:
                self.blocked = failure_reason(error)
                if not self.db.failed:
                    await self._set_blocked(self.blocked)

    async def _close_services(self, session: str = "", *, require_clean: bool = True) -> None:
        results = await asyncio.gather(self.pty.close_all(session, require_clean=require_clean),
                                       self.mcp.close_all(session, require_clean=require_clean),
                                       self.plugins.close_all(session, require_clean=require_clean),
                                       self.remote.close_all(session, require_clean=require_clean), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def close(self) -> None:
        self.draining = True
        if self.monitor_task:
            self.monitor_task.cancel()
            await asyncio.gather(self.monitor_task, return_exceptions=True)
        await self.code.stop_all()
        await self.invocations.cancel_all()
        await self.invocations.close_handles()
        try:
            if not self.db.failed:
                await self._close_services(require_clean=False)
        finally:
            # Storage failure must not prevent closing already-owned process handles.
            await self.pty.close_handles()
            await self.mcp.close_handles()
            await self.plugins.close_handles()
            await self.remote.close_handles()
            await self.db.close()
