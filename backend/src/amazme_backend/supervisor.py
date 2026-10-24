"""Execution authority: durable instances, fenced epochs, and independent effect holds."""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
import secrets
import sqlite3
import stat
import threading
import time
from collections.abc import Callable, Generator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import httpx
import uvicorn
from fastapi import FastAPI
from pydantic import TypeAdapter

from .codemode_run import json_object, run_codemode
from .common import Peer, Profile, build_id, child_command, lock, private_write, unix_listener
from .contracts import (
    BackendError,
    CancelCode,
    CancelPlugin,
    Cleanup,
    ClosePlugin,
    CodeView,
    EffectHold,
    EpochHealth,
    ExecutionResource,
    FreezeSupervisor,
    HostFence,
    Identity,
    Lease,
    McpCall,
    McpCallEnvelope,
    McpCallRef,
    McpCallRequest,
    McpDecision,
    McpDecisionEnvelope,
    McpQuery,
    McpSession,
    McpState,
    McpView,
    OpenCode,
    OpenMcp,
    OpenPlugin,
    OpenRemote,
    OpenTerminal,
    PluginCallEnvelope,
    PluginCallView,
    PluginList,
    PluginResult,
    PluginTool,
    PluginView,
    ProcessLease,
    Recovery,
    ReloadPlugin,
    RemoteCallRequest,
    RemoteCallView,
    RemoteView,
    ResolveEffect,
    RetireSupervisor,
    RunTool,
    SshTarget,
    StopWorker,
    SubmitRemote,
    SupervisorHealth,
    TerminalInput,
    TerminalList,
    TerminalQuery,
    TerminalResize,
    TerminalSession,
    TerminalView,
    ToolLookup,
    ToolObservation,
    ToolResult,
    WorkerInfo,
    WorkerRequest,
    WorkerSpec,
)
from .faults import Faults
from .mcp_session import McpClient, catalog_schema_digest, mcp_digest
from .memories import session_workspace
from .native_execution import LocalPermit, LocalProcess, ProcessIdentity, reconcile, stop_tracked
from .native_services import ServiceProcess
from .plugin_run import (
    PluginClient,
    entry_digest,
    plugin_fingerprint,
    set_fingerprint,
    stored_config,
    validate_config,
)
from .processes import ProcessReservation, exited, wait_exited
from .pty_session import PtyClient
from .remote_session import RemoteClient
from .transport import app_factory
from .workspace_map import PRIMARY, load_grants, tool_path

MCP_UNRESOLVED_LIMIT = 512
MCP_ACTIVE_LIMIT = 16
MCP_IDENTITY_LIMIT = 4096
MCP_TERMINAL_WINDOW = 100


class ExecutionDB:
    """One SQL owner. Unsupported/corrupt stores are inspected before any writable open."""

    def __init__(self, path: Path, *, require_existing: bool = False):
        self.path = path
        self.require_existing = require_existing
        self.file_identity: tuple[int, int] | None = None
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="execution-sql")
        self.connection: sqlite3.Connection | None = None
        self.failed = ""
        self.closed = False

    def _invoke[T](self, operation: Callable[[sqlite3.Connection], T], write: bool) -> T:
        if self.failed and write:
            raise BackendError("execution_storage_blocked", self.failed, 503)
        try:
            if self.connection is None:
                if self.require_existing and (not self.path.is_file() or self.path.stat().st_size == 0):
                    raise BackendError("execution_store_missing", status=503)
                if self.path.exists():
                    probe = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True)
                    try:
                        version = probe.execute("PRAGMA user_version").fetchone()[0]
                        tables = probe.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                        if version != 3 and (self.require_existing or version != 0 or tables):
                            raise BackendError("unsupported_storage_format")
                        if version == 3:
                            required = {"control", "workers", "epochs", "scopes", "budgets", "recoveries", "resolutions",
                                        "terminals", "terminal_inputs", "mcp_servers", "mcp_calls"}
                            if not required.issubset({str(r[0]) for r in tables}):
                                raise BackendError("execution_storage_corrupt")
                            if probe.execute("SELECT count(*) FROM control WHERE id=1").fetchone()[0] != 1:
                                raise BackendError("execution_storage_corrupt")
                        if probe.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                            raise BackendError("execution_storage_corrupt")
                    finally:
                        probe.close()
                if self.require_existing:
                    self.connection = sqlite3.connect(self.path.resolve().as_uri() + "?mode=rw", uri=True, isolation_level=None)
                else:
                    self.connection = sqlite3.connect(self.path, isolation_level=None)
                file = self.path.stat()
                self.file_identity = file.st_dev, file.st_ino
                self.connection.row_factory = sqlite3.Row
                self.connection.execute("PRAGMA journal_mode=WAL")
                self.connection.execute("PRAGMA synchronous=FULL")
                self.connection.execute("PRAGMA foreign_keys=ON")
            db = self.connection
            file = self.path.stat()
            if (file.st_dev, file.st_ino) != self.file_identity or file.st_size == 0:
                self.failed = "execution_store_replaced"
                raise BackendError(self.failed, status=503)
            if not write:
                return operation(db)
            db.execute("BEGIN IMMEDIATE")
            try:
                result = operation(db)
                db.execute("UPDATE control SET revision=revision+1 WHERE id=1")
                db.execute("COMMIT")
                return result
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        except (sqlite3.Error, OSError) as error:
            self.failed = type(error).__name__
            raise BackendError("execution_storage_blocked", self.failed, 503) from error

    async def call[T](self, operation: Callable[[sqlite3.Connection], T], *, write: bool = False) -> T:
        return await asyncio.shield(asyncio.get_running_loop().run_in_executor(
            self.pool, self._invoke, operation, write))

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        def close() -> None:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
        await asyncio.get_running_loop().run_in_executor(self.pool, close)
        self.pool.shutdown(wait=True)


@contextlib.contextmanager
def retirement_proof(profile: Profile, worker: WorkerInfo) -> Generator[None]:
    """Keep exact lifetime inode AND session writer lock held through retirement commit."""
    lease = worker.process_lease
    if lease is None:
        raise BackendError("process_exit_unproven", status=503)
    expected = profile.path / "processes" / f"worker-{worker.worker_id}.lock"
    if (lease.instance_id, lease.role, lease.profile_path, lease.path) != (
        worker.worker_id, "worker", str(profile.path), str(expected)
    ):
        raise BackendError("process_lease_owner_mismatch", status=503)
    try:
        fd = os.open(lease.path, os.O_RDWR | os.O_NOFOLLOW)
    except OSError as error:
        raise BackendError("process_exit_unproven", status=503) from error
    try:
        info, current = os.fstat(fd), expected.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or not stat.S_ISREG(current.st_mode)
                or (info.st_dev, info.st_ino) != (lease.device, lease.inode)
                or (current.st_dev, current.st_ino) != (lease.device, lease.inode)
                or ProcessLease.model_validate_json(os.pread(fd, 8192, 0)) != lease):
            raise BackendError("process_lease_identity_mismatch", status=503)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with lock(profile.path / "sessions" / worker.session_id / "writer.lock"):
                yield
        except BlockingIOError as error:
            raise BackendError("worker_retirement_unproven", status=503) from error
    finally:
        os.close(fd)


