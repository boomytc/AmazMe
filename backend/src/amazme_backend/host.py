import asyncio
import base64
import binascii
import contextlib
import difflib
import hashlib
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
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .artifacts import (
    ArtifactBody,
    ArtifactList,
    ArtifactView,
    ArtifactWrite,
    list_artifacts,
    read_artifact,
    save_artifact,
)
from .automations import resolve_due
from .common import Peer, Profile, build_id, child_command, lock, private_write, wait_peer
from .computer_run import ComputerDriver, start_driver
from .computer_use import driver_point, upright_size
from .contracts import (
    ApprovalDecision,
    ApprovalEnvelope,
    ArchiveSession,
    Attachment,
    AutomationCreate,
    AutomationTick,
    AutomationView,
    BackendError,
    BranchSession,
    Cancel,
    CancelCode,
    CheckpointCreate,
    CheckpointList,
    CheckpointPreview,
    CheckpointRestore,
    CheckpointView,
    Cleanup,
    CodeRun,
    CodeView,
    Compaction,
    CompactSession,
    CompleteUpdate,
    ComputerActionRequest,
    ComputerActionView,
    ComputerCaptureView,
    ComputerCleanup,
    ComputerObserve,
    ComputerPolicy,
    CreateSession,
    EffectResolution,
    ExportBundle,
    ExportMessage,
    ExportSession,
    FeedbackView,
    FeedbackWrite,
    FreezeSupervisor,
    FreezeWorker,
    Health,
    HostFence,
    Identity,
    ImportResult,
    McpCall,
    McpCallEnvelope,
    McpCallRequest,
    McpDecision,
    McpDecisionEnvelope,
    McpOpen,
    McpView,
    MemoryList,
    MemoryView,
    MemoryWrite,
    Message,
    Model,
    ModelCatalog,
    ModelSettings,
    OpenCode,
    OpenMcp,
    OpenPlugin,
    OpenRemote,
    OpenTerminal,
    PluginCallEnvelope,
    PluginCallRequest,
    PluginCallView,
    PluginDraft,
    PluginList,
    PluginReload,
    PluginView,
    PreparedFileWrite,
    PrepareFileWrite,
    PrepareUpdate,
    ProcessLease,
    ProductSettings,
    ProjectList,
    ProjectView,
    ProjectWrite,
    Receipt,
    Recovery,
    ReloadPlugin,
    RemoteCallView,
    RemoteOpen,
    RemoteRun,
    RemoteView,
    ResolutionEnvelope,
    RetireSupervisor,
    SearchResults,
    Session,
    SessionDiagnostic,
    SessionList,
    SessionModel,
    SettingsUpdate,
    ShareMessage,
    ShareView,
    ShareWrite,
    Snapshot,
    StopWorker,
    Submission,
    Submit,
    SubmitRemote,
    SupervisorHealth,
    TerminalInput,
    TerminalList,
    TerminalOpen,
    TerminalQuery,
    TerminalResize,
    TerminalSession,
    TerminalSize,
    TerminalType,
    TerminalView,
    UpdateModelSettings,
    UpdateRecord,
    UsageReport,
    WebCallRequest,
    WebCallView,
    WebPolicy,
    WorkerActivity,
    WorkerInfo,
    WorkerSpec,
    WorkflowOpen,
    WorkflowVerdict,
    WorkflowView,
    WorkspaceGrantRequest,
    WorkspaceGrantView,
    WorkspaceList,
)
from .faults import Faults
from .host_store import Delivery, HostStore, ServiceRecord, checkpoint_id
from .manage import bundle_digest, bundle_text, contains_secret, transcript_digest
from .manage import digest as content_digest
from .memories import match_memories, remember
from .page_boot import boot_document
from .processes import ProcessReservation, exited, retain_inherited, wait_exited
from .providers import CATALOG, choose_model, public_settings, summarize
from .remote_session import daemon_identity
from .rpc import RpcCall, handle_rpc
from .session_ops import SessionOps, SessionRelay
from .storage import (
    TERMINAL,
    SessionStore,
    compaction_basis,
    read_settled_root,
    remove_session_directory,
    session_database,
)
from .transport import app_factory
from .web_tools import execute_web_call, original_question, validate_base_url
from .workspace_files import (
    FileChange,
    FileContent,
    FileEntry,
    FileList,
    FileWrite,
    capture_text,
    list_files,
    read_file,
    write_file,
)
from .workspace_map import PRIMARY, check_grant_directory, client_path, split_client_path, validate_workspace


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
        self.web_client: httpx.AsyncClient | None = None
        self.computer_scenario: Literal["unconfigured", "denied", "granted", "plain", "hold", "drop"] = "unconfigured"
        self.computer_drivers: dict[str, ComputerDriver] = {}
        self.computer_held: set[str] = set()
        self.computer_mu = asyncio.Lock()

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
        if health.blocked or health.session_errors or health.identity.state == "blocked":
            raise BackendError("update_health_blocked", status=503)
        if any(not terminal.clean for terminal in health.terminals):
            raise BackendError("execution_cleanup_pending", status=503)
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

    def workspace_root(self) -> Path:
        return Path(self.profile.config.workspace)

    async def workspaces(self) -> WorkspaceList:
        self._admit()
        primary = self.workspace_root()
        grants = [WorkspaceGrantView(name=name, host_path=host)
                  for name, host in await self.store.workspace_grants()]
        return WorkspaceList(workspaces=[
            WorkspaceGrantView(name=PRIMARY, host_path=str(primary), primary=True),
            *grants,
        ])

    async def add_workspace(self, value: WorkspaceGrantRequest) -> WorkspaceGrantView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        if value.name in {PRIMARY, "grant"}:
            raise BackendError("invalid_workspace_name")
        validate_workspace(value.name)
        host = check_grant_directory(Path(value.host_path), self.profile.path, self.workspace_root())
        await self.store.add_workspace_grant(value.name, str(host))
        return WorkspaceGrantView(name=value.name, host_path=str(host))

    async def remove_workspace(self, name: str) -> None:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        if name == PRIMARY:
            raise BackendError("workspace_grant_forbidden")
        await self.store.remove_workspace_grant(name)

    async def _mapped_root(self, relative: str) -> tuple[str, str, Path]:
        name, inner = split_client_path(relative)
        if name == "grant":
            raise BackendError("workspace_not_file")
        if name == PRIMARY:
            return name, inner, self.workspace_root()
        grants = dict(await self.store.workspace_grants())
        host = grants.get(name)
        if host is None:
            raise BackendError("workspace_not_found", status=404)
        return name, inner, Path(host)

    async def list_workspace(self, relative: str = "") -> FileList:
        self._admit()
        name, inner = split_client_path(relative)
        if name == "grant":
            grants = await self.store.workspace_grants()
            return FileList(path="grant", entries=[
                FileEntry(name=item, kind="dir", size=0) for item, _host in grants
            ])
        root_name, inner, root = await self._mapped_root(relative)
        listing = list_files(root, inner)
        listing.path = client_path(root_name, inner)
        listing.absolute_path = str(root / inner)
        return listing

    async def read_workspace(self, relative: str) -> FileContent:
        self._admit()
        name, inner, root = await self._mapped_root(relative)
        content = read_file(root, inner)
        content.path = client_path(name, content.path)
        content.absolute_path = str(root / inner)
        return content

    async def write_workspace(self, value: FileWrite) -> FileChange:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        name, inner, root = await self._mapped_root(value.path)
        shown = client_path(name, inner)
        current = self._current_text(root, inner)
        if current is not None and current[0] != value.expected_digest:
            raise BackendError("file_conflict")
        if current is None and value.expected_digest:
            raise BackendError("file_conflict")
        if current is not None:
            await self.store.save_checkpoint(
                checkpoint_id(name, shown, current[0]), name, shown, current[0], current[1])
        changed = write_file(root, value.model_copy(update={"path": inner}))
        changed.path = shown
        return changed

    def _current_text(self, root: Path, inner: str) -> tuple[str, str] | None:
        return capture_text(root, inner)

    async def create_checkpoint(self, value: CheckpointCreate) -> CheckpointView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        name, inner = split_client_path(value.path)
        if name == "grant" or not inner or name != value.workspace:
            raise BackendError("invalid_workspace_path")
        await self._require_workspace(name)
        _name, _inner, root = await self._mapped_root(value.path)
        current = self._current_text(root, inner)
        if current is None:
            raise BackendError("checkpoint_unavailable")
        await self.store.save_checkpoint(value.checkpoint_id, name, client_path(name, inner), current[0], current[1])
        return CheckpointView(checkpoint_id=value.checkpoint_id, workspace=name, path=client_path(name, inner), digest=current[0])

    async def prepare_tool_write(self, value: PrepareFileWrite) -> PreparedFileWrite:
        self._admit()
        if value.host_epoch != self.fence.host_epoch or value.build_id != self.build:
            raise BackendError("stale_host_epoch")
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        service = await self.store.service()
        if service is None or service.state != "running" or exited(service.process_lease):
            raise BackendError("supervisor_unavailable", status=503)
        health = await self.supervisor.call("GET", "/health", SupervisorHealth)
        self._check_supervisor(health.identity, service, fenced=True)
        if (health.freeze_id or health.blocked or health.session_errors.get(value.session_id) or health.identity.state != "ready"
                or health.identity.instance_id != value.supervisor_id):
            raise BackendError("execution_blocked", status=503)
        worker = next((w for w in health.workers if w.worker_id == value.worker_id), None)
        if (worker is None or worker.session_id != value.session_id or worker.build_id != self.build
                or worker.host_epoch != value.host_epoch or worker.fingerprint != self.build
                or worker.execution_epoch != value.execution_epoch or worker.purpose != "business"
                or worker.state != "ready" or worker.process_lease is None or exited(worker.process_lease)):
            raise BackendError("worker_identity_mismatch", status=503)
        if not any(e.session_id == value.session_id and e.worker_id == value.worker_id
                   and e.execution_epoch == value.execution_epoch and e.state == "open" for e in health.epochs):
            raise BackendError("execution_cleanup_pending", status=503)
        prepared = await self.store.file_write_preparation(value.session_id, value.call_id, value.write)
        if prepared is not None:
            return prepared
        name, inner, root = await self._mapped_root(value.write.path)
        previous = capture_text(root, inner)
        return await self.store.prepare_file_write(value.session_id, value.call_id, value.write,
                                                    name, client_path(name, inner), previous)

    async def list_checkpoints(self, workspace: str, path: str) -> CheckpointList:
        self._admit()
        rows = await self.store.checkpoints_for(workspace, path)
        return CheckpointList(checkpoints=[
            CheckpointView(checkpoint_id=item[0], workspace=item[1], path=item[2], digest=item[3]) for item in rows
        ])

    async def preview_checkpoint(self, checkpoint_id: str) -> CheckpointPreview:
        self._admit()
        saved = await self.store.checkpoint(checkpoint_id)
        if saved is None:
            raise BackendError("checkpoint_not_found", status=404)
        _cid, workspace, path, digest, content = saved
        _name, inner, root = await self._mapped_root(path)
        current = self._current_text(root, inner) if inner else None
        current_text = "" if current is None else current[1]
        current_digest = "" if current is None else current[0]
        diff = "".join(difflib.unified_diff(
            content.splitlines(keepends=True), current_text.splitlines(keepends=True),
            fromfile=path, tofile=path))
        return CheckpointPreview(
            checkpoint_id=checkpoint_id, workspace=workspace, path=path,
            absolute_path=str(root / inner),
            digest=digest, content=content, current_digest=current_digest, diff=diff)

    async def restore_checkpoint(self, checkpoint_id: str, value: CheckpointRestore) -> FileChange:
        self._admit()
        saved = await self.store.checkpoint(checkpoint_id)
        if saved is None:
            raise BackendError("checkpoint_not_found", status=404)
        _cid, _workspace, path, _digest, content = saved
        return await self.write_workspace(FileWrite(path=path, content=content, expected_digest=value.expected_digest))

    def _terminal_fence(self, session_id: str, terminal_id: str) -> TerminalQuery:
        return TerminalQuery(host_epoch=self.fence.host_epoch, build_id=self.build,
                             session_id=session_id, terminal_id=terminal_id)

    async def open_terminal(self, session_id: str, value: TerminalOpen) -> TerminalView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        return await self.supervisor.call("POST", "/pty/open", TerminalView, OpenTerminal(
            host_epoch=self.fence.host_epoch, build_id=self.build, session_id=session_id,
            terminal_id=value.terminal_id, command=value.command, cols=value.cols, rows=value.rows,
            workspace=value.workspace))

    async def type_terminal(self, session_id: str, terminal_id: str, value: TerminalType) -> TerminalView:
        self._admit()
        return await self.supervisor.call("POST", "/pty/input", TerminalView, TerminalInput(
            **self._terminal_fence(session_id, terminal_id).model_dump(), input_id=value.input_id, data=value.data))

    async def resize_terminal(self, session_id: str, terminal_id: str, value: TerminalSize) -> TerminalView:
        self._admit()
        return await self.supervisor.call("POST", "/pty/resize", TerminalView, TerminalResize(
            **self._terminal_fence(session_id, terminal_id).model_dump(), cols=value.cols, rows=value.rows))

    async def read_terminal(self, session_id: str, terminal_id: str) -> TerminalView:
        self._admit()
        return await self.supervisor.call("POST", "/pty/read", TerminalView, self._terminal_fence(session_id, terminal_id))

    async def list_terminals(self, session_id: str) -> TerminalList:
        self._admit()
        return await self.supervisor.call("POST", "/pty/list", TerminalList, TerminalSession(
            host_epoch=self.fence.host_epoch, build_id=self.build, session_id=session_id))

    async def close_terminal(self, session_id: str, terminal_id: str) -> TerminalView:
        self._admit()
        return await self.supervisor.call("POST", "/pty/close", TerminalView, self._terminal_fence(session_id, terminal_id))

    def _mcp_fence(self, session_id: str) -> dict[str, object]:
        return {"host_epoch": self.fence.host_epoch, "build_id": self.build, "session_id": session_id}

    async def open_mcp(self, session_id: str, value: McpOpen) -> McpView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        return await self.supervisor.call("POST", "/mcp/open", McpView, OpenMcp(
            **self._mcp_fence(session_id), server_id=value.server_id, command=value.command))  # type: ignore[arg-type]

    async def request_mcp(self, session_id: str, server_id: str, value: McpCallRequest) -> McpCall:
        self._admit()
        return await self.supervisor.call("POST", "/mcp/calls", McpCall, McpCallEnvelope(
            **self._mcp_fence(session_id), server_id=server_id, call=value))  # type: ignore[arg-type]

    async def decide_mcp(self, session_id: str, server_id: str, call_id: str, value: McpDecision) -> McpCall:
        self._admit()
        return await self.supervisor.call("POST", "/mcp/decision", McpCall, McpDecisionEnvelope(
            **self._mcp_fence(session_id), server_id=server_id, call_id=call_id, decision=value))  # type: ignore[arg-type]

    def _remote_body(self, session_id: str, value: RemoteOpen) -> OpenRemote:
        return OpenRemote(host_epoch=self.fence.host_epoch, build_id=self.build, session_id=session_id,
                          remote_id=value.remote_id, host=value.host, host_key=value.host_key,
                          daemon_id=daemon_identity(), generation=value.generation, endpoint=value.endpoint)

    async def run_code(self, session_id: str, value: CodeRun) -> CodeView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        return await self.supervisor.call("POST", "/code/run", CodeView, OpenCode(
            host_epoch=self.fence.host_epoch, build_id=self.build, session_id=session_id,
            run_id=value.run_id, source=value.source))

    async def cancel_code(self, session_id: str, run_id: str) -> CodeView:
        self._admit()
        return await self.supervisor.call("POST", "/code/cancel", CodeView, CancelCode(
            host_epoch=self.fence.host_epoch, build_id=self.build, session_id=session_id, run_id=run_id))

    async def open_remote(self, session_id: str, value: RemoteOpen) -> RemoteView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        return await self.supervisor.call("POST", "/remotes/open", RemoteView, self._remote_body(session_id, value))

    async def reconnect_remote(self, session_id: str, value: RemoteOpen) -> RemoteView:
        self._admit()
        return await self.supervisor.call("POST", "/remotes/reconnect", RemoteView, self._remote_body(session_id, value))

    async def disconnect_remote(self, session_id: str, value: RemoteOpen) -> RemoteView:
        self._admit()
        return await self.supervisor.call("POST", "/remotes/disconnect", RemoteView, self._remote_body(session_id, value))

    async def submit_remote(self, session_id: str, value: RemoteRun) -> RemoteCallView:
        self._admit()
        body = self._remote_body(session_id, value)
        return await self.supervisor.call("POST", "/remotes/calls", RemoteCallView, SubmitRemote(
            **body.model_dump(), call_id=value.call_id, command=value.command))

    async def cancel_mcp(self, session_id: str, value: McpOpen) -> McpView:
        self._admit()
        return await self.supervisor.call("POST", "/mcp/cancel", McpView, OpenMcp(
            **self._mcp_fence(session_id), server_id=value.server_id, command=value.command))  # type: ignore[arg-type]

    def model_catalog(self) -> ModelCatalog:
        self._admit()
        self.profile.reload_provider()
        return ModelCatalog(models=list(CATALOG), current=public_settings(self.profile.config.provider))

    async def session_model(self, session_id: str) -> SessionModel:
        self._admit()
        found = await self.store.session_model(session_id)
        if found is None:
            raise BackendError("session_model_missing", status=404)
        return found

    async def save_session_model(self, value: SessionModel) -> SessionModel:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        return await self.store.save_session_model(value)

    async def update_model(self, value: UpdateModelSettings) -> ModelSettings:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        self.profile.reload_provider()
        chosen = choose_model(self.profile.config.provider, value)
        self.profile.save_provider(chosen)
        return public_settings(self.profile.config.provider)

    async def _require_workspace(self, name: str) -> None:
        if name == PRIMARY:
            return
        validate_workspace(name)
        if name not in {item for item, _host in await self.store.workspace_grants()}:
            raise BackendError("workspace_not_found", status=404)

    async def create_session(self, value: CreateSession) -> Session:
        self._admit()
        await self._require_workspace(value.workspace)
        return await self.store.create_session(secrets.token_hex(16), value)

    def _provider_secret(self) -> str:
        return self.profile.config.provider.api_key.get_secret_value()

    async def _open_transcript(self, session: str) -> list[tuple[str, str, str]]:
        path = session_database(self.profile.path, session)
        if not path.is_file():
            return []
        return await self._read_session(session, lambda store: store.transcript())

    async def save_project(self, value: ProjectWrite) -> ProjectView:
        self._admit()
        project_id, name = await self.store.save_project(value.project_id, value.name.strip())
        return ProjectView(project_id=project_id, name=name)

    async def projects(self) -> ProjectList:
        self._admit()
        return ProjectList(projects=[ProjectView(project_id=project_id, name=name)
                                     for project_id, name in await self.store.projects()])

    async def product_settings(self) -> ProductSettings:
        self._admit()
        name, revision = await self.store.product_settings()
        return ProductSettings(display_name=name, revision=revision)

    async def save_product_settings(self, value: SettingsUpdate) -> ProductSettings:
        self._admit()
        name, revision = await self.store.save_product_settings(value.display_name.strip(), value.expected_revision)
        return ProductSettings(display_name=name, revision=revision)

    async def save_feedback(self, value: FeedbackWrite) -> FeedbackView:
        self._admit()
        text = value.text.strip()
        if contains_secret(text, self._provider_secret()):
            raise BackendError("feedback_secret")
        if value.session_id:
            if not await self.store.exists(value.session_id):
                raise BackendError("session_not_found", status=404)
        key = content_digest(json.dumps({"session_id": value.session_id, "text": text},
                                        sort_keys=True, separators=(",", ":"), ensure_ascii=False))
        feedback_id, session_id, stored = await self.store.save_feedback(value.feedback_id, value.session_id, text, key)
        return FeedbackView(feedback_id=feedback_id, session_id=session_id, text=stored)

    def _reject_artifact_secret(self, value: ArtifactWrite) -> None:
        secret = self._provider_secret()
        if not secret:
            return
        if secret in value.name:
            raise BackendError("artifact_secret")
        try:
            raw = base64.b64decode(value.data_base64, validate=True)
        except (binascii.Error, ValueError):
            return
        if secret.encode() in raw:
            raise BackendError("artifact_secret")

    async def put_artifact(self, session: str, value: ArtifactWrite) -> ArtifactView:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        self._reject_artifact_secret(value)
        return save_artifact(self.profile.path, session, value)

    async def artifacts(self, session: str) -> ArtifactList:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        return list_artifacts(self.profile.path, session)

    async def artifact(self, session: str, artifact_id: str) -> ArtifactBody:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        return read_artifact(self.profile.path, session, artifact_id)

    async def share_session(self, session: str, value: ShareWrite) -> ShareView:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        messages = await self._open_transcript(session)
        key = transcript_digest(messages)
        current = await self.store.share_record(value.share_id)
        if current is not None and current != (key, session):
            raise BackendError("share_conflict")
        if contains_secret("\n".join(content for _request, _role, content in messages), self._provider_secret()):
            raise BackendError("share_secret")
        view = ShareView(share_id=value.share_id, session_id=session, digest=key, messages=[
            ShareMessage.model_validate({"request_id": request_id, "role": role, "content": content})
            for request_id, role, content in messages])
        payload = await self.store.save_share(value.share_id, session, view.digest, view.model_dump_json())
        return ShareView.model_validate_json(payload)

    async def read_share(self, session: str, share_id: str) -> ShareView:
        self._admit()
        return ShareView.model_validate_json(await self.store.read_share(share_id, session))

    async def export_bundle(self) -> ExportBundle:
        self._admit()
        projects = await self.projects()
        name, revision = await self.store.product_settings()
        feedback = [FeedbackView(feedback_id=feedback_id, session_id=session_id, text=text)
                    for feedback_id, session_id, text in await self.store.feedback_rows()]
        sessions: list[ExportSession] = []
        for item in (await self.sessions()).sessions:
            messages = await self._open_transcript(item.session_id)
            sessions.append(ExportSession(
                session_id=item.session_id, title=item.title, project_id=item.project_id, workspace=item.workspace,
                messages=[ExportMessage.model_validate({"request_id": request_id, "role": role, "content": content})
                          for request_id, role, content in messages if content]))
        bundle = ExportBundle(format="amazme-export/1", projects=projects.projects, sessions=sessions,
                             feedback=feedback, settings=ProductSettings(display_name=name, revision=revision))
        if contains_secret(bundle_text(bundle), self._provider_secret()):
            raise BackendError("export_secret")
        return bundle.model_copy(update={"digest": bundle_digest(bundle)})

    async def import_bundle(self, bundle: ExportBundle) -> ImportResult:
        self._admit()
        if bundle.format != "amazme-export/1":
            raise BackendError("import_format")
        if bundle.digest != bundle_digest(bundle):
            raise BackendError("import_digest")
        if contains_secret(bundle_text(bundle), self._provider_secret()):
            raise BackendError("import_secret")
        if len(bundle.sessions) > 32 or len(bundle.projects) > 32 or len(bundle.feedback) > 32:
            raise BackendError("import_capacity", status=429)
        existing = {item.session_id: item for item in (await self.sessions()).sessions}
        known_projects = {project.project_id: project.name for project in (await self.projects()).projects}
        for project in bundle.projects:
            current = known_projects.get(project.project_id)
            if current is not None and current != project.name:
                raise BackendError("import_conflict")
        current_name, current_revision = await self.store.product_settings()
        if bundle.settings.display_name and current_revision and current_name != bundle.settings.display_name:
            raise BackendError("import_conflict")
        known_feedback = {feedback_id: (session_id, text) for feedback_id, session_id, text in await self.store.feedback_rows()}
        for item in bundle.feedback:
            current = known_feedback.get(item.feedback_id)
            if current is not None and current != (item.session_id, item.text):
                raise BackendError("import_conflict")
        created = 0
        for item in bundle.sessions:
            incoming = [(message.request_id, message.role, message.content) for message in item.messages]
            record = existing.get(item.session_id)
            if record is None:
                created += 1
                continue
            current = await self._open_transcript(item.session_id)
            if (record.title != item.title or record.workspace != item.workspace or record.project_id != item.project_id
                    or transcript_digest(current) != transcript_digest(incoming)):
                raise BackendError("import_conflict")
        for project in bundle.projects:
            await self.store.save_project(project.project_id, project.name)
        if bundle.settings.display_name and current_revision == 0:
            await self.store.save_product_settings(bundle.settings.display_name, 0)
        for item in bundle.feedback:
            key = content_digest(json.dumps({"session_id": item.session_id, "text": item.text},
                                            sort_keys=True, separators=(",", ":"), ensure_ascii=False))
            await self.store.save_feedback(item.feedback_id, item.session_id, item.text, key)
        for item in bundle.sessions:
            await self._require_workspace(item.workspace)
            await self.store.ensure_import_session(item.session_id, item.title, item.workspace, item.project_id)
            messages = [(message.request_id, message.role, message.content) for message in item.messages]
            await self._with_session(
                item.session_id, lambda store: store.import_transcript(messages), require_active=False)
        return ImportResult(format="amazme-export/1", sessions=len(bundle.sessions), created=created)

    async def save_memory(self, value: MemoryWrite) -> MemoryView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        text = value.text.strip()
        digest = remember(value.workspace, text)
        await self._require_workspace(value.workspace)
        memory_id, workspace, stored = await self.store.save_memory(value.memory_id, value.workspace, text, digest)
        return MemoryView(memory_id=memory_id, workspace=workspace, text=stored)

    async def memories_for(self, workspace: str, query: str) -> MemoryList:
        self._admit()
        await self._require_workspace(workspace)
        rows = await self.store.memory_rows()
        if query.strip():
            found = match_memories(rows, workspace, query)
        else:
            found = [MemoryView(memory_id=memory_id, workspace=item_workspace, text=text)
                     for memory_id, item_workspace, text in rows if item_workspace == workspace][:50]
        return MemoryList(workspace=workspace, memories=found)

    async def injection_preview(self, session_id: str, query: str) -> MemoryList:
        self._admit()
        if not await self.store.exists(session_id):
            raise BackendError("session_not_found", status=404)
        session = next(item for item in (await self.sessions()).sessions if item.session_id == session_id)
        found = match_memories(await self.store.memory_rows(), session.workspace, query)
        return MemoryList(workspace=session.workspace, memories=found)

    def _automation(self, row: sqlite3.Row) -> AutomationView:
        phase = str(row["phase"])
        if phase not in {"scheduled", "done", "unknown"}:
            phase = "unknown"
        return AutomationView(
            automation_id=str(row["id"]), session_id=str(row["session"]), workspace=str(row["workspace"]),
            text=str(row["text"]), zone=str(row["zone"]), local=str(row["local"]), fold=int(row["fold"]),
            due_ms=int(row["due_ms"]), phase=phase, delivery_id=str(row["delivery_id"]))  # type: ignore[arg-type]

    async def create_automation(self, value: AutomationCreate) -> AutomationView:
        self._admit()
        due_ms, fold = resolve_due(value.local, value.zone, value.fold)
        if not await self.store.exists(value.session_id):
            raise BackendError("session_not_found", status=404)
        session = next(item for item in (await self.sessions()).sessions if item.session_id == value.session_id)
        row = await self.store.save_automation(
            value.automation_id, value.session_id, session.workspace, value.text.strip(),
            value.zone, value.local, fold, due_ms)
        return self._automation(row)

    async def tick_automations(self) -> AutomationTick:
        self._admit()
        if await self.store.active_update():
            return AutomationTick()
        row = await self.store.claim_due_automation(int(time.time() * 1000))
        if row is None:
            return AutomationTick()
        return AutomationTick(fired=self._automation(row))

    def _session_store(self, path: Path, session: str, *, read_only: bool) -> SessionStore:
        return SessionStore(path, session, build=self.build, config=self.profile.config.provider,
                            approval_policy=self.profile.config.approval_policy,
                            read_only=read_only, require_existing=read_only)

    async def _read_session[T](self, session: str, operation: Callable[[SessionStore], Awaitable[T]]) -> T:
        path = session_database(self.profile.path, session)
        store = self._session_store(path, session, read_only=True)
        try:
            await store.initialize()
            return await operation(store)
        finally:
            await store.db.close()

    async def _with_session[T](self, session: str, operation: Callable[[SessionOps], Awaitable[T]], *,
                                require_active: bool = True, write: bool = True) -> T:
        self._admit()
        if require_active and await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        source = next(item for item in (await self.sessions()).sessions if item.session_id == session)
        if require_active and source.archived:
            raise BackendError("session_archived")
        path = session_database(self.profile.path, session)
        if not path.parent.exists():
            path.parent.mkdir(parents=True, mode=0o700)
        read_only = not write and path.is_file()
        worker = self._session_store(path, session, read_only=read_only)
        try:
            await worker.initialize()
        except BackendError as exc:
            await worker.db.close()
            if exc.code != "session_locked":
                raise
            if not write:
                if not path.is_file():
                    raise
                reader = self._session_store(path, session, read_only=True)
                try:
                    await reader.initialize()
                    return await operation(reader)
                finally:
                    await reader.db.close()
            service = await self.store.service()
            if service is None or exited(service.process_lease):
                raise
            # The session worker already owns the library. Send the write to that process.
            return await operation(SessionRelay(await self.worker(session)))
        try:
            return await operation(worker)
        finally:
            await worker.db.close()

    async def open_workflow(self, session: str, value: WorkflowOpen) -> WorkflowView:
        return await self._with_session(
            session, lambda store: store.open_workflow(value.workflow_id, value.check, value.correction_limit))

    async def workflow(self, session: str, workflow_id: str) -> WorkflowView:
        return await self._with_session(
            session, lambda store: store.workflow(workflow_id), require_active=False, write=False)

    async def resume_workflow(self, session: str, workflow_id: str) -> WorkflowView:
        return await self._with_session(
            session, lambda store: store.resume_workflow(workflow_id), require_active=False)

    async def record_verdict(self, session: str, workflow_id: str, value: WorkflowVerdict) -> WorkflowView:
        return await self._with_session(
            session, lambda store: store.record_verdict(workflow_id, value.verdict_id, value.passed))

    async def cancel_workflow(self, session: str, workflow_id: str) -> WorkflowView:
        async def operation(store: SessionOps) -> WorkflowView:
            view = await store.workflow(workflow_id)
            await store.cancel(view.parent_id, HostFence(host_epoch=await store.host_epoch(), build_id=self.build))
            return await store.workflow(workflow_id)
        return await self._with_session(session, operation)

    async def cancel_workflow_child(self, session: str, workflow_id: str, request_id: str) -> WorkflowView:
        return await self._with_session(
            session, lambda store: store.cancel_workflow_child(workflow_id, request_id))

    def _web_key(self) -> str:
        provider = self.profile.config.provider
        if provider.provider != "deepseek":
            return ""
        return provider.api_key.get_secret_value()

    async def save_web_policy(self, session: str, value: WebPolicy) -> WebPolicy:
        saved = value.model_copy(update={"base_url": validate_base_url(value.base_url)})
        return await self._with_session(session, lambda store: store.save_web_policy(saved))

    async def web_policy(self, session: str) -> WebPolicy:
        return await self._with_session(session, lambda store: store.web_policy(), require_active=False, write=False)

    async def _web_question(self, session: str) -> str:
        async def read(store: SessionOps) -> str:
            roots = [item for item in (await store.snapshot()).requests if item.kind == "root"]
            if not roots:
                return ""
            messages = await store.messages(roots[-1].request_id)
            text = next((item.content for item in reversed(messages)
                         if item.role == "user" and item.content.strip()), roots[-1].text)
            return original_question(text)
        return await self._with_session(session, read, require_active=False, write=False)

    async def web_call(self, session: str, value: WebCallRequest) -> WebCallView:
        question = ""
        if value.kind == "search":
            policy = await self.web_policy(session)
            if policy.enabled and policy.send_original_question and self._web_key():
                question = await self._web_question(session)
        return await self._with_session(
            session, lambda store: execute_web_call(
                store, value, key=self._web_key(), question=question, client=self.web_client))

    async def _computer_enter(self, session: str) -> bool:
        async with self.computer_mu:
            if session in self.computer_held:
                return False
            self.computer_held.add(session)
            return True

    async def _computer_leave(self, session: str) -> None:
        async with self.computer_mu:
            self.computer_held.discard(session)

    @staticmethod
    def _driver_int(hello: dict[str, object], key: str) -> int:
        value = hello.get(key)
        if not isinstance(value, int):
            raise BackendError("computer_driver_lost")
        return value

    async def save_computer_policy(self, session: str, value: ComputerPolicy) -> ComputerPolicy:
        return await self._with_session(session, lambda store: store.save_computer_policy(value))

    async def computer_policy(self, session: str) -> ComputerPolicy:
        return await self._with_session(
            session, lambda store: store.computer_policy(), require_active=False, write=False)

    async def _park_driver(self, session: str, driver: ComputerDriver) -> int | None:
        self.computer_drivers.pop(session, None)
        return await asyncio.to_thread(driver.stop)

    async def computer_observe(self, session: str) -> ComputerObserve:
        policy = await self.computer_policy(session)
        if not policy.enabled:
            raise BackendError("computer_disabled")
        if await self._with_session(session, lambda store: store.computer_blocked(), write=False):
            raise BackendError("computer_blocked")
        if not await self._computer_enter(session):
            raise BackendError("computer_busy")
        try:
            driver = self.computer_drivers.get(session)
            if driver is None or driver.process.poll() is not None:
                if driver is not None:
                    code = await self._park_driver(session, driver)
                    await self._with_session(session, lambda store: store.note_computer_exit(code))
                    raise BackendError("computer_blocked")
                directory = session_database(self.profile.path, session).parent
                driver = await asyncio.to_thread(start_driver, directory, self.computer_scenario)
                self.computer_drivers[session] = driver
            hello = driver.hello
            accessibility = hello.get("accessibility") is True
            screen = hello.get("screen") is True
            identity = str(hello.get("identity") or "")
            if not accessibility or not screen:
                await self._park_driver(session, driver)
                return ComputerObserve(permitted=False, accessibility=accessibility, screen=screen,
                                       identity=identity, error="permission_required")
            raw_width = self._driver_int(hello, "raw_width")
            raw_height = self._driver_int(hello, "raw_height")
            orientation = self._driver_int(hello, "orientation")
            scale = self._driver_int(hello, "scale")
            width, height = upright_size(raw_width, raw_height, orientation)
            capture_id = hashlib.sha256(f"{session}:{identity}:{time.time_ns()}".encode()).hexdigest()[:32]
            reply = await asyncio.to_thread(driver.request, {"op": "observe", "capture_id": capture_id})
            if reply.get("capture_id") != capture_id:
                raise BackendError("computer_driver_lost")
            capture = ComputerCaptureView(
                capture_id=capture_id, width=width, height=height, raw_width=raw_width, raw_height=raw_height,
                orientation=orientation, scale=scale, observed_ms=time.time_ns() // 1_000_000)
            await self._with_session(session, lambda store: store.save_computer_capture(capture))
            return ComputerObserve(permitted=True, accessibility=True, screen=True, identity=identity, capture=capture)
        finally:
            await self._computer_leave(session)

    async def computer_action(self, session: str, value: ComputerActionRequest) -> ComputerActionView:
        policy = await self.computer_policy(session)
        if not policy.enabled:
            raise BackendError("computer_disabled")
        body = json.dumps({"capture_id": value.capture_id, "x": value.x, "y": value.y},
                          sort_keys=True, separators=(",", ":"))
        found = await self._with_session(
            session, lambda store: store.find_computer_action(value.action_id, body), write=False)
        if found is not None:
            return found
        if await self._with_session(session, lambda store: store.computer_blocked(), write=False):
            raise BackendError("computer_blocked")
        capture = await self._with_session(
            session, lambda store: store.latest_computer_capture(), write=False)
        if (capture is None or capture.capture_id != value.capture_id
                or time.time_ns() // 1_000_000 - capture.observed_ms > policy.max_age_ms):
            raise BackendError("computer_stale")
        point = driver_point(value.x, value.y, capture.raw_width, capture.raw_height,
                             capture.orientation, capture.scale)
        if not await self._computer_enter(session):
            raise BackendError("computer_busy")
        try:
            view, send = await self._with_session(session, lambda store: store.begin_computer_action(value.action_id, body))
            if not send:
                return view
            driver = self.computer_drivers.get(session)
            if driver is None or driver.process.poll() is not None:
                code = await self._park_driver(session, driver) if driver is not None else None
                await self._with_session(session, lambda store: store.note_computer_exit(code))
                return await self._with_session(session, lambda store: store.settle_computer_action(
                    value.action_id, "unknown", "computer_driver_lost", None, None))
            try:
                reply = await asyncio.to_thread(driver.request, {
                    "op": "act", "capture_id": value.capture_id, "x": point[0], "y": point[1]})
            except BackendError:
                code = await self._park_driver(session, driver)
                await self._with_session(session, lambda store: store.note_computer_exit(code))
                return await self._with_session(session, lambda store: store.settle_computer_action(
                    value.action_id, "unknown", "computer_driver_lost", None, None))
            if reply.get("op") != "acted" or reply.get("x") != point[0] or reply.get("y") != point[1]:
                return await self._with_session(session, lambda store: store.settle_computer_action(
                    value.action_id, "failed", "computer_rejected", None, None))
            return await self._with_session(session, lambda store: store.settle_computer_action(
                value.action_id, "done", "", point[0], point[1]))
        finally:
            await self._computer_leave(session)

    async def computer_cleanup(self, session: str) -> ComputerCleanup:
        driver = self.computer_drivers.get(session)
        if driver is not None and driver.process.poll() is None:
            raise BackendError("computer_exit_unproven")
        if driver is not None:
            code = await self._park_driver(session, driver)
            await self._with_session(session, lambda store: store.note_computer_exit(code))
        blocked, exit_code, proof = await self._with_session(
            session, lambda store: store.computer_runtime(), write=False)
        if not blocked:
            return ComputerCleanup(cleared=True, proof=proof)
        if exit_code is None:
            raise BackendError("computer_exit_unproven")
        digest = hashlib.sha256(f"computer-cleanup:{exit_code}".encode()).hexdigest()
        stored = await self._with_session(session, lambda store: store.finish_computer_cleanup(digest))
        return ComputerCleanup(cleared=True, proof=stored)

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

    async def search_session(self, session: str, query: str) -> SearchResults:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        path = session_database(self.profile.path, session)
        if not path.is_file():
            return SearchResults(query=query.strip(), hits=[])
        hits = await self._read_session(session, lambda store: store.search(query))
        return SearchResults(query=query.strip(), hits=hits)

    async def session_usage(self, session: str) -> UsageReport:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        path = session_database(self.profile.path, session)
        if not path.is_file():
            return UsageReport(session_id=session, priced=True, cost_micro_usd=0)
        return await self._read_session(session, lambda store: store.usage())

    async def session_diagnostic(self, session: str) -> SessionDiagnostic:
        self._admit()
        if not await self.store.exists(session):
            raise BackendError("session_not_found", status=404)
        path = session_database(self.profile.path, session)
        if not path.is_file():
            return SessionDiagnostic(session_id=session, present=False, state="absent")
        return await self._read_session(session, lambda store: store.diagnostic())

    async def _plugin_work_pending(self) -> bool:
        for session in (await self.sessions()).sessions:
            path = session_database(self.profile.path, session.session_id)
            if not path.is_file():
                continue
            snapshot = await self._read_session(session.session_id, lambda store: store.snapshot())
            if any(item.status not in TERMINAL for item in snapshot.requests):
                return True
        return False

    async def register_plugin(self, value: PluginDraft) -> PluginView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        if await self._plugin_work_pending():
            raise BackendError("plugin_reload_blocked", status=409)
        return await self.supervisor.call("POST", "/plugins/register", PluginView, OpenPlugin(
            host_epoch=self.fence.host_epoch, build_id=self.build, plugin_id=value.plugin_id,
            name=value.name, config=value.config))

    async def reload_plugin(self, plugin_id: str, value: PluginReload) -> PluginView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        if await self._plugin_work_pending():
            raise BackendError("plugin_reload_blocked", status=409)
        return await self.supervisor.call("POST", "/plugins/reload", PluginView, ReloadPlugin(
            host_epoch=self.fence.host_epoch, build_id=self.build, plugin_id=plugin_id, config=value.config))

    async def call_plugin(self, session_id: str, plugin_id: str, value: PluginCallRequest) -> PluginCallView:
        self._admit()
        if await self.store.active_update():
            raise BackendError("update_frozen", status=503)
        return await self.supervisor.call("POST", "/plugins/call", PluginCallView, PluginCallEnvelope(
            host_epoch=self.fence.host_epoch, build_id=self.build, session_id=session_id,
            plugin_id=plugin_id, call_id=value.call_id, text=value.text))

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

        async def operation(store: SessionOps) -> None:
            fence = HostFence(host_epoch=await store.host_epoch(), build_id=self.build)
            for receipt in (await store.snapshot()).requests:
                if receipt.kind == "root" and receipt.status not in TERMINAL and not receipt.cancel_requested:
                    await store.cancel(receipt.request_id, fence)

        await self._with_session(session, operation, require_active=False)

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
        payloads = await self._read_session(session, lambda store: store.message_payloads(value.through_request_id))
        if not payloads:
            raise BackendError("compaction_unsettled")
        basis = compaction_basis(payloads)
        # Summarize before the commit. A failed summary does not replace or delete history.
        summary = await summarize(self.profile.config.provider, [
            Message.model_validate_json(payload) for payload in payloads])
        return await self._with_session(
            session, lambda store: store.commit_compaction(
                value.compaction_id, value.through_request_id, summary, basis))

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
                failures = health.session_errors.get(session, [])
                if "worker_restart_budget_exhausted" in failures:
                    raise BackendError("worker_restart_budget_exhausted", status=503)
                if failures or health.blocked or health.identity.state == "blocked":
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

    def release_attachment(self, session: str, attachment_id: str) -> None:
        existing = self.attachments.get(attachment_id)
        if existing and existing.session_id != session:
            raise BackendError("attachment_conflict")
        self.attachments.pop(attachment_id, None)
        self.attachment_seen.pop(attachment_id, None)

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
                    await self.tick_automations()
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
                or proof.session_id != info.session_id
                or proof.execution_epoch != info.execution_epoch or proof.resources):
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
            self._check_supervisor(identity, service)
            service.state = "stopping"
            await self.store.save_service(service)
            await self.supervisor.call(
                "POST", "/shutdown", Identity,
                HostFence(host_epoch=self.fence.host_epoch, build_id=service.build_id),
            )
            await wait_exited(service.process_lease, 30)
            service.state = "stopped"
            await self.store.save_service(service)

    async def close(self) -> None:
        self.closing = True
        self.stop.set()
        if self.background:
            self.background.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.background
        try:
            await self.stop_owned_supervisor()
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
        if "content-security-policy" not in response.headers:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; frame-ancestors 'none'; connect-src 'self'; style-src 'self'"
            )
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

    @app.post("/api/v1/memories")
    async def save_memory(value: MemoryWrite) -> MemoryView:
        return await owner.save_memory(value)

    @app.get("/api/v1/memories")
    async def memories(workspace: str = "primary", q: str = "") -> MemoryList:
        return await owner.memories_for(workspace, q)

    @app.get("/api/v1/sessions/{session_id}/memories")
    async def session_memories(session_id: str, q: str = "") -> MemoryList:
        return await owner.injection_preview(session_id, q)

    @app.post("/api/v1/automations")
    async def create_automation(value: AutomationCreate) -> AutomationView:
        return await owner.create_automation(value)

    @app.post("/api/v1/automations/tick")
    async def tick_automations() -> AutomationTick:
        return await owner.tick_automations()

    @app.post("/api/v1/sessions/{session}/workflows")
    async def open_workflow(session: str, value: WorkflowOpen) -> WorkflowView:
        return await owner.open_workflow(session, value)

    @app.get("/api/v1/sessions/{session}/workflows/{workflow_id}")
    async def workflow(session: str, workflow_id: str) -> WorkflowView:
        return await owner.workflow(session, workflow_id)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/verdicts")
    async def record_verdict(session: str, workflow_id: str, value: WorkflowVerdict) -> WorkflowView:
        return await owner.record_verdict(session, workflow_id, value)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/resume")
    async def resume_workflow(session: str, workflow_id: str) -> WorkflowView:
        return await owner.resume_workflow(session, workflow_id)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/cancel")
    async def cancel_workflow(session: str, workflow_id: str) -> WorkflowView:
        return await owner.cancel_workflow(session, workflow_id)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/children/{request_id}/cancel")
    async def cancel_workflow_child(session: str, workflow_id: str, request_id: str) -> WorkflowView:
        return await owner.cancel_workflow_child(session, workflow_id, request_id)

    @app.get("/api/v1/sessions/{session}/web")
    async def web_policy(session: str) -> WebPolicy:
        return await owner.web_policy(session)

    @app.post("/api/v1/sessions/{session}/web")
    async def save_web_policy(session: str, value: WebPolicy) -> WebPolicy:
        return await owner.save_web_policy(session, value)

    @app.post("/api/v1/sessions/{session}/web/calls")
    async def web_call(session: str, value: WebCallRequest) -> WebCallView:
        return await owner.web_call(session, value)

    @app.get("/api/v1/sessions/{session}/computer")
    async def computer_policy(session: str) -> ComputerPolicy:
        return await owner.computer_policy(session)

    @app.post("/api/v1/sessions/{session}/computer")
    async def save_computer_policy(session: str, value: ComputerPolicy) -> ComputerPolicy:
        return await owner.save_computer_policy(session, value)

    @app.post("/api/v1/sessions/{session}/computer/observe")
    async def computer_observe(session: str) -> ComputerObserve:
        return await owner.computer_observe(session)

    @app.post("/api/v1/sessions/{session}/computer/actions")
    async def computer_action(session: str, value: ComputerActionRequest) -> ComputerActionView:
        return await owner.computer_action(session, value)

    @app.post("/api/v1/sessions/{session}/computer/cleanup")
    async def computer_cleanup(session: str) -> ComputerCleanup:
        return await owner.computer_cleanup(session)

    @app.post("/api/v1/sessions/{session}/artifacts", status_code=201)
    async def put_artifact(session: str, value: ArtifactWrite) -> ArtifactView:
        return await owner.put_artifact(session, value)

    @app.get("/api/v1/sessions/{session}/artifacts")
    async def artifacts(session: str) -> ArtifactList:
        return await owner.artifacts(session)

    @app.get("/api/v1/sessions/{session}/artifacts/{artifact_id}")
    async def artifact(session: str, artifact_id: str) -> ArtifactBody:
        return await owner.artifact(session, artifact_id)

    @app.get("/api/v1/workspaces")
    async def workspaces() -> WorkspaceList:
        return await owner.workspaces()

    @app.post("/api/v1/workspaces")
    async def add_workspace(value: WorkspaceGrantRequest) -> WorkspaceGrantView:
        return await owner.add_workspace(value)

    @app.delete("/api/v1/workspaces/{name}")
    async def remove_workspace(name: str) -> dict[str, bool]:
        await owner.remove_workspace(name)
        return {"removed": True}

    @app.get("/api/v1/files")
    async def files(path: str = "") -> FileList:
        return await owner.list_workspace(path)

    @app.get("/api/v1/files/content")
    async def file_content(path: str) -> FileContent:
        return await owner.read_workspace(path)

    @app.post("/api/v1/files/content")
    async def file_write(value: FileWrite) -> FileChange:
        return await owner.write_workspace(value)

    @app.post("/api/v1/checkpoints")
    async def create_checkpoint(value: CheckpointCreate) -> CheckpointView:
        return await owner.create_checkpoint(value)

    @app.get("/api/v1/checkpoints")
    async def checkpoints(workspace: str = "primary", path: str = "") -> CheckpointList:
        return await owner.list_checkpoints(workspace, path)

    @app.get("/api/v1/checkpoints/{checkpoint_id}")
    async def preview_checkpoint(checkpoint_id: str) -> CheckpointPreview:
        return await owner.preview_checkpoint(checkpoint_id)

    @app.post("/api/v1/checkpoints/{checkpoint_id}/restore")
    async def restore_checkpoint(checkpoint_id: str, value: CheckpointRestore) -> FileChange:
        return await owner.restore_checkpoint(checkpoint_id, value)

    @app.post("/api/v1/sessions/{session_id}/terminals")
    async def open_terminal(session_id: str, value: TerminalOpen) -> TerminalView:
        return await owner.open_terminal(session_id, value)

    @app.get("/api/v1/sessions/{session_id}/terminals")
    async def list_terminals(session_id: str) -> TerminalList:
        return await owner.list_terminals(session_id)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/close")
    async def close_terminal(session_id: str, terminal_id: str) -> TerminalView:
        return await owner.close_terminal(session_id, terminal_id)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/input")
    async def type_terminal(session_id: str, terminal_id: str, value: TerminalType) -> TerminalView:
        return await owner.type_terminal(session_id, terminal_id, value)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/resize")
    async def resize_terminal(session_id: str, terminal_id: str, value: TerminalSize) -> TerminalView:
        return await owner.resize_terminal(session_id, terminal_id, value)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/read")
    async def read_terminal(session_id: str, terminal_id: str) -> TerminalView:
        return await owner.read_terminal(session_id, terminal_id)

    @app.post("/api/v1/sessions/{session_id}/code")
    async def run_code(session_id: str, value: CodeRun) -> CodeView:
        return await owner.run_code(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/code/{run_id}/cancel")
    async def cancel_code(session_id: str, run_id: str) -> CodeView:
        return await owner.cancel_code(session_id, run_id)

    @app.post("/api/v1/sessions/{session_id}/remotes")
    async def open_remote(session_id: str, value: RemoteOpen) -> RemoteView:
        return await owner.open_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes/{remote_id}/reconnect")
    async def reconnect_remote(session_id: str, remote_id: str, value: RemoteOpen) -> RemoteView:
        if value.remote_id != remote_id:
            raise BackendError("remote_conflict")
        return await owner.reconnect_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes/{remote_id}/disconnect")
    async def disconnect_remote(session_id: str, remote_id: str, value: RemoteOpen) -> RemoteView:
        if value.remote_id != remote_id:
            raise BackendError("remote_conflict")
        return await owner.disconnect_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes/{remote_id}/calls")
    async def submit_remote(session_id: str, remote_id: str, value: RemoteRun) -> RemoteCallView:
        if value.remote_id != remote_id:
            raise BackendError("remote_conflict")
        return await owner.submit_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp")
    async def open_mcp(session_id: str, value: McpOpen) -> McpView:
        return await owner.open_mcp(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp/{server_id}/calls")
    async def request_mcp(session_id: str, server_id: str, value: McpCallRequest) -> McpCall:
        return await owner.request_mcp(session_id, server_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp/{server_id}/calls/{call_id}/decision")
    async def decide_mcp(session_id: str, server_id: str, call_id: str, value: McpDecision) -> McpCall:
        return await owner.decide_mcp(session_id, server_id, call_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp/{server_id}/cancel")
    async def cancel_mcp(session_id: str, server_id: str, value: McpOpen) -> McpView:
        return await owner.cancel_mcp(session_id, value)

    @app.get("/api/v1/session-models/{session_id}")
    async def session_model(session_id: str) -> SessionModel:
        return await owner.session_model(session_id)

    @app.put("/api/v1/session-models/{session_id}")
    async def save_session_model(session_id: str, value: SessionModel) -> SessionModel:
        if value.session_id != session_id:
            raise BackendError("session_model_mismatch")
        return await owner.save_session_model(value)

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

    @app.get("/api/v1/projects")
    async def projects() -> ProjectList:
        return await owner.projects()

    @app.post("/api/v1/projects")
    async def save_project(value: ProjectWrite) -> ProjectView:
        return await owner.save_project(value)

    @app.get("/api/v1/settings")
    async def product_settings() -> ProductSettings:
        return await owner.product_settings()

    @app.post("/api/v1/settings")
    async def save_product_settings(value: SettingsUpdate) -> ProductSettings:
        return await owner.save_product_settings(value)

    @app.post("/api/v1/feedback")
    async def save_feedback(value: FeedbackWrite) -> FeedbackView:
        return await owner.save_feedback(value)

    @app.post("/api/v1/sessions/{session}/shares")
    async def share_session(session: str, value: ShareWrite) -> ShareView:
        return await owner.share_session(session, value)

    @app.get("/api/v1/sessions/{session}/shares/{share_id}")
    async def read_share(session: str, share_id: str) -> ShareView:
        return await owner.read_share(session, share_id)

    @app.get("/api/v1/export")
    async def export_bundle() -> ExportBundle:
        return await owner.export_bundle()

    @app.post("/api/v1/import")
    async def import_bundle(value: ExportBundle) -> ImportResult:
        return await owner.import_bundle(value)

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
    async def detach(session: str, identity: str, request: Request) -> dict[str, bool]:
        # The presented binding is the one being released. Another binding on the same session stays.
        if request.headers.get("x-amazme-attachment", "") != identity:
            raise BackendError("stale_client_binding")
        owner.release_attachment(session, identity)
        return {"detached": True}

    @app.post("/api/v1/rpc")
    async def rpc(value: RpcCall) -> dict[str, object]:
        return await handle_rpc(owner, value)

    @app.get("/api/v1/plugins")
    async def plugins() -> PluginList:
        return await owner.supervisor.call("GET", "/plugins", PluginList)

    @app.post("/api/v1/plugins")
    async def register_plugin(value: PluginDraft) -> PluginView:
        return await owner.register_plugin(value)

    @app.post("/api/v1/plugins/{plugin_id}/reload")
    async def reload_plugin(plugin_id: str, value: PluginReload) -> PluginView:
        return await owner.reload_plugin(plugin_id, value)

    @app.post("/api/v1/sessions/{session_id}/plugins/{plugin_id}/calls")
    async def call_plugin(session_id: str, plugin_id: str, value: PluginCallRequest) -> PluginCallView:
        return await owner.call_plugin(session_id, plugin_id, value)

    @app.get("/api/v1/sessions/{session_id}/search")
    async def search_session(session_id: str, q: str) -> SearchResults:
        return await owner.search_session(session_id, q)

    @app.get("/api/v1/sessions/{session_id}/usage")
    async def session_usage(session_id: str) -> UsageReport:
        return await owner.session_usage(session_id)

    @app.get("/api/v1/sessions/{session_id}/diagnostics")
    async def session_diagnostic(session_id: str) -> SessionDiagnostic:
        return await owner.session_diagnostic(session_id)

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

    @app.post("/control/file-writes/prepare")
    async def prepare_tool_write(value: PrepareFileWrite) -> PreparedFileWrite:
        return await owner.prepare_tool_write(value)

    @app.post("/control/recover")
    async def recover(value: Recovery) -> Health:
        return await owner.recover(value)

    @app.post("/control/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        if value != owner.fence:
            raise BackendError("stale_host_epoch")
        owner.closing = True
        await owner.stop_owned_supervisor()
        owner.stop.set()
        return owner.identity("stopping")

    @app.get("/", response_class=HTMLResponse)
    @app.get("/index.html", response_class=HTMLResponse)
    def page(response: Response) -> str:
        document, policy = boot_document(owner.identity(), owner.origin)
        response.headers["Content-Security-Policy"] = policy
        return document

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