class Supervisor:
    def __init__(self, profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None,
                 *, require_existing: bool = False):
        self.profile = profile
        self.build = build_id()
        self.pty_gate = Path(__file__).with_name("pty_gate.py").read_text()
        self.mcp_gate = Path(__file__).with_name("mcp_gate.py").read_text()
        self.terminals: dict[str, PtyClient] = {}
        self.terminal_processes: dict[str, ServiceProcess] = {}
        self.mcp_clients: dict[str, McpClient] = {}
        self.mcp_processes: dict[str, ServiceProcess] = {}
        self.plugin_clients: dict[str, PluginClient] = {}
        self.remote_clients: dict[str, RemoteClient] = {}
        self.remote_control = asyncio.Lock()
        self.code_cancels: dict[str, threading.Event] = {}
        self.code_cancel_ids: set[str] = set()
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
        self.jobs: dict[str, asyncio.Task[ToolResult]] = {}
        self.job_requests: dict[str, RunTool] = {}
        self.channels: dict[str, LocalProcess] = {}
        self.monitor_task: asyncio.Task[None] | None = None
        self.faults = Faults(profile.path, "supervisor", self.instance, enabled=profile.config.testing)

    def identity(self) -> Identity:
        return Identity(build_id=self.build, profile_id=self.profile.config.profile_id,
                        instance_id=self.instance, pid=os.getpid(), host_epoch=self.host_epoch,
                        role="supervisor", fingerprint=self.build,
                        state="blocked" if self.blocked or self.db.failed or not self.fence_ready else
                        "stopping" if self.draining else "frozen" if self.freeze_id else "ready")

    async def initialize(self) -> None:
        def init(db: sqlite3.Connection) -> sqlite3.Row:
            db.executescript("""
              BEGIN IMMEDIATE;
              CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,
                revision INTEGER NOT NULL,fence_ready INTEGER NOT NULL,freeze TEXT NOT NULL,
                blocked TEXT NOT NULL,owner TEXT NOT NULL);
              INSERT OR IGNORE INTO control VALUES(1,0,0,1,'','','');
              CREATE TABLE IF NOT EXISTS workers(worker TEXT PRIMARY KEY,session TEXT NOT NULL,
                info TEXT NOT NULL,retirement TEXT NOT NULL DEFAULT '',failure_counted INTEGER NOT NULL DEFAULT 0);
              CREATE INDEX IF NOT EXISTS worker_session ON workers(session);
              CREATE TABLE IF NOT EXISTS epochs(session TEXT NOT NULL,epoch INTEGER NOT NULL,worker TEXT NOT NULL,
                supervisor TEXT NOT NULL,build TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT NOT NULL DEFAULT '',
                PRIMARY KEY(session,epoch),FOREIGN KEY(worker) REFERENCES workers(worker));
              CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,session TEXT NOT NULL,epoch INTEGER NOT NULL,
                worker TEXT NOT NULL,supervisor TEXT NOT NULL,build TEXT NOT NULL,request TEXT NOT NULL,
                directory TEXT NOT NULL,lease TEXT NOT NULL,digest TEXT NOT NULL,phase TEXT NOT NULL,outcome TEXT NOT NULL DEFAULT 'pending',
                result TEXT NOT NULL DEFAULT '',clean INTEGER NOT NULL DEFAULT 0,effect TEXT NOT NULL,
                FOREIGN KEY(session,epoch) REFERENCES epochs(session,epoch));
              CREATE INDEX IF NOT EXISTS scope_epoch ON scopes(session,epoch);
              CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,call TEXT NOT NULL UNIQUE,
                session TEXT NOT NULL,payload TEXT NOT NULL,FOREIGN KEY(call) REFERENCES scopes(id));
              CREATE TABLE IF NOT EXISTS budgets(session TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS recoveries(id TEXT PRIMARY KEY,session TEXT NOT NULL,state TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS thaws(id TEXT PRIMARY KEY,build TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS terminals(id TEXT PRIMARY KEY,session TEXT NOT NULL,
                command TEXT NOT NULL,cols INTEGER NOT NULL,rows INTEGER NOT NULL,
                queued INTEGER NOT NULL DEFAULT 0,written INTEGER NOT NULL DEFAULT 0,
                exit_code INTEGER,output TEXT NOT NULL DEFAULT '',phase TEXT NOT NULL,workspace TEXT NOT NULL DEFAULT '');
              CREATE TABLE IF NOT EXISTS terminal_inputs(id TEXT PRIMARY KEY,terminal TEXT NOT NULL,
                data TEXT NOT NULL,accepted INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS mcp_servers(id TEXT PRIMARY KEY,session TEXT NOT NULL,
                command TEXT NOT NULL,phase TEXT NOT NULL,exit_code INTEGER,catalog TEXT NOT NULL DEFAULT '[]',
                clean INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY,server TEXT NOT NULL,name TEXT NOT NULL,
                arguments TEXT NOT NULL,digest TEXT NOT NULL,phase TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',
                decision_id TEXT NOT NULL DEFAULT '',decision TEXT NOT NULL DEFAULT '');
              CREATE TABLE IF NOT EXISTS remotes(id TEXT PRIMARY KEY,session TEXT NOT NULL,host TEXT NOT NULL,
                host_key TEXT NOT NULL,daemon_id TEXT NOT NULL,generation INTEGER NOT NULL,phase TEXT NOT NULL,
                target TEXT NOT NULL,transport TEXT NOT NULL DEFAULT '');
              CREATE TABLE IF NOT EXISTS remote_calls(id TEXT PRIMARY KEY,remote TEXT NOT NULL,command TEXT NOT NULL,
                phase TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
              CREATE TABLE IF NOT EXISTS code_runs(id TEXT PRIMARY KEY,session TEXT NOT NULL,source TEXT NOT NULL,
                phase TEXT NOT NULL,value TEXT NOT NULL DEFAULT '',committed INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS code_state(session TEXT PRIMARY KEY,document TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,name TEXT NOT NULL,
                capabilities TEXT NOT NULL,config TEXT NOT NULL,fingerprint TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS plugin_calls(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,
                session TEXT NOT NULL,text TEXT NOT NULL,phase TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
              PRAGMA user_version=3;
              COMMIT;
            """)
            for table, additions in {
                "plugins":{"session":"TEXT NOT NULL DEFAULT ''", "entry":"TEXT NOT NULL DEFAULT ''", "source_digest":"TEXT NOT NULL DEFAULT ''",
                           "tools":"TEXT NOT NULL DEFAULT '[]'", "load_id":"TEXT NOT NULL DEFAULT ''",
                           "phase":"TEXT NOT NULL DEFAULT 'disconnected'", "error":"TEXT NOT NULL DEFAULT ''",
                           "lease":"TEXT NOT NULL DEFAULT ''", "directory":"TEXT NOT NULL DEFAULT ''"},
                "plugin_calls":{"error":"TEXT NOT NULL DEFAULT ''", "fingerprint":"TEXT NOT NULL DEFAULT ''",
                                "cancel_requested":"INTEGER NOT NULL DEFAULT 0", "clean":"INTEGER NOT NULL DEFAULT 0"},
            }.items():
                present = {str(row[1]) for row in db.execute("PRAGMA table_info(" + table + ")")}
                for column, definition in additions.items():
                    if column not in present:
                        db.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition)
            db.execute("CREATE TABLE IF NOT EXISTS plugin_cancels(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,session TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS plugin_loads(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL DEFAULT '')")
            remote_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(remotes)")}
            if "transport" not in remote_columns:
                db.execute("ALTER TABLE remotes ADD COLUMN transport TEXT NOT NULL DEFAULT ''")
            if "endpoint" in remote_columns:
                db.execute("ALTER TABLE remotes RENAME COLUMN endpoint TO target")
            columns = {str(row[1]) for row in db.execute("PRAGMA table_info(terminals)")}
            if columns and "workspace" not in columns:
                db.execute("ALTER TABLE terminals ADD COLUMN workspace TEXT NOT NULL DEFAULT ''")
            for column, definition in {"lease": "TEXT NOT NULL DEFAULT ''", "directory": "TEXT NOT NULL DEFAULT ''",
                                       "permitted": "INTEGER NOT NULL DEFAULT 0", "clean": "INTEGER NOT NULL DEFAULT 0",
                                       "output_seq": "INTEGER NOT NULL DEFAULT 0"}.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE terminals ADD COLUMN {column} {definition}")
            for table, additions in {
                "mcp_servers": {"workspace": "TEXT NOT NULL DEFAULT 'primary'", "protocol_version": "TEXT NOT NULL DEFAULT ''",
                                "lease": "TEXT NOT NULL DEFAULT ''", "directory": "TEXT NOT NULL DEFAULT ''", "permitted": "INTEGER NOT NULL DEFAULT 0"},
                "mcp_calls": {"result_data": "TEXT", "is_error": "INTEGER NOT NULL DEFAULT 0",
                              "schema_digest": "TEXT NOT NULL DEFAULT ''", "origin": "TEXT NOT NULL DEFAULT 'manual'"},
            }.items():
                present = {str(row[1]) for row in db.execute(f"PRAGMA table_info({table})")}
                for column, definition in additions.items():
                    if column not in present:
                        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            return db.execute("SELECT * FROM control WHERE id=1").fetchone()
        old = await self.db.call(init)
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
                    if await self._unclean_epochs():
                        await self._reconcile_scopes("supervisor_restarted")
                    for worker in await self._workers():
                        if worker.state != "stopped":
                            try:
                                await self._retire_worker(worker, "recovery", failed=True)
                            except BackendError:
                                worker.state = "blocked"
                                await self._save_worker(worker)
                    await self._set_blocked("")
                except Exception as error:
                    await self._set_blocked(self._reason(error))
            await self.db.call(lambda db: db.execute("UPDATE control SET owner=? WHERE id=1", (self.instance,)), write=True)
        self.monitor_task = asyncio.create_task(self.monitor())

    @staticmethod
    def _reason(error: BaseException) -> str:
        return error.code if isinstance(error, BackendError) else type(error).__name__

    async def _set_blocked(self, reason: str) -> None:
        self.blocked = reason
        await self.db.call(lambda db: db.execute("UPDATE control SET blocked=? WHERE id=1", (reason,)), write=True)

    def check_host(self, fence: HostFence) -> None:
        if fence.build_id != self.build:
            raise BackendError("build_mismatch")
        if fence.host_epoch != self.host_epoch:
            raise BackendError("stale_host_epoch")

    def _admit(self, *, validation: bool = False) -> None:
        if self.db.failed or self.blocked:
            raise BackendError("execution_blocked", self.db.failed or self.blocked, 503)
        if self.draining:
            raise BackendError("supervisor_stopping", status=503)
        if not self.fence_ready:
            raise BackendError("worker_fence_pending", status=503)
        if self.freeze_id and not validation:
            raise BackendError("supervisor_frozen", status=503)

    async def _workers(self, session: str = "") -> list[WorkerInfo]:
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

    async def _save_worker(self, worker: WorkerInfo) -> None:
        await self.db.call(lambda db: self._put_worker(db, worker), write=True)

    async def worker_info(self, session: str) -> WorkerInfo | None:
        rows = await self._workers(session)
        active = [w for w in rows if w.state != "stopped"]
        return active[-1] if active else rows[-1] if rows else None

    async def _worker(self, worker_id: str) -> WorkerInfo:
        row = await self.db.call(lambda db: db.execute("SELECT info FROM workers WHERE worker=?", (worker_id,)).fetchone())
        if row is None:
            raise BackendError("stale_worker")
        return WorkerInfo.model_validate_json(str(row[0]))

    async def _peer_identity(self, worker: WorkerInfo, method: str = "GET", path: str = "/identity",
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
        for worker in await self._workers():
            if worker.state == "stopped":
                continue
            try:
                if worker.process_lease is None:
                    raise BackendError("process_exit_unproven", status=503)
                if (worker.state not in {"starting", "ready", "frozen"}
                        or exited(worker.process_lease)):
                    receipt = await self._retire_worker(worker, "recovery", failed=True)
                    if receipt.state != "clean" and not exited(worker.process_lease):
                        raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                    continue
                ack = await self._peer_identity(worker, "POST", "/fence", value)
                if ack.host_epoch != value.host_epoch:
                    raise BackendError("worker_fence_pending", status=503)
                if ack.state in {"stopping", "blocked"}:
                    receipt = await self._retire_worker(worker, "recovery", failed=True)
                    if receipt.state != "clean":
                        raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                    continue
                worker.host_epoch = ack.host_epoch
                if worker.state == "starting":
                    worker.state = "frozen" if ack.state == "frozen" else "ready" if ack.state == "ready" else "starting"
                worker.fingerprint = ack.fingerprint
                await self._save_worker(worker)
            except (httpx.TransportError, TimeoutError) as error:
                raise BackendError("worker_fence_pending", worker.worker_id, 503) from error
        await self.db.call(lambda db: db.execute("UPDATE control SET fence_ready=1 WHERE id=1"), write=True)
        self.fence_ready = True

    async def ensure_worker(self, value: WorkerSpec) -> WorkerInfo:
        async with self.control:
            self.check_host(value)
            self._admit(validation=value.purpose == "validation")
            live: list[WorkerInfo] = []
            for worker in await self._workers(value.session_id):
                if worker.state == "stopped":
                    continue
                if worker.purpose != value.purpose or worker.build_id != self.build:
                    raise BackendError("worker_identity_conflict")
                if worker.process_lease is None:
                    raise BackendError("process_exit_unproven", status=503)
                if exited(worker.process_lease):
                    receipt = await self._retire_worker(worker, "recovery", failed=True)
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
            attempts = await self.db.call(lambda db: db.execute(
                "SELECT attempts FROM budgets WHERE session=?", (value.session_id,)).fetchone())
            if attempts and int(attempts[0]) > 3:
                raise BackendError("worker_restart_budget_exhausted", status=503)
            if len([w for w in await self._workers() if w.state != "stopped"]) >= 8:
                raise BackendError("worker_capacity", status=429)
            if await self._unclean_epochs(value.session_id):
                raise BackendError("execution_cleanup_pending", status=503)
            directory = self.profile.path / "sessions" / value.session_id
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                with lock(directory / "writer.lock"):
                    pass
            except BlockingIOError as error:
                raise BackendError("worker_still_owns_session", status=503) from error
            instance = secrets.token_hex(16)
            with ProcessReservation(self.profile.path, "worker", instance) as reservation:
                worker = WorkerInfo(session_id=value.session_id, worker_id=instance, pid=0,
                                    socket=str(self.profile.worker_socket(value.session_id)), build_id=self.build,
                                    process_lease=reservation.lease, purpose=value.purpose, host_epoch=self.host_epoch,
                                    plugin_fingerprint=await self.plugin_set_fingerprint(value.session_id))
                # This row is committed before spawn; even death before PID publication leaves an exact lease.
                await self.db.call(lambda db: db.execute("INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
                    (instance, value.session_id, worker.model_dump_json())), write=True)
                self.heartbeats[instance] = time.monotonic()
                await self.faults.hit("worker_reserved", session_id=value.session_id)
                log_fd = os.open(directory / "worker.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    args = child_command("worker", "--profile", str(self.profile.path), "--session", value.session_id,
                                         "--instance", instance, "--lifetime-fd", str(reservation.fd))
                    if value.frozen or self.freeze_id or value.purpose == "validation":
                        args.append("--frozen")
                    if value.purpose == "validation":
                        args.append("--validation")
                    if any(w.storage_ready for w in await self._workers(value.session_id)):
                        args.append("--require-existing-store")
                    child = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.DEVNULL,
                        stdout=log_fd, stderr=log_fd, pass_fds=(reservation.fd,), start_new_session=True)
                    self.children[instance] = child
                    worker.pid = child.pid
                    await self._save_worker(worker)
                finally:
                    os.close(log_fd)
            self.heartbeats[instance] = time.monotonic()
            await self.faults.hit("worker_spawned", session_id=value.session_id)
            return worker

    async def validate_worker(self, value: WorkerRequest) -> WorkerInfo:
        worker = await self._worker(value.worker_id)
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
            self._admit(validation=worker.purpose == "validation")
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
            self._admit(validation=worker.purpose == "validation")
        if value.supervisor_id != self.instance:
            raise BackendError("stale_supervisor")
        row = await self.db.call(lambda db: db.execute("SELECT * FROM epochs WHERE session=? AND epoch=?",
            (value.session_id, value.execution_epoch)).fetchone())
        if row is None or (row["worker"], row["supervisor"], row["build"], row["state"]) != (
            value.worker_id, value.supervisor_id, value.build_id, "open"
        ):
            raise BackendError("execution_epoch_closed", status=503)

    async def _scope(self, call: str) -> sqlite3.Row | None:
        return await self.db.call(lambda db: db.execute("SELECT * FROM scopes WHERE id=?", (call,)).fetchone())

    async def _phase(self, call: str, phase: str) -> None:
        await self.db.call(lambda db: db.execute(
            "UPDATE scopes SET phase=? WHERE id=? AND outcome='pending'", (phase, call)), write=True)

    async def _holds(self) -> list[EffectHold]:
        return await self.db.call(lambda db: [EffectHold(
            call_id=str(r["id"]), session_id=str(r["session"]), request_id=str(r["request"]),
            reason="tool_outcome_unknown", resource_clean=bool(r["clean"]), reconciled=bool(r["resolved"]))
            for r in db.execute("SELECT s.*,EXISTS(SELECT 1 FROM resolutions r WHERE r.call=s.id) resolved "
                                "FROM scopes s WHERE effect='write' AND outcome='unknown' ORDER BY rowid")])

    async def _write_conflict(self, session: str) -> bool:
        return await self.db.call(lambda db: db.execute(
            "SELECT 1 FROM scopes s WHERE session=? AND effect='write' AND ((outcome='unknown' AND NOT EXISTS "
            "(SELECT 1 FROM resolutions r WHERE r.call=s.id)) OR (outcome='completed' AND clean=0)) LIMIT 1",
            (session,)).fetchone() is not None)

    async def execute(self, value: RunTool) -> ToolResult:
        channel: LocalProcess | None = None
        admitted = False
        try:
            async with self.control:
                await self.check_lease(value, admit=False)
                worker = await self._worker(value.worker_id)
                if worker.purpose == "validation":
                    raise BackendError("validation_tools_forbidden")
                digest = hashlib.sha256(value.model_dump_json().encode()).hexdigest()
                old = await self._scope(value.call_id)
                if old is not None:
                    if old["digest"] != digest:
                        raise BackendError("call_conflict")
                    if old["outcome"] == "completed":
                        return ToolResult.model_validate_json(str(old["result"]))
                    raise BackendError("tool_outcome_unknown")
                self._admit()
                if value.effect == "write" and await self._write_conflict(value.session_id):
                    raise BackendError("unknown_effect_conflict", status=503)
                workspace = session_workspace(self.profile.path, value.session_id)
                location = self.profile.config.workspace if workspace == PRIMARY else dict(load_grants(self.profile.path)).get(workspace)
                if location is None:
                    raise BackendError("workspace_not_found")
                root = Path(location)
                file = value.file
                if file is not None:
                    name, inner = tool_path(workspace, file.path)
                    if name == "grant" or not inner:
                        raise BackendError("invalid_workspace_path")
                    if name == PRIMARY:
                        root = Path(self.profile.config.workspace)
                    else:
                        location = dict(load_grants(self.profile.path)).get(name)
                        if location is None:
                            raise BackendError("workspace_not_found")
                        root = Path(location)
                    file = file.model_copy(update={"path": inner})
                instance = hashlib.sha256(value.call_id.encode()).hexdigest()[:32]
                directory = self.profile.path / "executions" / instance
                directory.mkdir(mode=0o700, parents=True, exist_ok=False)
                with ProcessReservation(self.profile.path, "execution", instance) as reservation:
                    await self.db.call(lambda db: db.execute(
                        "INSERT INTO scopes(id,session,epoch,worker,supervisor,build,request,directory,lease,digest,phase,effect) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,'registered',?)",
                        (value.call_id, value.session_id, value.execution_epoch, value.worker_id, self.instance,
                         self.build, value.request_id, str(directory), reservation.lease.model_dump_json(), digest,
                         value.effect)), write=True)
                    admitted = True
                    await self._hit("create_intent", value)
                    channel = await LocalProcess.start(self.profile.path, instance, directory, reservation)
                    self.channels[value.call_id] = channel
                await self._hit("registered", value)
                await self._hit("before_permit", value)
                await self.check_lease(value)
                await self._phase(value.call_id, "permit_intent")
                await channel.permit(LocalPermit(call_id=value.call_id, cwd=str(root), command=value.command,
                    timeout_seconds=value.timeout_seconds, file=file, expected_digest=value.expected_digest))
                await self._hit("permit_sent", value)
                await self._phase(value.call_id, "permitted")
                await self._hit("permitted", value)
            report = await channel.collect()
            if report.call_id != value.call_id or report.result is None:
                raise BackendError("tool_outcome_unknown")
            result = report.result
            async with self.control:
                def captured(db: sqlite3.Connection) -> None:
                    changed = db.execute("UPDATE scopes SET outcome='completed',phase='result',result=? "
                        "WHERE id=? AND worker=? AND epoch=? AND supervisor=? AND outcome='pending' AND clean=0",
                        (result.model_dump_json(), value.call_id, value.worker_id, value.execution_epoch,
                         self.instance)).rowcount
                    if changed != 1:
                        raise BackendError("tool_outcome_unknown")
                await self.db.call(captured, write=True)
                await self._hit("result", value)
                scope = await self._scope(value.call_id)
                assert scope is not None
                await self._clean_scope(scope)
            return result
        except BaseException:
            if admitted:
                await self.db.call(lambda db: db.execute("UPDATE scopes SET outcome='unknown' WHERE id=? "
                    "AND worker=? AND epoch=? AND supervisor=? AND outcome='pending'",
                    (value.call_id, value.worker_id, value.execution_epoch, self.instance)), write=True)
            raise
        finally:
            if channel is not None:
                await channel.close()
            self.channels.pop(value.call_id, None)

    async def _hit(self, point: str, value: RunTool) -> None:
        await self.faults.hit(point, session_id=value.session_id, request_id=value.request_id, call_id=value.call_id)

    async def run_tool(self, value: RunTool) -> ToolResult:
        # A disconnected HTTP waiter does not cancel the supervisor-owned operation.
        if value.call_id in self.job_requests and self.job_requests[value.call_id] != value:
            raise BackendError("call_conflict")
        if value.call_id not in self.jobs:
            if len(self.jobs) >= 16:
                raise BackendError("execution_capacity", status=429)
            task = asyncio.create_task(self.execute(value))
            self.jobs[value.call_id], self.job_requests[value.call_id] = task, value
            def finished(done: asyncio.Task[ToolResult]) -> None:
                if self.jobs.get(value.call_id) is done:
                    self.jobs.pop(value.call_id, None)
                    self.job_requests.pop(value.call_id, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        return await asyncio.shield(self.jobs[value.call_id])

    async def lookup_tool(self, value: ToolLookup) -> ToolObservation:
        await self.validate_worker(value)
        scope = await self._scope(value.call_id)
        if scope is None:
            return ToolObservation(call_id=value.call_id, state="not_found")
        if scope["session"] != value.session_id:
            raise BackendError("call_scope_mismatch")
        state: Literal["pending", "completed", "unknown"] = "completed" if scope["outcome"] == "completed" else "unknown" if scope["outcome"] == "unknown" else "pending"
        return ToolObservation(call_id=value.call_id, state=state,
                               result=ToolResult.model_validate_json(str(scope["result"])) if scope["result"] else None,
                               resource_clean=bool(scope["clean"]))

    async def resolve_effect(self, value: ResolveEffect) -> EffectHold:
        async with self.control:
            worker = await self.validate_worker(value)
            if worker.purpose == "validation":
                raise BackendError("validation_effects_forbidden")
            resolution = value.resolution
            if not resolution.evidence.strip():
                raise BackendError("effect_evidence_required")
            scope = await self._scope(resolution.call_id)
            if scope is None or scope["session"] != value.session_id or scope["effect"] != "write" or scope["outcome"] != "unknown":
                raise BackendError("effect_scope_mismatch")
            if not scope["clean"]:
                raise BackendError("execution_cleanup_pending", status=503)
            def resolve(db: sqlite3.Connection) -> None:
                old = db.execute("SELECT * FROM resolutions WHERE id=? OR call=?",
                                 (resolution.resolution_id, resolution.call_id)).fetchone()
                if old:
                    if old["payload"] != resolution.model_dump_json() or old["session"] != value.session_id:
                        raise BackendError("effect_resolution_conflict")
                else:
                    db.execute("INSERT INTO resolutions VALUES(?,?,?,?)", (resolution.resolution_id,
                               resolution.call_id, value.session_id, resolution.model_dump_json()))
            await self.db.call(resolve, write=True)
            return EffectHold(call_id=resolution.call_id, session_id=value.session_id, request_id=str(scope["request"]),
                              reason="tool_outcome_unknown", resource_clean=True, reconciled=True)

    async def _clean_scope(self, scope: sqlite3.Row) -> None:
        if scope["clean"]:
            return
        channel = self.channels.get(str(scope["id"]))
        if channel:
            await channel.close()
        directory = Path(str(scope["directory"]))
        lease = ProcessLease.model_validate_json(str(scope["lease"]))
        if not await reconcile(directory, lease, permitted=scope["phase"] != "registered"):
            raise BackendError("stop_unconfirmed", status=503)
        await self.faults.hit("cleanup_proven", session_id=str(scope["session"]), call_id=str(scope["id"]))
        await self.db.call(lambda db: db.execute("UPDATE scopes SET clean=1 WHERE id=?", (scope["id"],)), write=True)

    async def _cancel_jobs(self, session: str = "", epoch: int | None = None) -> None:
        tasks = [task for key, task in self.jobs.items() if task is not asyncio.current_task()
                 and (not session or self.job_requests[key].session_id == session)
                 and (epoch is None or self.job_requests[key].execution_epoch == epoch)]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _reconcile_scopes(self, reason: str) -> None:
        await self._cancel_jobs()
        await self.db.call(lambda db: db.execute("UPDATE scopes SET outcome='unknown' WHERE outcome='pending'"), write=True)
        for row in await self._unclean_epochs():
            await self._cleanup_epoch(row)

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
        await self._cancel_jobs(session, epoch)
        scopes = await self.db.call(lambda db: db.execute("SELECT * FROM scopes WHERE session=? AND epoch=?",
                                                          (session, epoch)).fetchall())
        ids = [str(scope["id"]) for scope in scopes]
        reason = ""
        for scope in scopes:
            try:
                await self._clean_scope(scope)
            except BackendError as error:
                reason = error.code
        result = Cleanup(session_id=session, execution_epoch=epoch, state="blocked" if reason else "clean",
                         resources=ids, reason=reason, proof_id=secrets.token_hex(16) if not reason else "")
        await self.db.call(lambda db: db.execute("UPDATE epochs SET state=?,receipt=? WHERE session=? AND epoch=?",
                          (result.state, result.model_dump_json(), session, epoch)), write=True)
        if result.state == "clean":
            await self.faults.hit("closed", session_id=session)
        return result

    async def _retire_worker(self, worker: WorkerInfo, reason: Literal["shutdown", "recovery", "update"], *, failed: bool = False) -> Cleanup:
        worker = await self._worker(worker.worker_id)
        if worker.state == "stopped":
            row = await self.db.call(lambda db: db.execute("SELECT retirement FROM workers WHERE worker=?",
                                                          (worker.worker_id,)).fetchone())
            return Cleanup.model_validate_json(str(row[0]))
        worker.state = "stopping"
        await self._save_worker(worker)
        receipt = Cleanup(session_id=worker.session_id, execution_epoch=worker.execution_epoch, state="clean",
                          resources=[], proof_id=secrets.token_hex(16))
        for row in await self._unclean_epochs(worker.session_id):
            if row["worker"] == worker.worker_id:
                receipt = await self._cleanup_epoch(row)
                if receipt.state != "clean":
                    worker.state = "blocked"
                    await self._save_worker(worker)
                    return receipt
        lease = worker.process_lease
        if lease is None:
            raise BackendError("process_exit_unproven", status=503)
        if not exited(lease):
            fence = HostFence(build_id=worker.build_id, host_epoch=self.host_epoch)
            try:
                ack = await self._peer_identity(worker, "POST", "/fence", fence)
                if ack.host_epoch != self.host_epoch:
                    raise BackendError("worker_fence_pending", status=503)
                stop = StopWorker(**fence.model_dump(), session_id=worker.session_id, worker_id=worker.worker_id,
                                  execution_epoch=worker.execution_epoch, reason=reason)
                await self._peer_identity(worker, "POST", "/stop", stop)
            except (httpx.TransportError, TimeoutError):
                pass
            await wait_exited(lease, timeout=3)
        with retirement_proof(self.profile, worker):
            worker.state = "stopped"
            def retired(db: sqlite3.Connection) -> None:
                row = db.execute("SELECT failure_counted FROM workers WHERE worker=?", (worker.worker_id,)).fetchone()
                if failed and not row[0]:
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
            worker = await self._worker(value.worker_id)
            if worker.session_id != value.session_id or worker.build_id != value.build_id:
                raise BackendError("stale_worker")
            if value.execution_epoch != worker.execution_epoch:
                raise BackendError("stale_execution_epoch")
            return await self._retire_worker(worker, value.reason)

    async def _refresh_workers(self) -> list[WorkerInfo]:
        workers = await self._workers()
        for worker in workers:
            if worker.state not in {"starting", "ready", "frozen"}:
                continue
            if worker.process_lease is None or exited(worker.process_lease):
                worker.state = "unknown"
            else:
                try:
                    identity = await self._peer_identity(worker)
                except (httpx.TransportError, TimeoutError, BackendError) as error:
                    if worker.state != "starting" or isinstance(error, BackendError):
                        worker.state = "unknown"
                else:
                    worker.fingerprint = identity.fingerprint
                    worker.host_epoch = identity.host_epoch
                    worker.state = "frozen" if identity.state == "frozen" else "ready" if identity.state == "ready" else "starting"
            previous = await self._worker(worker.worker_id)
            worker.storage_ready |= previous.storage_ready
            if worker != previous and not self.db.failed:
                await self._save_worker(worker)
        return workers

    async def health(self) -> SupervisorHealth:
        async with self.control:
            return await self._health()

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
            "ON s.session=e.session AND s.epoch=e.epoch ORDER BY s.rowid DESC LIMIT 200").fetchall())
        resources = [ExecutionResource.model_validate({
            "call_id": row["id"], "session_id": row["session"], "request_id": row["request"],
            "outcome": row["outcome"], "state": "exited" if row["clean"] else
            "stop_unconfirmed" if row["epoch_state"] == "blocked" else
            "stopping" if row["epoch_state"] == "closing" else
            "registered" if row["phase"] == "registered" else "running",
        }) for row in scopes]
        return SupervisorHealth(identity=self.identity(), registry_revision=revision, freeze_id=self.freeze_id,
            workers=workers, epochs=[EpochHealth(session_id=str(r["session"]), worker_id=str(r["worker"]),
                execution_epoch=int(r["epoch"]), state=str(r["state"]),
                cleanup=Cleanup.model_validate_json(str(r["receipt"])) if r["receipt"] else None) for r in rows],
            effects=await self._holds(), execution="native", resources=resources, session_errors=session_errors,
            terminals=[self._view(row) for row in terminals], mcp_servers=[self._mcp_view(row) for row in mcps], blocked=blocked)

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
            for worker in await self._workers(value.session_id):
                if worker.state != "stopped":
                    receipt = await self._retire_worker(worker, "recovery")
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
        for worker in await self._workers():
            if worker.state != "stopped":
                result = await self._retire_worker(worker, "update")
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
            await self._close_services()
            await self._reconcile_scopes("registered_processes_stopped")
            pending: list[WorkerInfo] = []
            for worker in await self._workers():
                if worker.state == "stopped":
                    continue
                worker.state = "stopping"
                await self._save_worker(worker)
                for row in await self._unclean_epochs(worker.session_id):
                    if row["worker"] == worker.worker_id:
                        receipt = await self._cleanup_epoch(row)
                        if receipt.state != "clean":
                            raise BackendError("execution_cleanup_pending", receipt.reason, 503)
                pending.append(await self._worker(worker.worker_id))
        for worker in pending:
            lease = worker.process_lease
            if lease is not None and not exited(lease):
                fence = HostFence(build_id=worker.build_id, host_epoch=self.host_epoch)
                try:
                    ack = await self._peer_identity(worker, "POST", "/fence", fence)
                    if ack.host_epoch != self.host_epoch:
                        raise BackendError("worker_fence_pending", status=503)
                    await self._peer_identity(worker, "POST", "/stop", StopWorker(
                        **fence.model_dump(), session_id=worker.session_id, worker_id=worker.worker_id,
                        execution_epoch=worker.execution_epoch, reason="update"))
                except (httpx.TransportError, TimeoutError, BackendError):
                    pass
                try:
                    await wait_exited(lease, timeout=5)
                except BackendError:
                    pass
        async with self.control:
            for worker in pending:
                current = await self._worker(worker.worker_id)
                if current.state == "stopped":
                    continue
                result = await self._retire_worker(current, "update")
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
                    for server_id, client in list(self.mcp_clients.items()):
                        row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
                        if row is None:
                            continue
                        try:
                            await self._sync_mcp(server_id)
                            if client.closed or client.exit_code is not None:
                                await self._close_mcp(row, interrupted=client.exit_code is None)
                        except (OSError, BackendError, ValueError):
                            await self._close_mcp(row, interrupted=True)
                    for terminal_id, client in list(self.terminals.items()):
                        row = await self._terminal_row(terminal_id)
                        if row is None:
                            continue
                        try:
                            await asyncio.to_thread(client.pump, 0)
                            if client.closed or client.exit_code is not None:
                                await self._close_terminal(row, interrupted=client.exit_code is None)
                            else:
                                await self._store_terminal(client, terminal_id, cols=int(row["cols"]), rows=int(row["rows"]), phase="running")
                        except (OSError, BackendError):
                            await self._close_terminal(row, interrupted=True)
                    for worker in await self._workers():
                        if worker.state == "stopped":
                            continue
                        dead = worker.process_lease is not None and exited(worker.process_lease)
                        last = self.heartbeats.setdefault(worker.worker_id, time.monotonic())
                        if dead or time.monotonic() - last > 15:
                            try:
                                await self._retire_worker(worker, "recovery", failed=True)
                            except Exception:
                                worker = await self._worker(worker.worker_id)
                                worker.state = "blocked"
                                await self._save_worker(worker)
            except Exception as error:
                self.blocked = self._reason(error)
                if not self.db.failed:
                    await self._set_blocked(self.blocked)

    def _mcp_view(self, row: sqlite3.Row) -> McpView:
        return McpView.model_validate({
            "server_id": row["id"], "session_id": row["session"], "workspace": row["workspace"],
            "command": row["command"], "protocol_version": row["protocol_version"],
            "phase": row["phase"] if row["phase"] in {"ready", "exited", "unknown"} else "unknown",
            "exit_code": row["exit_code"], "tools": json.loads(row["catalog"]), "clean": bool(row["clean"]),
        })

    def _mcp_call(self, row: sqlite3.Row) -> McpCall:
        return McpCall.model_validate({
            "call_id": row["id"], "server_id": row["server"], "name": row["name"],
            "phase": row["phase"], "result": row["result"], "digest": row["digest"],
            "arguments": json.loads(row["arguments"]), "is_error": bool(row["is_error"]),
            "result_data": json.loads(row["result_data"]) if row["result_data"] else None,
            "origin": row["origin"] if row["origin"] in {"manual", "model"} else "manual",
        })

    async def open_mcp(self, value: OpenMcp) -> McpView:
        async with self.control:
            self.check_host(value)
            old = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            if old is not None:
                workspace = value.workspace or str(old["workspace"])
                if (old["session"], old["command"], old["workspace"]) != (value.session_id, value.command, workspace):
                    raise BackendError("mcp_server_conflict")
                return self._mcp_view(old)
            self._admit()
            recorded = session_workspace(self.profile.path, value.session_id)
            workspace = value.workspace or recorded
            count = await self.db.call(lambda db: db.execute("SELECT count(*) FROM mcp_servers WHERE clean=0").fetchone()[0])
            if count >= 8:
                raise BackendError("mcp_server_capacity", status=429)
            blocked = await self.db.call(lambda db: db.execute(
                "SELECT 1 FROM mcp_servers WHERE session=? AND phase='unknown' AND clean=0", (value.session_id,)).fetchone())
            if blocked:
                raise BackendError("execution_cleanup_pending", status=503)
            location = self.profile.config.workspace if workspace == PRIMARY else dict(load_grants(self.profile.path)).get(workspace)
            if location is None:
                raise BackendError("workspace_not_found")
            instance = hashlib.sha256(("mcp:" + value.server_id).encode()).hexdigest()[:32]
            directory = self.profile.path / "executions" / instance
            directory.mkdir(mode=0o700, parents=True, exist_ok=False)
            try:
                with ProcessReservation(self.profile.path, "execution", instance) as reservation:
                    await self.db.call(lambda db: db.execute(
                        "INSERT INTO mcp_servers(id,session,command,phase,workspace,lease,directory) VALUES(?,?,?,'unknown',?,?,?)",
                        (value.server_id, value.session_id, value.command, workspace, reservation.lease.model_dump_json(), str(directory))), write=True)
                    process = await ServiceProcess.start(self.profile.path, instance, directory, reservation, "mcp")
                    self.mcp_processes[value.server_id] = process
                client = McpClient(process.sock)
                self.mcp_clients[value.server_id] = client
                await self.db.call(lambda db: db.execute("UPDATE mcp_servers SET permitted=1 WHERE id=?", (value.server_id,)), write=True)
                await asyncio.to_thread(client.permit, value.command, os.getuid(), os.getgid(), location)
                catalog = json.dumps([tool.model_dump() for tool in client.tools], ensure_ascii=False)
                busy = await self.db.call(lambda db: db.execute(
                    "SELECT 1 FROM mcp_calls WHERE server=? AND phase IN ('waiting_approval','running')",
                    (value.server_id,)).fetchone())
                if busy:
                    raise BackendError("mcp_tool_identity")
                await self.db.call(lambda db: db.execute("UPDATE mcp_servers SET phase='ready',catalog=?,protocol_version=? WHERE id=?",
                    (catalog, client.protocol_version, value.server_id)), write=True)
            except BaseException:
                row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
                if row is not None:
                    await self._close_mcp(row, interrupted=True)
                raise
            row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            assert row is not None
            return self._mcp_view(row)

    async def _sync_mcp(self, server_id: str) -> None:
        client = self.mcp_clients.get(server_id)
        if client is None:
            return
        await asyncio.to_thread(client.pump, 0)
        for call_id, result in list(client.results.items()):
            await self.db.call(lambda db: db.execute(
                "UPDATE mcp_calls SET phase='done',result=?,result_data=?,is_error=? WHERE id=? AND server=? AND phase='running'",
                (result.text, json.dumps(result.data, ensure_ascii=False), int(result.is_error), call_id, server_id)), write=True)
            client.results.pop(call_id, None)
        for call_id in list(client.conflicts):
            await self.db.call(lambda db: db.execute("UPDATE mcp_calls SET phase='conflict' WHERE id=? AND server=? AND phase='running'",
                                                    (call_id, server_id)), write=True)
            client.conflicts.discard(call_id)
        for call_id in list(client.busy):
            await self.db.call(lambda db: db.execute(
                "UPDATE mcp_calls SET phase='waiting_approval',decision_id='',decision='' "
                "WHERE id=? AND server=? AND phase='running'",
                (call_id, server_id)), write=True)
            client.busy.discard(call_id)
        if client.ready and not client.catalog_failed:
            catalog = json.dumps([tool.model_dump() for tool in client.tools], ensure_ascii=False)
            await self.db.call(lambda db: db.execute(
                "UPDATE mcp_servers SET catalog=? WHERE id=? AND phase='ready' AND catalog!=?",
                (catalog, server_id, catalog)), write=True)

    async def mcp_state(self, value: McpSession) -> McpState:
        async with self.control:
            self.check_host(value)
            servers = await self.db.call(lambda db: db.execute(
                "SELECT * FROM mcp_servers WHERE session=? ORDER BY clean,rowid DESC LIMIT 100", (value.session_id,)).fetchall())
            for server in servers:
                server_id = str(server["id"])
                client = self.mcp_clients.get(server_id)
                try:
                    await self._sync_mcp(server_id)
                    if client and (client.closed or client.exit_code is not None):
                        await self._close_mcp(server, interrupted=client.exit_code is None)
                except (OSError, BackendError, ValueError):
                    await self._close_mcp(server, interrupted=True)
            servers = await self.db.call(lambda db: db.execute(
                "SELECT * FROM mcp_servers WHERE session=? ORDER BY clean,rowid DESC LIMIT 100", (value.session_id,)).fetchall())
            calls = await self._listed_calls(value.session_id)
            return McpState(servers=[self._mcp_view(row) for row in servers], calls=[self._mcp_call(row) for row in calls])

    async def _listed_calls(self, session_id: str) -> list[sqlite3.Row]:
        """Non-terminal calls stay visible. Terminal history keeps its newest window and is never deleted here."""
        def query(db: sqlite3.Connection) -> tuple[list[sqlite3.Row], list[sqlite3.Row]]:
            open_rows = db.execute(
                "SELECT c.* FROM mcp_calls c JOIN mcp_servers s ON s.id=c.server "
                "WHERE s.session=? AND c.phase NOT IN ('done','denied') ORDER BY c.rowid", (session_id,)).fetchall()
            recent = db.execute(
                "SELECT c.* FROM mcp_calls c JOIN mcp_servers s ON s.id=c.server "
                "WHERE s.session=? AND c.phase IN ('done','denied') ORDER BY c.rowid DESC LIMIT ?",
                (session_id, MCP_TERMINAL_WINDOW)).fetchall()
            return list(open_rows), list(recent)
        open_rows, recent = await self.db.call(query)
        seen: set[str] = set()
        merged: list[sqlite3.Row] = []
        for row in [*open_rows, *recent]:
            call_id = str(row["id"])
            if call_id in seen:
                continue
            seen.add(call_id)
            merged.append(row)
        return merged

    async def request_mcp_call(self, session_id: str, server_id: str, value: McpCallRequest, fence: HostFence) -> McpCall:
        async with self.control:
            self.check_host(fence)
            self._admit()
            server = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            if server is None or server["session"] != session_id:
                raise BackendError("mcp_not_found", status=404)
            digest = mcp_digest(server_id, str(server["command"]), str(server["workspace"]), self.build, value.name, value.arguments)
            existing = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (value.call_id,)).fetchone())
            if existing is not None:
                stored_origin = str(existing["origin"] or "manual")
                if (existing["server"] != server_id or existing["digest"] != digest
                        or stored_origin != value.origin or str(existing["schema_digest"] or "") != value.schema_digest):
                    raise BackendError("mcp_call_conflict")
                if existing["phase"] == "running":
                    await self._sync_mcp(server_id)
                    existing = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (value.call_id,)).fetchone())
                    assert existing is not None
                return self._mcp_call(existing)
            await self._sync_mcp(server_id)
            server = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            assert server is not None
            client = self.mcp_clients.get(server_id)
            if client is not None and client.catalog_failed:
                raise BackendError("mcp_catalog_stale", status=503)
            if server["phase"] != "ready":
                raise BackendError("mcp_not_ready")
            if value.name not in {item["name"] for item in json.loads(server["catalog"])}:
                raise BackendError("mcp_tool_unknown")
            counts = await self.db.call(lambda db: db.execute(
                "SELECT count(*), sum(phase IN ('waiting_approval','running','unknown')), "
                "sum(phase IN ('waiting_approval','running')) FROM mcp_calls").fetchone())
            total, unresolved, active = int(counts[0] or 0), int(counts[1] or 0), int(counts[2] or 0)
            if total >= MCP_IDENTITY_LIMIT or unresolved >= MCP_UNRESOLVED_LIMIT or active >= MCP_ACTIVE_LIMIT:
                raise BackendError("mcp_call_capacity", status=429)
            await self.db.call(lambda db: db.execute(
                "INSERT INTO mcp_calls(id,server,name,arguments,digest,phase,schema_digest,origin) "
                "VALUES(?,?,?,?,?,'waiting_approval',?,?)",
                (value.call_id, server_id, value.name, json.dumps(value.arguments, sort_keys=True, ensure_ascii=False),
                 digest, value.schema_digest, value.origin)), write=True)
            row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (value.call_id,)).fetchone())
            assert row is not None
            return self._mcp_call(row)

    async def decide_mcp_call(self, session_id: str, server_id: str, call_id: str, value: McpDecision, fence: HostFence) -> McpCall:
        async with self.control:
            self.check_host(fence)
            self._admit()
            row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
            server = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            if row is None or row["server"] != server_id or server is None or server["session"] != session_id:
                raise BackendError("mcp_call_not_found", status=404)
            if row["digest"] != value.digest:
                raise BackendError("mcp_call_conflict")
            await self._sync_mcp(server_id)
            server = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            assert server is not None
            client = self.mcp_clients.get(server_id)
            decision = json.dumps({"approve": value.approve, "digest": value.digest})
            if row["decision_id"]:
                if row["decision_id"] != value.decision_id or (row["phase"] != "conflict" and row["decision"] != decision):
                    raise BackendError("mcp_decision_conflict")
                return self._mcp_call(row)
            if row["phase"] != "waiting_approval":
                raise BackendError("mcp_call_conflict")
            if value.approve and client is not None and client.catalog_failed:
                raise BackendError("mcp_catalog_stale", status=503)
            pinned = str(row["schema_digest"] or "")
            if value.approve and pinned and catalog_schema_digest(str(server["catalog"]), str(row["name"])) != pinned:
                refusal = json.dumps({"approve": False, "digest": value.digest, "reason": "schema"})
                await self.db.call(lambda db: db.execute(
                    "UPDATE mcp_calls SET phase='conflict',decision_id=?,decision=? WHERE id=? AND phase='waiting_approval'",
                    (value.decision_id, refusal, call_id)), write=True)
                current = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
                assert current is not None
                return self._mcp_call(current)
            if value.approve:
                busy = await self.db.call(lambda db: db.execute(
                    "SELECT 1 FROM mcp_calls WHERE server=? AND phase IN ('running','unknown')", (server_id,)).fetchone())
                if busy:
                    raise BackendError("mcp_call_pending")
                if server["phase"] != "ready" or server_id not in self.mcp_clients:
                    raise BackendError("mcp_not_ready")
            # Durable intent precedes the first byte to a third-party service.
            await self.db.call(lambda db: db.execute(
                "UPDATE mcp_calls SET phase=?,decision_id=?,decision=? WHERE id=?",
                ("running" if value.approve else "denied", value.decision_id, decision, call_id)), write=True)
            if value.approve:
                client = self.mcp_clients[server_id]
                try:
                    await asyncio.to_thread(client.call, call_id, str(row["name"]), json.loads(row["arguments"]))
                    await asyncio.to_thread(client.pump, .1)
                    await self._sync_mcp(server_id)
                except (OSError, BackendError, ValueError):
                    await self._close_mcp(server, interrupted=True)
            current = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
            assert current is not None
            if value.approve and current["phase"] == "waiting_approval" and not current["decision_id"]:
                raise BackendError("mcp_catalog_stale", status=503)
            return self._mcp_call(current)

    async def _close_mcp(self, row: sqlite3.Row, *, interrupted: bool = False) -> McpView:
        server_id = str(row["id"])
        process, client = self.mcp_processes.get(server_id), self.mcp_clients.get(server_id)
        if client:
            with contextlib.suppress(OSError, BackendError, ValueError):
                await self._sync_mcp(server_id)
        if process:
            await process.close()
        self.mcp_processes.pop(server_id, None)
        self.mcp_clients.pop(server_id, None)
        clean = bool(row["clean"])
        if not clean and row["lease"]:
            clean = await reconcile(Path(row["directory"]), ProcessLease.model_validate_json(row["lease"]), permitted=bool(row["permitted"]))
        phase = "exited" if clean and not interrupted else "unknown"
        def closed(db: sqlite3.Connection) -> None:
            db.execute("UPDATE mcp_servers SET phase=?,clean=?,exit_code=coalesce(?,exit_code) WHERE id=?",
                       (phase, int(clean), client.exit_code if client else None, server_id))
            db.execute("UPDATE mcp_calls SET phase=CASE WHEN phase='waiting_approval' THEN 'denied' ELSE 'unknown' END "
                       "WHERE server=? AND phase IN ('waiting_approval','running')", (server_id,))
        await self.db.call(closed, write=True)
        current = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
        assert current is not None
        return self._mcp_view(current)

    async def _close_mcps(self, *, require_clean: bool = True) -> None:
        rows = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE clean=0").fetchall())
        results = await asyncio.gather(*(self._close_mcp(row,
            interrupted=str(row["id"]) not in self.mcp_processes) for row in rows), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        if require_clean and any(isinstance(result, McpView) and not result.clean for result in results):
            raise BackendError("mcp_stop_unconfirmed", status=503)

    async def _stop_remote_transport(self, row: sqlite3.Row) -> bool:
        raw = str(row["transport"])
        leases = TypeAdapter(list[ProcessIdentity]).validate_json(raw) if raw else []
        stopped = await asyncio.to_thread(stop_tracked, leases)
        if stopped:
            await self.db.call(lambda db: db.execute("UPDATE remotes SET transport='' WHERE id=?", (row["id"],)), write=True)
        return stopped

    async def _close_remotes(self, *, require_clean: bool = True) -> None:
        async with self.remote_control:
            rows = await self.db.call(lambda db: db.execute("SELECT * FROM remotes").fetchall())
            errors: list[Exception] = []
            for row in rows:
                try:
                    await self.disconnect_remote_id(str(row["id"]))
                    if not await self._stop_remote_transport(row) and require_clean:
                        errors.append(BackendError("ssh_transport_stop_unconfirmed", status=503))
                except Exception as exc:
                    errors.append(exc)
            if errors:
                raise errors[0]

    async def _close_services(self, *, require_clean: bool = True) -> None:
        results = await asyncio.gather(self._close_terminals(require_clean=require_clean),
                                       self._close_mcps(require_clean=require_clean),
                                       self._close_plugins(require_clean=require_clean),
                                       self._close_remotes(require_clean=require_clean), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def lookup_mcp_call(self, value: McpCallRef) -> McpCall:
        async with self.control:
            self.check_host(value)
            row = await self._owned_call(value.session_id, value.server_id, value.call_id)
            if row["phase"] == "running":
                await self._sync_mcp(value.server_id)
                row = await self._owned_call(value.session_id, value.server_id, value.call_id)
            return self._mcp_call(row)

    async def _owned_call(self, session_id: str, server_id: str, call_id: str) -> sqlite3.Row:
        row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
        server = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
        if row is None or server is None or row["server"] != server_id or server["session"] != session_id:
            raise BackendError("mcp_call_not_found", status=404)
        return row

    async def cancel_mcp_call(self, value: McpCallRef) -> McpCall:
        """Cancel one call. Waiting calls are denied before any send. A running service is not closed."""
        async with self.control:
            self.check_host(value)
            row = await self._owned_call(value.session_id, value.server_id, value.call_id)
            phase = str(row["phase"])
            if phase in {"done", "denied", "unknown", "conflict"}:
                return self._mcp_call(row)
            if phase == "waiting_approval":
                decision = json.dumps({"approve": False, "digest": row["digest"], "reason": "cancelled"})
                await self.db.call(lambda db: db.execute(
                    "UPDATE mcp_calls SET phase='denied',decision_id=?,decision=? WHERE id=? AND phase='waiting_approval'",
                    ("cancel:" + value.call_id, decision, value.call_id)), write=True)
                return self._mcp_call(await self._owned_call(value.session_id, value.server_id, value.call_id))
            if phase == "running":
                client = self.mcp_clients.get(value.server_id)
                if client is not None:
                    with contextlib.suppress(OSError, BackendError, ValueError):
                        await asyncio.to_thread(client.cancel_call, value.call_id)
                        await asyncio.to_thread(client.pump, 0.2)
                        await self._sync_mcp(value.server_id)
                current = await self._owned_call(value.session_id, value.server_id, value.call_id)
                if current["phase"] == "running":
                    await self.db.call(lambda db: db.execute(
                        "UPDATE mcp_calls SET phase='unknown' WHERE id=? AND phase='running'", (value.call_id,)), write=True)
                    current = await self._owned_call(value.session_id, value.server_id, value.call_id)
                return self._mcp_call(current)
            raise BackendError("mcp_call_conflict")

    async def cancel_mcp(self, value: McpQuery) -> McpView:
        async with self.control:
            self.check_host(value)
            row = await self.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            if row is None or row["session"] != value.session_id:
                raise BackendError("mcp_not_found", status=404)
            client = self.mcp_clients.get(value.server_id)
            if client:
                await self._sync_mcp(value.server_id)
                await self.db.call(lambda db: db.execute("UPDATE mcp_calls SET phase='unknown' WHERE server=? AND phase='running'",
                                                        (value.server_id,)), write=True)
                with contextlib.suppress(OSError, BackendError, ValueError):
                    await asyncio.to_thread(client.cancel)
            return await self._close_mcp(row)

    async def run_code(self, value: OpenCode) -> CodeView:
        self.check_host(value)
        existing = await self.db.call(lambda db: db.execute("SELECT * FROM code_runs WHERE id=?", (value.run_id,)).fetchone())
        if existing is not None:
            if existing["session"] != value.session_id or existing["source"] != value.source:
                raise BackendError("codemode_conflict")
            return await self._code_view_with_state(existing)
        self._admit()
        await self._code_blocked(value.session_id)
        await self.db.call(lambda db: db.execute(
            "INSERT INTO code_runs(id,session,source,phase) VALUES(?,?,?,'unknown')",
            (value.run_id, value.session_id, value.source)), write=True)
        saved = await self.db.call(lambda db: db.execute(
            "SELECT document FROM code_state WHERE session=?", (value.session_id,)).fetchone())
        loaded: object = json.loads(str(saved["document"])) if saved else {}
        state = json_object(loaded)
        event = threading.Event()
        if value.run_id in self.code_cancel_ids:
            event.set()
        self.code_cancels[value.run_id] = event
        try:
            outcome = await asyncio.to_thread(run_codemode, value.source, state, cancel=event)
        finally:
            self.code_cancels.pop(value.run_id, None)
        kept = outcome.state
        if outcome.phase == "success" and kept is not None:
            document = json.dumps(kept, ensure_ascii=False, sort_keys=True)
            payload = json.dumps(outcome.value, ensure_ascii=False) if outcome.value is not None else "null"

            def commit(db: sqlite3.Connection) -> None:
                db.execute("UPDATE code_runs SET phase='success',value=?,committed=1 WHERE id=?", (payload, value.run_id))
                db.execute("INSERT INTO code_state(session,document) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET document=excluded.document",
                           (value.session_id, document))

            await self.db.call(commit, write=True)
        else:
            await self.db.call(lambda db: db.execute(
                "UPDATE code_runs SET phase=?,committed=0 WHERE id=?", (outcome.phase, value.run_id)), write=True)
        current = await self.db.call(lambda db: db.execute("SELECT * FROM code_runs WHERE id=?", (value.run_id,)).fetchone())
        assert current is not None
        return await self._code_view_with_state(current)

    async def _code_blocked(self, session_id: str) -> None:
        blocked = await self.db.call(lambda db: db.execute(
            "SELECT 1 FROM code_runs WHERE session=? AND phase='unknown'", (session_id,)).fetchone())
        if blocked is not None:
            raise BackendError("execution_cleanup_pending", status=503)

    async def _code_view_with_state(self, row: sqlite3.Row) -> CodeView:
        phase = str(row["phase"])
        if phase not in {"success", "failed", "cancelled", "unknown", "conflict"}:
            phase = "unknown"
        state = ""
        if int(row["committed"]):
            saved = await self.db.call(lambda db: db.execute(
                "SELECT document FROM code_state WHERE session=?", (row["session"],)).fetchone())
            state = "" if saved is None else str(saved["document"])
        return CodeView(run_id=str(row["id"]), phase=phase, value=str(row["value"]), state=state)  # type: ignore[arg-type]

    async def cancel_code(self, value: CancelCode) -> CodeView:
        self.check_host(value)
        self.code_cancel_ids.add(value.run_id)
        event = self.code_cancels.get(value.run_id)
        if event is not None:
            event.set()
        for _ in range(50):
            row = await self.db.call(lambda db: db.execute(
                "SELECT * FROM code_runs WHERE id=? AND session=?", (value.run_id, value.session_id)).fetchone())
            if row is None:
                await asyncio.sleep(0.05)
                continue
            event = self.code_cancels.get(value.run_id)
            if event is not None and not event.is_set():
                event.set()
            if str(row["phase"]) != "unknown":
                return await self._code_view_with_state(row)
            await asyncio.sleep(0.05)
        missing = await self.db.call(lambda db: db.execute(
            "SELECT * FROM code_runs WHERE id=? AND session=?", (value.run_id, value.session_id)).fetchone())
        if missing is None:
            raise BackendError("codemode_not_found", status=404)
        return await self._code_view_with_state(missing)

    async def plugin_set_fingerprint(self, session_id: str = "") -> str:
        rows = await self.db.call(lambda db: db.execute("SELECT fingerprint FROM plugins WHERE session=?", (session_id,)).fetchall())
        return set_fingerprint([str(row[0]) for row in rows])

    def _plugin_view(self, row: sqlite3.Row) -> PluginView:
        client = self.plugin_clients.get(str(row["id"]))
        phase = str(row["phase"])
        if phase == "loading" and client is None:
            phase = "unknown"
        if phase == "ready" and (client is None or not client.ready or client.process.process.returncode is not None):
            phase = "disconnected"
        tools = TypeAdapter(list[PluginTool]).validate_json(str(row["tools"]))
        return PluginView.model_validate({"plugin_id":str(row["id"]), "session_id":str(row["session"]), "name":str(row["name"]),
            "capabilities":[tool.name for tool in tools], "tools":[tool.model_dump() for tool in tools],
            "config":stored_config(json.loads(str(row["config"]))), "fingerprint":str(row["fingerprint"]),
            "entry":str(row["entry"]), "phase":phase, "load_id":str(row["load_id"]), "error":str(row["error"])})

    async def list_plugins(self, session_id: str = "") -> PluginList:
        rows = await self.db.call(lambda db: db.execute("SELECT * FROM plugins" + (" WHERE session=?" if session_id else "") + " ORDER BY name",
            (session_id,) if session_id else ()).fetchall())
        return PluginList(plugins=[self._plugin_view(row) for row in rows])

    async def _live_plugin_mismatch(self, expected: str, session_id: str) -> bool:
        for worker in await self._workers(session_id):
            if worker.state == "stopped" or worker.process_lease is None or exited(worker.process_lease):
                continue
            if worker.plugin_fingerprint != expected:
                return True
        return False

    async def _plugin_change_blocked(self, upcoming: str, session_id: str) -> None:
        if await self._live_plugin_mismatch(upcoming, session_id):
            raise BackendError("plugin_reload_blocked", status=409)
        plugin_ids = {view.plugin_id for view in (await self.list_plugins(session_id)).plugins}
        if any(client.pending for plugin_id, client in self.plugin_clients.items() if plugin_id in plugin_ids):
            raise BackendError("plugin_reload_blocked", status=409)

    async def _plugin_fingerprint_ready(self, expected: str, session_id: str) -> None:
        if await self._live_plugin_mismatch(expected, session_id):
            raise BackendError("plugin_fingerprint_mismatch", status=409)

    async def _close_plugin(self, row: sqlite3.Row) -> bool:
        plugin_id = str(row["id"])
        client = self.plugin_clients.get(plugin_id)
        if client is not None:
            await client.close()
        clean = not str(row["lease"]) or await reconcile(Path(str(row["directory"])),
            ProcessLease.model_validate_json(str(row["lease"])), permitted=True)
        if clean:
            self.plugin_clients.pop(plugin_id, None)
            await self.db.call(lambda db: db.execute("UPDATE plugin_calls SET clean=1 WHERE plugin=? AND fingerprint=? AND phase='unknown'",
                (plugin_id, str(row["fingerprint"]))), write=True)
        await self.db.call(lambda db: db.execute("UPDATE plugins SET phase=? WHERE id=?",
            ("disconnected" if clean else "unknown", plugin_id)), write=True)
        return clean

    async def _close_plugins(self, *, require_clean: bool = True) -> None:
        rows = await self.db.call(lambda db: db.execute("SELECT * FROM plugins").fetchall())
        results = await asyncio.gather(*(self._close_plugin(row) for row in rows), return_exceptions=True)
        if require_clean and any(result is not True for result in results):
            raise BackendError("execution_cleanup_pending", status=503)

    async def _load_plugin(self, plugin_id: str, load_id: str) -> PluginView:
        row = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (plugin_id,)).fetchone())
        assert row is not None
        instance = hashlib.sha256(("plugin:" + plugin_id + ":" + load_id).encode()).hexdigest()[:32]
        directory = self.profile.path / "executions" / instance
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        phase, error = "unknown", "plugin_load_interrupted"
        tools: list[PluginTool] = []
        try:
            with ProcessReservation(self.profile.path, "execution", instance) as reservation:
                await self.db.call(lambda db: db.execute("UPDATE plugins SET lease=?,directory=? WHERE id=?",
                    (reservation.lease.model_dump_json(), str(directory), plugin_id)), write=True)
                process = await ServiceProcess.start(self.profile.path, instance, directory, reservation, "plugin")
            client = PluginClient(process)
            self.plugin_clients[plugin_id] = client
            workspace = session_workspace(self.profile.path, str(row["session"]))
            location = self.profile.config.workspace if workspace == PRIMARY else dict(load_grants(self.profile.path)).get(workspace)
            if location is None:
                raise BackendError("workspace_not_found")
            reply = await client.load(str(row["entry"]), str(row["source_digest"]), stored_config(json.loads(str(row["config"]))), str(row["session"]), str(location))
            phase, error, tools = reply.phase, reply.error, reply.tools
        except (OSError, ValueError, BackendError, TimeoutError) as failure:
            error = failure.code if isinstance(failure, BackendError) else type(failure).__name__
        if phase != "ready":
            current = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (plugin_id,)).fetchone())
            assert current is not None
            if not await self._close_plugin(current):
                phase = "unknown"
        await self.db.call(lambda db: db.execute("UPDATE plugins SET phase=?,error=?,tools=?,capabilities=? WHERE id=?",
            (phase, error, json.dumps([tool.model_dump() for tool in tools]), json.dumps([tool.name for tool in tools]), plugin_id)), write=True)
        current = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (plugin_id,)).fetchone())
        assert current is not None
        view = self._plugin_view(current)
        await self.db.call(lambda db: db.execute("UPDATE plugin_loads SET result=? WHERE id=?",
            (view.model_dump_json(), load_id)), write=True)
        return view

    async def register_plugin(self, value: OpenPlugin) -> PluginView:
        async with self.control:
            self.check_host(value)
            self._admit()
            config = validate_config(value.config)
            load_id = "register:" + value.plugin_id
            identity = hashlib.sha256(json.dumps(value.model_dump(mode="json", exclude={"host_epoch", "build_id"}), sort_keys=True).encode()).hexdigest()
            existing = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if existing is not None:
                previous = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_loads WHERE id=?", (load_id,)).fetchone())
                if previous is None or str(previous["digest"]) != identity:
                    raise BackendError("plugin_conflict")
                return self._plugin_view(existing)
            if len(self.plugin_clients) >= 8:
                raise BackendError("plugin_capacity", status=429)
            entry, source_digest = entry_digest(value.entry)
            fingerprint = plugin_fingerprint(value.plugin_id, value.name, config, entry=entry, source_digest=source_digest, load_id=load_id)
            session_workspace(self.profile.path, value.session_id)
            current = [str(row[0]) for row in await self.db.call(lambda db: db.execute("SELECT fingerprint FROM plugins WHERE session=?", (value.session_id,)).fetchall())]
            await self._plugin_change_blocked(set_fingerprint([*current, fingerprint]), value.session_id)
            def accepted(db: sqlite3.Connection) -> None:
                db.execute("INSERT INTO plugins(id,name,session,capabilities,config,fingerprint,entry,source_digest,load_id,phase) VALUES(?,?,?,'[]',?,?,?,?,?,'loading')",
                    (value.plugin_id, value.name, value.session_id, json.dumps(config), fingerprint, entry, source_digest, load_id))
                db.execute("INSERT INTO plugin_loads(id,plugin,digest) VALUES(?,?,?)", (load_id, value.plugin_id, identity))
            await self.db.call(accepted, write=True)
            return await self._load_plugin(value.plugin_id, load_id)

    async def reload_plugin(self, value: ReloadPlugin) -> PluginView:
        async with self.control:
            self.check_host(value)
            self._admit()
            current = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if current is None:
                raise BackendError("plugin_not_found", status=404)
            if str(current["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            # Pin retries to the request bytes, before observing a possibly changed entry file.
            identity = hashlib.sha256(json.dumps(value.model_dump(mode="json", exclude={"host_epoch", "build_id"}), sort_keys=True).encode()).hexdigest()
            load_id = "reload:" + value.reload_id
            previous = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_loads WHERE id=?", (load_id,)).fetchone())
            if previous is not None:
                if str(previous["digest"]) != identity or str(previous["plugin"]) != value.plugin_id:
                    raise BackendError("plugin_reload_conflict")
                return PluginView.model_validate_json(str(previous["result"])) if str(previous["result"]) else self._plugin_view(current)
            config = validate_config(value.config)
            entry, source_digest = entry_digest(value.entry or str(current["entry"]))
            fingerprint = plugin_fingerprint(value.plugin_id, str(current["name"]), config, entry=entry, source_digest=source_digest, load_id=load_id)
            others = [str(row[0]) for row in await self.db.call(lambda db: db.execute(
                "SELECT fingerprint FROM plugins WHERE id!=? AND session=?", (value.plugin_id, value.session_id)).fetchall())]
            await self._plugin_change_blocked(set_fingerprint([*others, fingerprint]), value.session_id)
            if not await self._close_plugin(current):
                raise BackendError("execution_cleanup_pending", status=503)
            def accepted(db: sqlite3.Connection) -> None:
                db.execute("INSERT INTO plugin_loads(id,plugin,digest) VALUES(?,?,?)", (load_id, value.plugin_id, identity))
                db.execute("UPDATE plugins SET config=?,fingerprint=?,entry=?,source_digest=?,load_id=?,phase='loading',error='',lease='',directory='' WHERE id=?",
                    (json.dumps(config), fingerprint, entry, source_digest, load_id, value.plugin_id))
            await self.db.call(accepted, write=True)
            return await self._load_plugin(value.plugin_id, load_id)

    def _plugin_call(self, row: sqlite3.Row) -> PluginCallView:
        result = PluginResult.model_validate_json(str(row["result"])) if str(row["result"]) else None
        return PluginCallView.model_validate({"call_id":str(row["id"]), "phase":str(row["phase"]),
                                              "result":result, "error":str(row["error"]), "cancel_requested":bool(row["cancel_requested"]), "clean":bool(row["clean"])})

    async def call_plugin(self, value: PluginCallEnvelope) -> PluginCallView:
        async with self.control:
            self.check_host(value)
            plugin = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if plugin is None:
                raise BackendError("plugin_not_found", status=404)
            if str(plugin["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            payload = json.dumps({"kind":value.kind, "name":value.name, "arguments":value.arguments}, sort_keys=True)
            existing = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
            if existing is not None:
                if (str(existing["plugin"]), str(existing["session"]), str(existing["text"])) != (value.plugin_id, value.session_id, payload):
                    raise BackendError("plugin_call_conflict")
                return self._plugin_call(existing)
            cancelled = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_cancels WHERE id=?", (value.call_id,)).fetchone())
            if cancelled is not None:
                if (str(cancelled["plugin"]), str(cancelled["session"])) != (value.plugin_id, value.session_id):
                    raise BackendError("plugin_call_conflict")
                await self.db.call(lambda db: db.execute("INSERT INTO plugin_calls(id,plugin,session,text,phase,cancel_requested,clean) VALUES(?,?,?,?,'cancelled',1,1)",
                    (value.call_id, value.plugin_id, value.session_id, payload)), write=True)
                return PluginCallView(call_id=value.call_id, phase="cancelled", cancel_requested=True, clean=True)
            self._admit()
            await self._plugin_fingerprint_ready(await self.plugin_set_fingerprint(value.session_id), value.session_id)
            if session_workspace(self.profile.path, value.session_id) != value.workspace:
                raise BackendError("workspace_mismatch")
            workspace = self.profile.config.workspace if value.workspace == PRIMARY else dict(load_grants(self.profile.path)).get(value.workspace)
            if workspace is None:
                raise BackendError("workspace_not_found")
            client = self.plugin_clients.get(value.plugin_id)
            if client is None or not client.ready:
                raise BackendError("plugin_disconnected", "Explicitly reload the plugin", 503)
            if client.pending:
                raise BackendError("plugin_busy", status=429)
            if not any(tool.name == value.name and tool.kind == value.kind for tool in client.tools):
                raise BackendError("plugin_tool_not_found", status=404)
            await self.db.call(lambda db: db.execute(
                "INSERT INTO plugin_calls(id,plugin,session,text,phase,fingerprint) VALUES(?,?,?,?,'unknown',?)",
                (value.call_id, value.plugin_id, value.session_id, payload, str(plugin["fingerprint"]))), write=True)
            # Reserve before releasing control, so another call cannot overtake the journaled one.
            client.pending = value.call_id
        phase, result, error, clean = "unknown", "", "plugin_outcome_unknown", False
        try:
            client.pending = ""
            reply = await client.call(value.call_id, value.name, value.arguments, str(workspace), value.session_id, value.kind)
            phase, result, error, clean = reply.phase, reply.result.model_dump_json() if reply.result else "", reply.error, False
        except asyncio.CancelledError:
            client.ready = False
            await asyncio.shield(self._close_plugin(plugin))
            raise
        except (OSError, ValueError, BackendError, TimeoutError) as failure:
            client.ready = False
            clean = await self._close_plugin(plugin)
            error = failure.code if isinstance(failure, BackendError) else type(failure).__name__
        finally:
            client.pending = ""
        await self.db.call(lambda db: db.execute("UPDATE plugin_calls SET phase=?,result=?,error=?,clean=? WHERE id=?",
            (phase, result, error, int(clean), value.call_id)), write=True)
        row = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
        assert row is not None
        return self._plugin_call(row)

    async def close_plugin(self, value: ClosePlugin) -> PluginView:
        async with self.control:
            self.check_host(value)
            row = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if row is None or str(row["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            await self._close_plugin(row)
            current = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            assert current is not None
            return self._plugin_view(current)

    async def cancel_plugin(self, value: CancelPlugin) -> PluginCallView:
        async with self.control:
            self.check_host(value)
            plugin = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if plugin is None or str(plugin["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            row = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
            previous = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_cancels WHERE id=?", (value.call_id,)).fetchone())
            for record in [row, previous]:
                if record is not None and (str(record["plugin"]), str(record["session"])) != (value.plugin_id, value.session_id):
                    raise BackendError("plugin_call_conflict")
            if row is not None and str(row["phase"]) != "unknown":
                return self._plugin_call(row)
            await self.db.call(lambda db: db.execute("INSERT OR IGNORE INTO plugin_cancels VALUES(?,?,?)",
                (value.call_id, value.plugin_id, value.session_id)), write=True)
            if row is None:
                return PluginCallView(call_id=value.call_id, phase="cancelled", cancel_requested=True, clean=True)
            await self.db.call(lambda db: db.execute("UPDATE plugin_calls SET cancel_requested=1 WHERE id=?", (value.call_id,)), write=True)
            plugin = await self.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            assert plugin is not None
            client = self.plugin_clients.get(value.plugin_id)
            if client is not None and client.pending == value.call_id:
                with contextlib.suppress(OSError, BackendError):
                    await client.send({"op":"cancel", "call_id":value.call_id})
                clean = await self._close_plugin(plugin)
                await self.db.call(lambda db: db.execute("UPDATE plugin_calls SET clean=? WHERE id=?", (int(clean), value.call_id)), write=True)
            current = await self.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
            assert current is not None
            return self._plugin_call(current)

    def _remote_view(self, row: sqlite3.Row) -> RemoteView:
        phase = str(row["phase"])
        if phase not in {"connected", "disconnected", "blocked"}:
            phase = "blocked"
        return RemoteView(remote_id=str(row["id"]), host=str(row["host"]), phase=phase,  # type: ignore[arg-type]
                          generation=int(row["generation"]))

    def _remote_call(self, row: sqlite3.Row) -> RemoteCallView:
        phase = str(row["phase"])
        if phase not in {"unknown", "done", "conflict"}:
            phase = "unknown"
        return RemoteCallView(call_id=str(row["id"]), phase=phase, result=str(row["result"]))  # type: ignore[arg-type]

    async def _remote_row(self, remote_id: str) -> sqlite3.Row | None:
        return await self.db.call(lambda db: db.execute("SELECT * FROM remotes WHERE id=?", (remote_id,)).fetchone())

    async def _unknown_remote(self, remote_id: str) -> bool:
        row = await self.db.call(lambda db: db.execute(
            "SELECT 1 FROM remote_calls WHERE remote=? AND phase='unknown'", (remote_id,)).fetchone())
        return row is not None

    def _hello_matches(self, row: sqlite3.Row, hello: dict[str, object]) -> bool:
        return (hello.get("op") == "hello" and hello.get("daemon_id") == row["daemon_id"]
                and hello.get("generation") == int(row["generation"]))

    async def _dial_remote(self, row: sqlite3.Row) -> RemoteClient | None:
        if not await self._stop_remote_transport(row):
            raise BackendError("ssh_transport_stop_unconfirmed", status=503)
        try:
            target = SshTarget.model_validate_json(str(row["target"]))
            directory = self.profile.path / "remotes" / str(row["id"])
            client = await asyncio.to_thread(RemoteClient.connect, target, directory, str(row["host_key"]), str(row["id"]))
        except (OSError, BackendError, ValueError) as exc:
            phase = "blocked" if isinstance(exc, (ValueError, BackendError)) and (
                not isinstance(exc, BackendError) or exc.code in {"ssh_host_key_unknown", "ssh_host_key_changed", "invalid_ssh_host_key"}) else "disconnected"
            await self.db.call(lambda db: db.execute(
                "UPDATE remotes SET phase=? WHERE id=?", (phase, row["id"])), write=True)
            if isinstance(exc, BackendError):
                raise
            return None
        if not self._hello_matches(row, client.hello):
            client.close()
            await self.db.call(lambda db: db.execute(
                "UPDATE remotes SET phase='blocked' WHERE id=?", (row["id"],)), write=True)
            return None
        self.remote_clients[str(row["id"])] = client
        await self.db.call(lambda db: db.execute(
            "UPDATE remotes SET phase='connected',transport=? WHERE id=?",
            (TypeAdapter(list[ProcessIdentity]).dump_json(client.leases).decode(), row["id"])), write=True)
        return client

    async def _absorb_remote(self, remote_id: str, client: RemoteClient) -> None:
        pending = await self.db.call(lambda db: db.execute(
            "SELECT id FROM remote_calls WHERE remote=? AND phase='unknown'", (remote_id,)).fetchall())
        for item in pending:
            call_id = str(item["id"])
            try:
                reply = await asyncio.to_thread(client.query, call_id)
            except (OSError, BackendError):
                await self.disconnect_remote_id(remote_id)
                return
            if reply.get("op") == "result" and isinstance(reply.get("text"), str):
                await self.db.call(lambda db, cid=call_id, text=reply["text"]: db.execute(
                    "UPDATE remote_calls SET phase='done',result=? WHERE id=? AND phase='unknown'",
                    (text, cid)), write=True)

    @staticmethod
    def _remote_matches(row: sqlite3.Row, value: OpenRemote) -> bool:
        target = SshTarget.model_validate(value.model_dump(include=set(SshTarget.model_fields))).model_dump_json()
        return (row["session"], row["host"], row["host_key"], row["daemon_id"], int(row["generation"]), row["target"]) == (
            value.session_id, value.host, value.host_key, value.daemon_id, value.generation, target)

    async def open_remote(self, value: OpenRemote) -> RemoteView:
        async with self.remote_control:
            return await self._open_remote(value)

    async def _open_remote(self, value: OpenRemote) -> RemoteView:
        self.check_host(value)
        self._admit()
        target = SshTarget.model_validate(value.model_dump(include=set(SshTarget.model_fields))).model_dump_json()
        existing = await self._remote_row(value.remote_id)
        if existing is not None:
            if not self._remote_matches(existing, value):
                raise BackendError("remote_conflict")
            await self._reconnect_remote(value)
            current = await self._remote_row(value.remote_id)
            assert current is not None
            return self._remote_view(current)
        await self.db.call(lambda db: db.execute(
            "INSERT INTO remotes(id,session,host,host_key,daemon_id,generation,phase,target) VALUES(?,?,?,?,?,?,'disconnected',?)",
            (value.remote_id, value.session_id, value.host, value.host_key, value.daemon_id, value.generation, target)),
            write=True)
        row = await self._remote_row(value.remote_id)
        assert row is not None
        client = await self._dial_remote(row)
        if client is not None:
            await self._absorb_remote(value.remote_id, client)
        current = await self._remote_row(value.remote_id)
        assert current is not None
        if current["phase"] == "blocked":
            raise BackendError("remote_identity_mismatch")
        if current["phase"] != "connected":
            raise BackendError("remote_disconnected", status=503)
        return self._remote_view(current)

    async def reconnect_remote(self, value: OpenRemote) -> RemoteView:
        async with self.remote_control:
            return await self._reconnect_remote(value)

    async def _reconnect_remote(self, value: OpenRemote) -> RemoteView:
        self.check_host(value)
        self._admit()
        row = await self._remote_row(value.remote_id)
        if row is None or row["session"] != value.session_id:
            raise BackendError("remote_not_found", status=404)
        if not self._remote_matches(row, value):
            raise BackendError("remote_conflict")
        if value.remote_id in self.remote_clients:
            await self.disconnect_remote_id(value.remote_id)
            row = await self._remote_row(value.remote_id)
            assert row is not None
        client = await self._dial_remote(row)
        if client is None:
            current = await self._remote_row(value.remote_id)
            assert current is not None
            if current["phase"] == "blocked":
                raise BackendError("remote_identity_mismatch")
            raise BackendError("remote_disconnected", status=503)
        await self._absorb_remote(value.remote_id, client)
        current = await self._remote_row(value.remote_id)
        assert current is not None
        return self._remote_view(current)

    async def disconnect_remote_id(self, remote_id: str) -> None:
        client = self.remote_clients.get(remote_id)
        if client is not None:
            try:
                await asyncio.to_thread(client.close)
            finally:
                # Persist any descendants observed while stopping before releasing the live handle.
                await self.db.call(lambda db: db.execute("UPDATE remotes SET transport=? WHERE id=?",
                    (TypeAdapter(list[ProcessIdentity]).dump_json(client.leases).decode(), remote_id)), write=True)
            self.remote_clients.pop(remote_id, None)
        await self.db.call(lambda db: db.execute(
            "UPDATE remotes SET phase='disconnected' WHERE id=? AND phase!='blocked'", (remote_id,)), write=True)

    async def disconnect_remote(self, value: OpenRemote) -> RemoteView:
        async with self.remote_control:
            return await self._disconnect_remote(value)

    async def _disconnect_remote(self, value: OpenRemote) -> RemoteView:
        self.check_host(value)
        self._admit()
        row = await self._remote_row(value.remote_id)
        if row is None or row["session"] != value.session_id:
            raise BackendError("remote_not_found", status=404)
        if not self._remote_matches(row, value):
            raise BackendError("remote_conflict")
        await self.disconnect_remote_id(value.remote_id)
        current = await self._remote_row(value.remote_id)
        assert current is not None
        return self._remote_view(current)

    async def submit_remote(self, value: OpenRemote, call: RemoteCallRequest) -> RemoteCallView:
        async with self.remote_control:
            return await self._submit_remote(value, call)

    async def _submit_remote(self, value: OpenRemote, call: RemoteCallRequest) -> RemoteCallView:
        self.check_host(value)
        self._admit()
        row = await self._remote_row(value.remote_id)
        if row is None or row["session"] != value.session_id:
            raise BackendError("remote_not_found", status=404)
        if not self._remote_matches(row, value):
            raise BackendError("remote_conflict")
        if row["phase"] != "connected":
            raise BackendError("remote_unreachable", status=503)
        if await self._unknown_remote(value.remote_id):
            existing = await self.db.call(lambda db: db.execute(
                "SELECT * FROM remote_calls WHERE id=?", (call.call_id,)).fetchone())
            if existing is None or existing["remote"] != value.remote_id:
                raise BackendError("remote_blocked", status=503)
        existing = await self.db.call(lambda db: db.execute(
            "SELECT * FROM remote_calls WHERE id=?", (call.call_id,)).fetchone())
        client = self.remote_clients.get(value.remote_id)
        if client is None:
            await self.disconnect_remote_id(value.remote_id)
            raise BackendError("remote_disconnected", status=503)
        if existing is not None:
            if existing["remote"] != value.remote_id or existing["command"] != call.command:
                raise BackendError("remote_call_conflict")
            if existing["phase"] == "done":
                return self._remote_call(existing)
            try:
                reply = await asyncio.to_thread(client.query, call.call_id)
            except (OSError, BackendError):
                await self.disconnect_remote_id(value.remote_id)
                raise BackendError("remote_disconnected", status=503) from None
            return await self._apply_remote_reply(call.call_id, reply, allow_new=False)
        await self.db.call(lambda db: db.execute(
            "INSERT INTO remote_calls(id,remote,command,phase) VALUES(?,?,?,'unknown')",
            (call.call_id, value.remote_id, call.command)), write=True)
        try:
            reply = await asyncio.to_thread(client.call, call.call_id, call.command)
        except (OSError, BackendError):
            await self.disconnect_remote_id(value.remote_id)
            current = await self.db.call(lambda db: db.execute(
                "SELECT * FROM remote_calls WHERE id=?", (call.call_id,)).fetchone())
            assert current is not None
            return self._remote_call(current)
        return await self._apply_remote_reply(call.call_id, reply, allow_new=True)

    async def _apply_remote_reply(self, call_id: str, reply: dict[str, object], *, allow_new: bool) -> RemoteCallView:
        op = reply.get("op")
        if op == "result" and isinstance(reply.get("text"), str):
            phase, result = "done", reply["text"]
        elif op == "conflict":
            phase, result = "conflict", ""
        else:
            phase, result = "unknown", ""
        if not allow_new and phase == "conflict":
            phase = "unknown"
        await self.db.call(lambda db: db.execute(
            "UPDATE remote_calls SET phase=?,result=? WHERE id=?", (phase, result, call_id)), write=True)
        current = await self.db.call(lambda db: db.execute("SELECT * FROM remote_calls WHERE id=?", (call_id,)).fetchone())
        assert current is not None
        return self._remote_call(current)

    async def _terminal_row(self, terminal_id: str) -> sqlite3.Row | None:
        return await self.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE id=?", (terminal_id,)).fetchone())

    def _view(self, row: sqlite3.Row) -> TerminalView:
        phase = row["phase"]
        if phase not in {"running", "exited", "unknown"}:
            phase = "unknown"
        return TerminalView(terminal_id=str(row["id"]), session_id=str(row["session"]), cols=int(row["cols"]), rows=int(row["rows"]),
                            queued=int(row["queued"]), written=int(row["written"]),
                            exit_code=None if row["exit_code"] is None else int(row["exit_code"]),
                            output=str(row["output"]), output_seq=int(row["output_seq"] or 0),
                            phase=phase, clean=bool(row["clean"]),
                            workspace=str(row["workspace"]))

    async def _store_terminal(self, client: PtyClient, terminal_id: str, *, cols: int, rows: int, phase: str,
                              drain: bool = True) -> None:
        if drain:
            await asyncio.to_thread(client.drain)
        output, seq = client.text, client.text_seq

        def save(db: sqlite3.Connection) -> None:
            db.execute("UPDATE terminals SET queued=?,written=?,output=?,output_seq=?,cols=?,rows=?,phase=?,"
                       "exit_code=CASE WHEN ? IS NULL THEN exit_code ELSE ? END WHERE id=?",
                       (client.queued, client.written, output, seq, cols, rows, phase, client.exit_code,
                        client.exit_code, terminal_id))

        await self.db.call(save, write=True)

    async def open_terminal(self, value: OpenTerminal) -> TerminalView:
        async with self.control:
            self.check_host(value)
            old = await self._terminal_row(value.terminal_id)
            if old is not None:
                workspace = value.workspace or str(old["workspace"])
                if (old["session"], old["command"], old["workspace"]) != (value.session_id, value.command, workspace):
                    raise BackendError("terminal_conflict")
                return self._view(old)
            self._admit()
            recorded = session_workspace(self.profile.path, value.session_id)
            workspace = value.workspace or recorded
            count = await self.db.call(lambda db: db.execute("SELECT count(*) FROM terminals WHERE clean=0").fetchone()[0])
            if count >= 8:
                raise BackendError("terminal_capacity", status=429)
            blocked = await self.db.call(lambda db: db.execute(
                "SELECT 1 FROM terminals WHERE session=? AND phase='unknown' AND clean=0", (value.session_id,)).fetchone())
            if blocked:
                raise BackendError("execution_cleanup_pending", status=503)
            location = self.profile.config.workspace if workspace == PRIMARY else dict(load_grants(self.profile.path)).get(workspace)
            if location is None:
                raise BackendError("workspace_not_found")
            instance = hashlib.sha256(("terminal:" + value.terminal_id).encode()).hexdigest()[:32]
            directory = self.profile.path / "executions" / instance
            directory.mkdir(mode=0o700, parents=True, exist_ok=False)
            try:
                with ProcessReservation(self.profile.path, "execution", instance) as reservation:
                    await self.db.call(lambda db: db.execute(
                        "INSERT INTO terminals(id,session,command,cols,rows,phase,workspace,lease,directory) VALUES(?,?,?,?,?,'unknown',?,?,?)",
                        (value.terminal_id, value.session_id, value.command, value.cols, value.rows, workspace,
                         reservation.lease.model_dump_json(), str(directory))), write=True)
                    process = await ServiceProcess.start(self.profile.path, instance, directory, reservation, "pty")
                    self.terminal_processes[value.terminal_id] = process
                client = PtyClient(process.sock)
                self.terminals[value.terminal_id] = client
                await self.db.call(lambda db: db.execute("UPDATE terminals SET permitted=1 WHERE id=?", (value.terminal_id,)), write=True)
                await asyncio.to_thread(client.permit, value.command, os.getuid(), os.getgid(), value.cols, value.rows, location)
                await self._store_terminal(client, value.terminal_id, cols=value.cols, rows=value.rows, phase="running")
            except BaseException:
                row = await self._terminal_row(value.terminal_id)
                if row is not None:
                    await self._close_terminal(row, interrupted=True)
                raise
            row = await self._terminal_row(value.terminal_id)
            assert row is not None
            return self._view(row)

    async def list_terminals(self, value: TerminalSession) -> TerminalList:
        async with self.control:
            self.check_host(value)
            rows = await self.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE session=? ORDER BY clean,rowid DESC LIMIT 100",
                                                           (value.session_id,)).fetchall())
            return TerminalList(terminals=[self._view(row) for row in rows])

    async def _close_terminal(self, row: sqlite3.Row, *, interrupted: bool = False) -> TerminalView:
        identity = str(row["id"])
        process = self.terminal_processes.get(identity)
        client = self.terminals.get(identity)
        if client:
            with contextlib.suppress(OSError, BackendError):
                await asyncio.to_thread(client.drain)
        if process:
            await process.close()
        self.terminal_processes.pop(identity, None)
        self.terminals.pop(identity, None)
        if client:
            await self._store_terminal(client, identity, cols=int(row["cols"]), rows=int(row["rows"]), phase="unknown",
                                       drain=False)
        clean = bool(row["clean"])
        if not clean and row["lease"]:
            clean = await reconcile(Path(row["directory"]), ProcessLease.model_validate_json(row["lease"]), permitted=bool(row["permitted"]))
        phase = "exited" if clean and not interrupted else "unknown"
        await self.db.call(lambda db: db.execute("UPDATE terminals SET phase=?,clean=? WHERE id=?", (phase, int(clean), identity)), write=True)
        current = await self._terminal_row(identity)
        assert current is not None
        return self._view(current)

    async def _close_terminals(self, *, require_clean: bool = True) -> None:
        rows = await self.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE clean=0").fetchall())
        results = await asyncio.gather(*(self._close_terminal(row,
            interrupted=str(row["id"]) not in self.terminal_processes) for row in rows), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        if require_clean and any(isinstance(result, TerminalView) and not result.clean for result in results):
            raise BackendError("terminal_stop_unconfirmed", status=503)

    async def close_terminal(self, value: TerminalQuery) -> TerminalView:
        async with self.control:
            self.check_host(value)
            row = await self._terminal_row(value.terminal_id)
            if row is None or row["session"] != value.session_id:
                raise BackendError("terminal_not_found", status=404)
            return await self._close_terminal(row)

    async def write_terminal(self, value: TerminalInput) -> TerminalView:
        async with self.control:
            self.check_host(value)
            row = await self._terminal_row(value.terminal_id)
            if row is None or row["session"] != value.session_id:
                raise BackendError("terminal_not_found", status=404)
            previous = await self.db.call(lambda db: db.execute(
                "SELECT * FROM terminal_inputs WHERE id=?", (value.input_id,)).fetchone())
            if previous is not None:
                if str(previous["data"]) != value.data or previous["terminal"] != value.terminal_id:
                    raise BackendError("terminal_input_conflict")
                return self._view(row).model_copy(update={"input_id": value.input_id,
                    "input_status": "accepted" if previous["accepted"] == len(value.data.encode()) else "unknown"})
            self._admit()
            if row["phase"] != "running" or row["exit_code"] is not None:
                raise BackendError("terminal_not_running")
            client = self.terminals.get(value.terminal_id)
            if client is None:
                await self._mark_terminal_unknown(value.terminal_id)
                raise BackendError("terminal_channel_lost", status=503)
            encoded = value.data.encode()
            if not encoded or len(encoded) > client.credit:
                raise BackendError("pty_window_full")
            await self.db.call(lambda db: db.execute(
                "INSERT INTO terminal_inputs(id,terminal,data,accepted) VALUES(?,?,?,-1)",
                (value.input_id, value.terminal_id, value.data)), write=True)
            before = client.written + client.queued
            await asyncio.to_thread(client.send_input, encoded)
            await asyncio.to_thread(client.pump, 0.5, lambda: client.written + client.queued >= before + len(encoded))
            accepted = client.written + client.queued - before
            await self.db.call(lambda db: db.execute(
                "UPDATE terminal_inputs SET accepted=? WHERE id=?", (accepted, value.input_id)), write=True)
            await self._store_terminal(client, value.terminal_id, cols=int(row["cols"]), rows=int(row["rows"]), phase="running")
            current = await self._terminal_row(value.terminal_id)
            assert current is not None
            return self._view(current).model_copy(update={"input_id": value.input_id,
                "input_status": "accepted" if accepted == len(encoded) else "unknown"})

    async def resize_terminal(self, value: TerminalResize) -> TerminalView:
        async with self.control:
            self.check_host(value)
            self._admit()
            row = await self._terminal_row(value.terminal_id)
            if row is None or row["session"] != value.session_id:
                raise BackendError("terminal_not_found", status=404)
            client = self.terminals.get(value.terminal_id)
            if client is None or row["phase"] != "running":
                raise BackendError("terminal_not_running")
            await asyncio.to_thread(client.resize, value.cols, value.rows)
            await self._store_terminal(client, value.terminal_id, cols=value.cols, rows=value.rows, phase="running")
            current = await self._terminal_row(value.terminal_id)
            assert current is not None
            return self._view(current)

    async def read_terminal(self, value: TerminalQuery) -> TerminalView:
        async with self.control:
            self.check_host(value)
            session_id, terminal_id = value.session_id, value.terminal_id
            row = await self._terminal_row(terminal_id)
            if row is None or row["session"] != session_id:
                raise BackendError("terminal_not_found", status=404)
            client = self.terminals.get(terminal_id)
            if client is None:
                return self._view(row)
            try:
                await asyncio.to_thread(client.drain)
            except (OSError, BackendError):
                await self._mark_terminal_unknown(terminal_id)
                current = await self._terminal_row(terminal_id)
                assert current is not None
                return self._view(current)
            if client.closed or client.exit_code is not None:
                return await self._close_terminal(row, interrupted=client.exit_code is None)
            phase = str(row["phase"])
            await self._store_terminal(client, terminal_id, cols=int(row["cols"]), rows=int(row["rows"]), phase=phase)
            current = await self._terminal_row(terminal_id)
            assert current is not None
            return self._view(current)

    async def _mark_terminal_unknown(self, terminal_id: str) -> None:
        await self.db.call(lambda db: db.execute(
            "UPDATE terminals SET phase='unknown' WHERE id=? AND exit_code IS NULL", (terminal_id,)), write=True)

    async def close(self) -> None:
        if self.monitor_task:
            self.monitor_task.cancel()
            await asyncio.gather(self.monitor_task, return_exceptions=True)
        await self._cancel_jobs()
        for channel in list(self.channels.values()):
            await channel.close()
        try:
            if not self.db.failed:
                await self._close_services(require_clean=False)
        finally:
            # Storage failure must not prevent closing already-owned process handles.
            for process in self.terminal_processes.values():
                await process.close()
            for process in self.mcp_processes.values():
                await process.close()
            for client in self.plugin_clients.values():
                await client.close()
            self.plugin_clients.clear()
            self.terminal_processes.clear()
            self.terminals.clear()
            self.mcp_processes.clear()
            self.mcp_clients.clear()
            for client in self.remote_clients.values():
                await asyncio.to_thread(client.close)
            self.remote_clients.clear()
            await self.db.close()


def application(owner: Supervisor, server_stop: asyncio.Event) -> FastAPI:
    app = app_factory(owner.profile.token)

    @app.get("/identity")
    async def identity() -> Identity:
        return owner.identity()

    app.post("/takeover")(owner.takeover)
    app.post("/workers/ensure")(owner.ensure_worker)
    app.post("/workers/heartbeat")(owner.heartbeat)
    app.post("/workers/stop")(owner.stop_worker)
    app.post("/epochs/open")(owner.open_epoch)

    @app.post("/epochs/close")
    async def close(value: Lease) -> Cleanup:
        return await owner.cleanup(value.session_id, value)

    app.post("/pty/open")(owner.open_terminal)
    app.post("/pty/input")(owner.write_terminal)
    app.post("/pty/resize")(owner.resize_terminal)
    app.post("/pty/read")(owner.read_terminal)
    app.post("/pty/list")(owner.list_terminals)
    app.post("/pty/close")(owner.close_terminal)
    app.post("/mcp/open")(owner.open_mcp)
    app.post("/mcp/cancel")(owner.cancel_mcp)
    app.post("/mcp/state")(owner.mcp_state)
    app.post("/code/run")(owner.run_code)
    app.post("/code/cancel")(owner.cancel_code)
    app.get("/plugins")(owner.list_plugins)
    app.post("/plugins/register")(owner.register_plugin)
    app.post("/plugins/reload")(owner.reload_plugin)
    app.post("/plugins/call")(owner.call_plugin)
    app.post("/plugins/cancel")(owner.cancel_plugin)
    app.post("/plugins/close")(owner.close_plugin)
    app.post("/remotes/open")(owner.open_remote)
    app.post("/remotes/reconnect")(owner.reconnect_remote)
    app.post("/remotes/disconnect")(owner.disconnect_remote)

    @app.post("/remotes/calls")
    async def remote_call(value: SubmitRemote) -> RemoteCallView:
        return await owner.submit_remote(value, RemoteCallRequest(call_id=value.call_id, command=value.command))

    @app.post("/mcp/calls")
    async def mcp_call(value: McpCallEnvelope) -> McpCall:
        return await owner.request_mcp_call(value.session_id, value.server_id, value.call, value)

    @app.post("/mcp/decision")
    async def mcp_decision(value: McpDecisionEnvelope) -> McpCall:
        return await owner.decide_mcp_call(value.session_id, value.server_id, value.call_id, value.decision, value)

    app.post("/mcp/lookup")(owner.lookup_mcp_call)
    app.post("/mcp/calls/cancel")(owner.cancel_mcp_call)
    app.post("/tools/run")(owner.run_tool)
    app.post("/tools/lookup")(owner.lookup_tool)
    app.post("/effects/resolve")(owner.resolve_effect)
    app.get("/health")(owner.health)
    app.post("/freeze")(owner.freeze)
    app.post("/thaw")(owner.thaw)
    app.post("/recover")(owner.recover)

    @app.post("/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        try:
            return await owner.shutdown(value)
        finally:
            server_stop.set()

    @app.post("/retire")
    async def retire(value: RetireSupervisor) -> SupervisorHealth:
        result = await owner.retire(value)
        server_stop.set()
        return result

    return app


async def serve(profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None,
                *, require_existing: bool = False) -> None:
    with lock(profile.path / "supervisor.lock"):
        owner = Supervisor(profile, instance, process_lease, require_existing=require_existing)
        stop = asyncio.Event()
        try:
            await owner.initialize()
            listener = unix_listener(profile.socket("supervisor"))
            server = uvicorn.Server(uvicorn.Config(application(owner, stop), log_level="error", access_log=False,
                                                  timeout_graceful_shutdown=5))
            async def watch() -> None:
                await stop.wait()
                server.should_exit = True
            watcher = asyncio.create_task(watch())
            try:
                await server.serve(sockets=[listener])
            finally:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
                listener.close()
        finally:
            if owner.monitor_task:
                owner.monitor_task.cancel()
                await asyncio.gather(owner.monitor_task, return_exceptions=True)
            try:
                if owner.registered and not stop.is_set():
                    await owner.shutdown(HostFence(host_epoch=owner.host_epoch, build_id=owner.build))
            finally:
                await owner.close()
