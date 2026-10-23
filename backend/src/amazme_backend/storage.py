"""Single-writer session state. Rows and complete commit batches share one transaction."""
import asyncio
import hashlib
import json
import re
import secrets
import shutil
import sqlite3
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from .contracts import (
    Approval,
    ApprovalDecision,
    BackendError,
    Cleanup,
    CommitBatch,
    Compaction,
    ComputerActionView,
    ComputerCaptureView,
    ComputerPolicy,
    Decision,
    DelegateTasks,
    EffectHold,
    EffectResolution,
    Event,
    HostFence,
    Message,
    Model,
    Preview,
    ProviderConfig,
    Receipt,
    Replay,
    SearchHit,
    Snapshot,
    Submit,
    ToolCall,
    UsageReport,
    WebCallView,
    WebPolicy,
    WorkerActivity,
    WorkerState,
    WorkflowChild,
    WorkflowView,
)
from .faults import Faults
from .providers import Completion, stored_provider
from .session_domain import (
    Action,
    CloseEpoch,
    Continue,
    EffectResolved,
    EpochClosed,
    EpochOpened,
    Failed,
    ModelInvocation,
    ModelReturned,
    Observation,
    OpenEpoch,
    Park,
    Previewed,
    QueryTool,
    ReconcileEffect,
    Run,
    Step,
    ToolInvocation,
    ToolObserved,
    ToolReturned,
    WebRetrieval,
    WebReturned,
    normalized_call,
)

TERMINAL = frozenset({"succeeded", "cancelled", "interrupted", "failed", "unknown"})
_SESSION_ID = re.compile(r"^[a-f0-9]{32}$")
_SESSION_FILES = frozenset({"session.sqlite", "session.sqlite-wal", "session.sqlite-shm"})


def compaction_basis(payloads: list[str]) -> str:
    return hashlib.sha256("\n".join(payloads).encode()).hexdigest()


def session_database(profile: Path, session: str) -> Path:
    if _SESSION_ID.fullmatch(session) is None:
        raise BackendError("invalid_session")
    return profile / "sessions" / session / "session.sqlite"


def remove_session_directory(directory: Path) -> None:
    if not directory.exists():
        return
    if not directory.is_dir():
        raise BackendError("branch_cleanup_refused")
    names = {item.name for item in directory.iterdir()}
    if not names <= _SESSION_FILES:
        raise BackendError("branch_cleanup_refused")
    for name in sorted(names):
        (directory / name).unlink()
    directory.rmdir()


def read_settled_root(path: Path, request_id: str) -> tuple[str, Receipt, list[tuple[str, str]], str]:
    """Read one settled root turn. The caller copies it; this connection never writes."""
    if not path.is_file():
        raise BackendError("branch_point_missing", status=404)
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            row = connection.execute("SELECT digest, payload FROM requests WHERE id=?", (request_id,)).fetchone()
        except sqlite3.Error as exc:
            raise BackendError("branch_point_missing", status=404) from exc
        if row is None:
            raise BackendError("branch_point_missing", status=404)
        try:
            receipt = Receipt.model_validate_json(row[1])
            messages = [
                (str(key), str(payload)) for key, payload in connection.execute(
                    "SELECT message_key, payload FROM messages WHERE request_id=? ORDER BY ordinal", (request_id,))
            ]
            run_row = connection.execute("SELECT payload FROM runs WHERE request_id=?", (request_id,)).fetchone()
            run = Run.model_validate_json(run_row[0]) if run_row else None
            for _, payload in messages:
                Message.model_validate_json(payload)
        except (ValueError, sqlite3.Error) as exc:
            raise BackendError("storage_corrupt", status=503) from exc
        if receipt.kind != "root" or receipt.request_id != request_id:
            raise BackendError("branch_point_not_root")
        settled = (receipt.status == "succeeded" and receipt.decision is not None
                   and receipt.decision.status == "succeeded" and messages and run is not None
                   and run.request_id == request_id and run.lease is None
                   and not run.opening and not run.cleanup_required)
        if not settled:
            raise BackendError("branch_point_unsettled")
        assert run_row is not None
        return str(row[0]), receipt, messages, str(run_row[0])
    finally:
        connection.close()
PENDING_LIMIT = 128
RETAIN_BATCHES = 256
RETAIN_BYTES = 2 * 1024 * 1024
CONTEXT_BYTES = 262144
SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
SNAPSHOT_VIEW_BYTES = 2 * 1024 * 1024
SNAPSHOT_CHILD_BYTES = 512 * 1024


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def workflow_body(check: str, correction_limit: int) -> str:
    return json.dumps({"check": check, "correction_limit": correction_limit},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def verdict_body(verdict_id: str, passed: bool) -> str:
    return json.dumps({"passed": passed, "verdict_id": verdict_id},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def correction_text(attempt: int) -> str:
    return f"修正第{attempt}次。上一阶段未通过。只处理这次修正。"


class Database:
    def __init__(self, path: Path, *, require_existing: bool = False,
                 preflight: Callable[[sqlite3.Connection], None] | None = None):
        self.path = path
        self.require_existing = require_existing
        self.preflight = preflight
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sqlite-owner")
        self.connection: sqlite3.Connection | None = None
        self.closed = False
        self.failure: str = ""
        self.identity: tuple[int, int] | None = None
        self.file_size = 0

    def _validate_file(self, *, initialized: bool = True) -> None:
        info = self.path.stat()
        if self.identity != (info.st_dev, info.st_ino) or (
            initialized and info.st_size < max(100, self.file_size)
        ):
            raise OSError("database file identity changed")
        self.file_size = info.st_size

    def _invoke[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.failure:
            raise BackendError("storage_blocked", self.failure, 503)
        try:
            if self.connection is None:
                exists = self.path.exists()
                if exists:
                    info = self.path.stat()
                    self.identity = (info.st_dev, info.st_ino)
                if self.require_existing and (not exists or self.path.stat().st_size == 0):
                    raise BackendError("storage_missing", status=503)
                if exists and self.path.stat().st_size:
                    # SQLite may create/rebuild SHM even with mode=ro. Probe a private copy
                    # including committed WAL pages, never the evidence files themselves.
                    with tempfile.TemporaryDirectory(prefix="amazme-preflight-") as temporary:
                        copied = Path(temporary) / "store.sqlite"
                        shutil.copyfile(self.path, copied)
                        wal = self.path.with_name(self.path.name + "-wal")
                        if wal.exists():
                            shutil.copyfile(wal, copied.with_name(copied.name + "-wal"))
                        probe = sqlite3.connect(copied.as_uri() + "?mode=ro", uri=True)
                        try:
                            self._preflight(probe)
                        finally:
                            probe.close()
                if exists:
                    self._validate_file(initialized=False)
                self.connection = sqlite3.connect(self.path.resolve().as_uri() + ("?mode=rw" if exists else "?mode=rwc"),
                                                  uri=True, isolation_level=None)
                if self.identity is None:
                    info = self.path.stat()
                    self.identity = (info.st_dev, info.st_ino)
                self._validate_file(initialized=False)
                self.connection.row_factory = sqlite3.Row
                self.connection.execute("PRAGMA user_version=2")
                self.connection.execute("PRAGMA journal_mode=WAL")
                self.connection.execute("PRAGMA synchronous=FULL")
                self.connection.execute("PRAGMA foreign_keys=ON")
            self._validate_file()
            result = operation(self.connection)
            self._validate_file()
            return result
        except (sqlite3.DatabaseError, OSError) as exc:
            self.failure = type(exc).__name__ + ":" + str(exc)
            raise BackendError("storage_failure", self.failure, 503) from exc

    def _preflight(self, probe: sqlite3.Connection) -> None:
        version = probe.execute("PRAGMA user_version").fetchone()[0]
        tables = probe.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        fresh = not self.require_existing and version == 0 and tables == 0
        if version != 2 and not fresh:
            raise BackendError("unsupported_storage_format")
        if self.require_existing and tables == 0:
            raise BackendError("storage_missing", status=503)
        if probe.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise BackendError("storage_corrupt")
        if version == 2 and self.preflight:
            self.preflight(probe)

    async def call[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.closed:
            raise BackendError("database_closed", status=503)
        return await asyncio.shield(asyncio.get_running_loop().run_in_executor(self.pool, self._invoke, operation))

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        def close_connection() -> None:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
        try:
            await asyncio.get_running_loop().run_in_executor(self.pool, close_connection)
        finally:
            self.pool.shutdown(wait=True)


class Changes:
    def __init__(self, seq: int):
        self.seq = seq
        self.events: list[Event] = []
        self.hooks: list[tuple[str, str, str]] = []

    def emit(self, kind: str, request_id: str = "", text: str = "", *,
             receipt: Receipt | None = None, approval: Approval | None = None,
             preview: Preview | None = None) -> None:
        self.events.append(Event.model_validate(dict(seq=str(self.seq), kind=kind, request_id=request_id, text=text,
                                                     receipt=receipt, approval=approval, preview=preview)))

    def hit(self, point: str, request_id: str = "", call_id: str = "") -> None:
        self.hooks.append((point, request_id, call_id))


def _fold_index(content: str, target: int) -> int:
    count = 0
    for index, char in enumerate(content):
        if count >= target:
            return index
        count += len(char.casefold())
    return len(content)


def _search_text(request_id: str, ordinal: int, role: Literal["user", "assistant", "tool"],
                 content: str, needle: str) -> list[SearchHit]:
    index = content.casefold().find(needle)
    if index < 0:
        return []
    start = _fold_index(content, index)
    end = _fold_index(content, index + len(needle))
    left = max(0, start - 40)
    right = min(len(content), end + 40)
    return [SearchHit(request_id=request_id, ordinal=ordinal, role=role, excerpt=content[left:right])]


class SessionStore:
    def __init__(self, path: Path, session_id: str, *, build: str = "test-build",
                 config: ProviderConfig | None = None, approval_policy: str = "mutations",
                 faults: Faults | None = None, require_existing: bool = False, instance: str = ""):
        self.db = Database(path, require_existing=require_existing, preflight=self._preflight)
        self.instance = instance or secrets.token_hex(16)
        self.session_id, self.build = session_id, build
        self.config = config or ProviderConfig(provider="faux")
        self.approval_policy = approval_policy
        self.faults = faults

    @staticmethod
    def _preflight(db: sqlite3.Connection) -> None:
        # Validate the existing schema before enabling WAL or running any DDL.
        columns = {
            "metadata": "key,value", "requests": "ordinal,id,digest,payload,status,parent_id,kind",
            "runs": "request_id,payload", "messages": "request_id,ordinal,message_key,payload",
            "steps": "id,request_id,ordinal,payload", "approvals": "id,request_id,payload",
            "decisions": "id,digest,request_id", "cancellations": "id,payload", "effects": "id,payload",
            "resolutions": "id,digest,request_id,payload,result", "previews": "request_id,payload",
            "batches": "seq,payload,bytes",
        }
        for table, names in columns.items():
            db.execute(f"SELECT {names} FROM {table} LIMIT 0")
        required = {"stream_id", "revision", "host_epoch", "freeze_id", "stopping", "blocked",
                    "driver_id", "execution_epoch"}
        if not required <= {str(r[0]) for r in db.execute("SELECT key FROM metadata")}:
            raise BackendError("storage_incomplete", status=503)
        models: tuple[tuple[str, type[Model]], ...] = (
            ("requests", Receipt), ("runs", Run), ("messages", Message), ("steps", Step),
            ("approvals", Approval), ("cancellations", Receipt), ("effects", EffectHold),
            ("resolutions", EffectResolution), ("previews", Preview), ("batches", CommitBatch),
        )
        try:
            for table, model in models:
                for row in db.execute(f"SELECT payload FROM {table}"):
                    model.model_validate_json(row[0])
            for row in db.execute("SELECT value FROM metadata WHERE key IN ('revision','host_epoch','execution_epoch')"):
                if int(row[0]) < 0:
                    raise ValueError("negative metadata counter")
        except ValueError as exc:
            raise BackendError("storage_corrupt", status=503) from exc
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise BackendError("storage_corrupt", status=503)

    async def initialize(self) -> None:
        def operation(db: sqlite3.Connection) -> None:
            db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests(
                  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  status TEXT GENERATED ALWAYS AS(json_extract(payload,'$.status')) VIRTUAL,
                  parent_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.parent_id')) VIRTUAL,
                  kind TEXT GENERATED ALWAYS AS(json_extract(payload,'$.kind')) VIRTUAL);
                CREATE INDEX IF NOT EXISTS requests_status ON requests(status,ordinal);
                CREATE INDEX IF NOT EXISTS requests_parent ON requests(parent_id);
                CREATE TABLE IF NOT EXISTS runs(request_id TEXT PRIMARY KEY REFERENCES requests(id),
                  payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS messages(request_id TEXT NOT NULL REFERENCES requests(id),
                  ordinal INTEGER NOT NULL,message_key TEXT NOT NULL,payload TEXT NOT NULL,
                  PRIMARY KEY(request_id,message_key),UNIQUE(request_id,ordinal));
                CREATE TABLE IF NOT EXISTS steps(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),
                  ordinal INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(request_id,ordinal));
                CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),
                  payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,digest TEXT NOT NULL,request_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS cancellations(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,digest TEXT NOT NULL,
                  request_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
                CREATE UNIQUE INDEX IF NOT EXISTS resolutions_call ON resolutions(json_extract(payload,'$.call_id'));
                CREATE TABLE IF NOT EXISTS previews(request_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS compactions(id TEXT PRIMARY KEY,basis TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS workflows(
                  id TEXT PRIMARY KEY,digest TEXT NOT NULL,parent_id TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS workflows_parent ON workflows(parent_id);
                CREATE TABLE IF NOT EXISTS workflow_verdicts(
                  workflow_id TEXT NOT NULL,verdict_id TEXT NOT NULL,digest TEXT NOT NULL,passed INTEGER NOT NULL,
                  PRIMARY KEY(workflow_id,verdict_id));
                CREATE TABLE IF NOT EXISTS web_policies(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS web_calls(
                  id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS computer_policies(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS computer_captures(
                  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,observed_ms INTEGER NOT NULL,
                  payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS computer_actions(
                  id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS computer_runtime(
                  id TEXT PRIMARY KEY,blocked INTEGER NOT NULL,exit_code INTEGER,proof TEXT NOT NULL);
            """)
            for key, value in {"stream_id": secrets.token_hex(16), "revision": "0", "host_epoch": "0",
                               "freeze_id": "", "stopping": "", "blocked": "", "driver_id": "", "execution_epoch": "0"}.items():
                db.execute("INSERT OR IGNORE INTO metadata VALUES(?,?)", (key, value))
            db.execute("COMMIT")
        await self.db.call(operation)

    @staticmethod
    def _meta(db: sqlite3.Connection, key: str) -> str:
        return str(db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0])

    @staticmethod
    def _set_meta(db: sqlite3.Connection, key: str, value: str) -> None:
        db.execute("UPDATE metadata SET value=? WHERE key=?", (value, key))

    def _fence(self, db: sqlite3.Connection, fence: HostFence) -> None:
        if fence.build_id != self.build:
            raise BackendError("build_mismatch")
        if fence.host_epoch != int(self._meta(db, "host_epoch")):
            raise BackendError("stale_host_epoch")

    async def _tx[T](self, operation: Callable[[sqlite3.Connection, Changes], T]) -> T:
        def transact(db: sqlite3.Connection) -> tuple[T, Changes]:
            db.execute("BEGIN IMMEDIATE")
            changes = Changes(int(self._meta(db, "revision")) + 1)
            try:
                result = operation(db, changes)
                if changes.events:
                    batch = CommitBatch(stream_id=self._meta(db, "stream_id"), seq=str(changes.seq),
                                        base_revision=str(changes.seq - 1), revision=str(changes.seq),
                                        events=changes.events)
                    payload = batch.model_dump_json()
                    db.execute("INSERT INTO batches VALUES(?,?,?)", (changes.seq, payload, len(payload.encode())))
                    self._set_meta(db, "revision", str(changes.seq))
                    db.execute("DELETE FROM batches WHERE seq<=?", (changes.seq - RETAIN_BATCHES,))
                    while db.execute("SELECT coalesce(sum(bytes),0) FROM batches").fetchone()[0] > RETAIN_BYTES:
                        first = db.execute("SELECT min(seq) FROM batches").fetchone()[0]
                        if first == changes.seq:
                            break
                        db.execute("DELETE FROM batches WHERE seq=?", (first,))
                if self.faults:
                    for point, request_id, call_id in changes.hooks:
                        if point == "accepted":
                            self.faults.sync_hit("before_commit", session_id=self.session_id,
                                                 request_id=request_id, call_id=call_id)
                db.execute("COMMIT")
                return result, changes
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        result, changes = await self.db.call(transact)
        if self.faults:
            for point, request_id, call_id in changes.hooks:
                await self.faults.hit(point, session_id=self.session_id, request_id=request_id, call_id=call_id)
        return result

    @staticmethod
    def _request(db: sqlite3.Connection, request_id: str) -> Receipt:
        row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
        if row is None:
            raise BackendError("request_not_found", status=404)
        return Receipt.model_validate_json(row[0])

    @staticmethod
    def _requests(db: sqlite3.Connection) -> list[Receipt]:
        return [Receipt.model_validate_json(r[0]) for r in db.execute("SELECT payload FROM requests ORDER BY ordinal")]

    @staticmethod
    def _save_request(db: sqlite3.Connection, c: Changes, receipt: Receipt, kind: str = "status") -> None:
        receipt.revision = str(c.seq)
        db.execute("UPDATE requests SET payload=? WHERE id=?", (receipt.model_dump_json(), receipt.request_id))
        c.emit(kind, receipt.request_id,
               receipt.status, receipt=receipt.model_copy(deep=True))

    @staticmethod
    def _run(db: sqlite3.Connection, request_id: str) -> Run:
        return Run.model_validate_json(db.execute("SELECT payload FROM runs WHERE request_id=?", (request_id,)).fetchone()[0])

    @staticmethod
    def _save_run(db: sqlite3.Connection, run: Run) -> None:
        db.execute("INSERT INTO runs VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload",
                   (run.request_id, run.model_dump_json()))

    @staticmethod
    def _save_step(db: sqlite3.Connection, step: Step) -> None:
        db.execute("INSERT INTO steps VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                   (step.step_id, step.request_id, step.ordinal, step.model_dump_json()))

    @staticmethod
    def _steps(db: sqlite3.Connection, request_id: str) -> list[Step]:
        return [Step.model_validate_json(r[0]) for r in db.execute(
            "SELECT payload FROM steps WHERE request_id=? ORDER BY ordinal", (request_id,))]

    @staticmethod
    def _step(db: sqlite3.Connection, step_id: str) -> Step:
        row = db.execute("SELECT payload FROM steps WHERE id=?", (step_id,)).fetchone()
        if row is None:
            raise BackendError("checkpoint_not_found")
        return Step.model_validate_json(row[0])

    @staticmethod
    def _messages(db: sqlite3.Connection, request_id: str) -> list[Message]:
        return [Message.model_validate_json(r[0]) for r in db.execute(
            "SELECT payload FROM messages WHERE request_id=? ORDER BY ordinal", (request_id,))]

    @staticmethod
    def _message(db: sqlite3.Connection, c: Changes, request_id: str, key: str, message: Message) -> None:
        size = db.execute("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM messages WHERE request_id=?",
                          (request_id,)).fetchone()[0]
        payload = message.model_dump_json()
        if size + len(payload.encode()) > CONTEXT_BYTES:
            raise BackendError("context_limit")
        ordinal = db.execute("SELECT coalesce(max(ordinal),0)+1 FROM messages WHERE request_id=?", (request_id,)).fetchone()[0]
        changed = db.execute("INSERT OR IGNORE INTO messages VALUES(?,?,?,?)",
                             (request_id, ordinal, key, payload)).rowcount
        if changed:
            c.emit("message", request_id, payload)

    def _new_request(self, db: sqlite3.Connection, c: Changes, value: Submit, *, parent_id: str = "",
                     depth: int = 0) -> Receipt:
        receipt = Receipt(request_id=value.request_id, run_id=value.request_id, text=value.text,
                          status="waiting_time" if value.not_before_ms > now_ms() else "queued",
                          parent_id=parent_id, kind="child" if parent_id else "root",
                          accepted_revision=str(c.seq), revision=str(c.seq), not_before_ms=value.not_before_ms)
        db.execute("INSERT INTO requests(id,digest,payload) VALUES(?,?,?)",
                   (value.request_id, digest(value.model_dump_json()), receipt.model_dump_json()))
        # Store public provider configuration only. Credentials remain in Profile.
        config = stored_provider(self.config)
        self._save_run(db, Run(request_id=value.request_id, config=config, depth=depth))
        c.emit("accepted", receipt.request_id, receipt.text, receipt=receipt.model_copy(deep=True))
        c.hit("accepted", receipt.request_id)
        return receipt

    async def fence(self, value: HostFence) -> int:
        def operation(db: sqlite3.Connection, c: Changes) -> int:
            if value.build_id != self.build:
                raise BackendError("build_mismatch")
            previous = int(self._meta(db, "host_epoch"))
            if value.host_epoch < previous:
                raise BackendError("stale_host_epoch")
            if value.host_epoch != previous:
                self._set_meta(db, "host_epoch", str(value.host_epoch))
                c.emit("status", text="host_fence:" + str(value.host_epoch))
            return value.host_epoch
        return await self._tx(operation)

    async def host_epoch(self) -> int:
        return await self.db.call(lambda db: int(self._meta(db, "host_epoch")))

    async def accept(self, value: Submit, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            self._fence(db, fence)
            row = db.execute("SELECT digest,payload FROM requests WHERE id=?", (value.request_id,)).fetchone()
            if row:
                if row[0] != digest(value.model_dump_json()):
                    raise BackendError("request_conflict")
                return Receipt.model_validate_json(row[1])
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            if self._meta(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            pending = self._pending_ids(db)
            tombstone = db.execute("SELECT payload FROM cancellations WHERE id=?", (value.request_id,)).fetchone()
            if len(pending) >= PENDING_LIMIT and not tombstone:
                raise BackendError("queue_full", status=429)
            if value.mode == "reject_busy" and pending and not tombstone:
                raise BackendError("session_busy")
            if value.mode == "steer" and not tombstone:
                if value.not_before_ms:
                    raise BackendError("scheduled_steer_unsupported")
                target = self._request(db, value.target_run_id)
                if target.status in TERMINAL or target.decision or target.kind == "steer":
                    raise BackendError("steer_target_settled")
                receipt = Receipt(request_id=value.request_id, run_id=target.run_id, parent_id=target.request_id,
                                  kind="steer", text=value.text, status="queued", accepted_revision=str(c.seq),
                                  revision=str(c.seq))
                db.execute("INSERT INTO requests(id,digest,payload) VALUES(?,?,?)",
                           (value.request_id, digest(value.model_dump_json()), receipt.model_dump_json()))
                self._expire_approvals(db, c, target.request_id)
                c.emit("accepted", receipt.request_id, receipt.text, receipt=receipt.model_copy(deep=True))
                c.hit("accepted", receipt.request_id)
                return receipt
            receipt = self._new_request(db, c, value)
            if tombstone:
                receipt.cancel_requested = True
                self._decide(db, c, receipt, Decision(status="cancelled", error="cancelled_before_acceptance"))
                self._settle(db, c, receipt)
            return receipt
        return await self._tx(operation)

    async def get(self, request_id: str) -> Receipt:
        def operation(db: sqlite3.Connection) -> Receipt:
            row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
            if row:
                return Receipt.model_validate_json(row[0])
            row = db.execute("SELECT payload FROM cancellations WHERE id=?", (request_id,)).fetchone()
            if row:
                return Receipt.model_validate_json(row[0])
            raise BackendError("request_not_found", status=404)
        return await self.db.call(operation)

    def _workflow_row(self, db: sqlite3.Connection, workflow_id: str) -> tuple[str, WorkflowView]:
        row = db.execute("SELECT digest,payload FROM workflows WHERE id=?", (workflow_id,)).fetchone()
        if row is None:
            raise BackendError("workflow_not_found", status=404)
        return str(row[0]), WorkflowView.model_validate_json(row[1])

    def _refresh_workflow(self, db: sqlite3.Connection, view: WorkflowView) -> WorkflowView:
        children = [child.model_copy(update={"status": self._request(db, child.request_id).status})
                    for child in view.children]
        parent = self._request(db, view.parent_id)
        return view.model_copy(update={"children": children, "parent_status": parent.status})

    @staticmethod
    def _save_workflow(db: sqlite3.Connection, view: WorkflowView) -> None:
        db.execute("UPDATE workflows SET payload=? WHERE id=?", (view.model_dump_json(), view.workflow_id))

    def _workflow_parent(self, db: sqlite3.Connection, request_id: str) -> WorkflowView | None:
        row = db.execute("SELECT payload FROM workflows WHERE parent_id=?", (request_id,)).fetchone()
        if row is None:
            return None
        return WorkflowView.model_validate_json(row[0])

    def _mark_workflow_cancelled(self, db: sqlite3.Connection, request_id: str) -> None:
        view = self._workflow_parent(db, request_id)
        if view is None or view.stage == "cancelled":
            return
        self._save_workflow(db, view.model_copy(update={"stage": "cancelled"}))

    def _finish_workflow_parent(self, db: sqlite3.Connection, c: Changes, request_id: str) -> None:
        view = self._workflow_parent(db, request_id)
        if view is None or view.stage not in {"passed", "exhausted", "cancelled"}:
            return
        parent = self._request(db, view.parent_id)
        if parent.decision or parent.status in TERMINAL:
            return
        if any(self._request(db, child.request_id).status not in TERMINAL for child in view.children):
            return
        if view.stage == "passed":
            decision = Decision(status="succeeded", answer="workflow_passed")
        elif view.stage == "exhausted":
            decision = Decision(status="failed", error="workflow_exhausted")
        else:
            decision = Decision(status="cancelled")
        self._decide(db, c, parent, decision)
        self._settle(db, c, parent)

    def _park_or_settle_workflow(self, db: sqlite3.Connection, c: Changes, request: Receipt,
                                 view: WorkflowView) -> Action:
        if view.stage in {"passed", "exhausted", "cancelled"} and all(
                self._request(db, child.request_id).status in TERMINAL for child in view.children):
            self._finish_workflow_parent(db, c, request.request_id)
            return Continue()
        return Park("children")

    def _add_workflow_child(self, db: sqlite3.Connection, c: Changes, view: WorkflowView, *,
                            role: Literal["check", "correction"], text: str, child_id: str) -> WorkflowView:
        if len(self._pending_ids(db)) + 1 > PENDING_LIMIT:
            raise BackendError("queue_full", status=429)
        self._new_request(db, c, Submit(request_id=child_id, text=text), parent_id=view.parent_id, depth=1)
        self._message(db, c, child_id, "input", Message(role="user", content=text))
        parent = self._request(db, view.parent_id)
        parent.children = [*parent.children, child_id]
        if parent.status not in TERMINAL and not parent.decision:
            parent.status = "waiting_children"
        self._save_request(db, c, parent)
        child = WorkflowChild(request_id=child_id, role=role, text=text, status="queued")
        return view.model_copy(update={"children": [*view.children, child]})

    async def open_workflow(self, workflow_id: str, check: str, correction_limit: int) -> WorkflowView:
        text = check.strip()
        if not text:
            raise BackendError("workflow_check_empty")
        if correction_limit < 0 or correction_limit > 8:
            raise BackendError("workflow_limit")

        def operation(db: sqlite3.Connection, c: Changes) -> WorkflowView:
            key = digest(workflow_body(text, correction_limit))
            row = db.execute("SELECT digest,payload FROM workflows WHERE id=?", (workflow_id,)).fetchone()
            if row:
                if str(row[0]) != key:
                    raise BackendError("workflow_conflict")
                return self._refresh_workflow(db, WorkflowView.model_validate_json(row[1]))
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            if self._meta(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            if len(self._pending_ids(db)) + 2 > PENDING_LIMIT:
                raise BackendError("queue_full", status=429)
            parent_id = digest(f"{self.session_id}:{workflow_id}:parent")
            child_id = digest(f"{self.session_id}:{workflow_id}:check")
            parent = self._new_request(db, c, Submit(request_id=parent_id, text=f"工作流 {workflow_id}"))
            self._new_request(db, c, Submit(request_id=child_id, text=text), parent_id=parent_id, depth=1)
            self._message(db, c, child_id, "input", Message(role="user", content=text))
            parent.children = [child_id]
            parent.status = "waiting_children"
            self._save_request(db, c, parent)
            view = WorkflowView(
                workflow_id=workflow_id, session_id=self.session_id, stage="check",
                correction_limit=correction_limit, attempts=0, parent_id=parent_id,
                parent_status="waiting_children", check=text,
                children=[WorkflowChild(request_id=child_id, role="check", text=text, status="queued")])
            db.execute("INSERT INTO workflows(id,digest,parent_id,payload) VALUES(?,?,?,?)",
                       (workflow_id, key, parent_id, view.model_dump_json()))
            return view
        return await self._tx(operation)

    async def workflow(self, workflow_id: str) -> WorkflowView:
        def operation(db: sqlite3.Connection) -> WorkflowView:
            return self._refresh_workflow(db, self._workflow_row(db, workflow_id)[1])
        return await self.db.call(operation)

    async def resume_workflow(self, workflow_id: str) -> WorkflowView:
        def operation(db: sqlite3.Connection, _c: Changes) -> WorkflowView:
            return self._refresh_workflow(db, self._workflow_row(db, workflow_id)[1])
        return await self._tx(operation)

    async def record_verdict(self, workflow_id: str, verdict_id: str, passed: bool) -> WorkflowView:
        def operation(db: sqlite3.Connection, c: Changes) -> WorkflowView:
            view = self._workflow_row(db, workflow_id)[1]
            key = digest(verdict_body(verdict_id, passed))
            existing = db.execute(
                "SELECT digest FROM workflow_verdicts WHERE workflow_id=? AND verdict_id=?",
                (workflow_id, verdict_id)).fetchone()
            if existing:
                if str(existing[0]) != key:
                    raise BackendError("verdict_conflict")
                return self._refresh_workflow(db, view)
            if view.stage in {"passed", "exhausted", "cancelled"}:
                raise BackendError("workflow_settled")
            if not passed:
                corrections = [child for child in view.children if child.role == "correction"]
                if corrections and self._request(db, corrections[-1].request_id).status not in TERMINAL:
                    raise BackendError("workflow_busy")
                if view.attempts >= view.correction_limit:
                    view = view.model_copy(update={"stage": "exhausted"})
                else:
                    attempt = view.attempts + 1
                    prompt = correction_text(attempt)
                    child_id = digest(f"{self.session_id}:{workflow_id}:correction:{attempt}")
                    view = self._add_workflow_child(
                        db, c, view, role="correction", text=prompt, child_id=child_id)
                    view = view.model_copy(update={"stage": "correction", "attempts": attempt})
            else:
                view = view.model_copy(update={"stage": "passed"})
            db.execute("INSERT INTO workflow_verdicts(workflow_id,verdict_id,digest,passed) VALUES(?,?,?,?)",
                       (workflow_id, verdict_id, key, int(passed)))
            self._save_workflow(db, view)
            self._finish_workflow_parent(db, c, view.parent_id)
            return self._refresh_workflow(db, view)
        return await self._tx(operation)

    async def cancel_workflow_child(self, workflow_id: str, request_id: str) -> WorkflowView:
        def operation(db: sqlite3.Connection, c: Changes) -> WorkflowView:
            view = self._workflow_row(db, workflow_id)[1]
            if not any(child.request_id == request_id for child in view.children):
                raise BackendError("workflow_child_mismatch")
            self._cancel_tree(db, c, request_id)
            return self._refresh_workflow(db, self._workflow_row(db, workflow_id)[1])
        return await self._tx(operation)

    def _web_policy(self, db: sqlite3.Connection) -> WebPolicy:
        row = db.execute("SELECT payload FROM web_policies WHERE id='policy'").fetchone()
        if row is None:
            return WebPolicy()
        return WebPolicy.model_validate_json(row[0])

    def _web_call(self, db: sqlite3.Connection, call_id: str) -> WebCallView:
        row = db.execute("SELECT payload FROM web_calls WHERE id=?", (call_id,)).fetchone()
        if row is None:
            raise BackendError("web_call_not_found", status=404)
        return WebCallView.model_validate_json(row[0])

    async def web_policy(self) -> WebPolicy:
        return await self.db.call(self._web_policy)

    async def save_web_policy(self, value: WebPolicy) -> WebPolicy:
        def operation(db: sqlite3.Connection, _changes: Changes) -> WebPolicy:
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            payload = value.model_dump_json()
            db.execute(
                "INSERT INTO web_policies(id,digest,payload) VALUES('policy',?,?) "
                "ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,payload=excluded.payload",
                (digest(payload), payload))
            return value
        return await self._tx(operation)

    async def begin_web_call(self, call_id: str, kind: Literal["search", "fetch"], body: str) -> tuple[WebCallView, bool]:
        """Reserve one paid call. An existing row is returned and must not be sent again."""
        def operation(db: sqlite3.Connection, _changes: Changes) -> tuple[WebCallView, bool]:
            key = digest(body)
            row = db.execute("SELECT digest,payload FROM web_calls WHERE id=?", (call_id,)).fetchone()
            if row:
                if str(row[0]) != key:
                    raise BackendError("web_call_conflict")
                return WebCallView.model_validate_json(row[1]), False
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            view = WebCallView(call_id=call_id, session_id=self.session_id, kind=kind, phase="unknown")
            db.execute("INSERT INTO web_calls(id,digest,payload) VALUES(?,?,?)",
                       (call_id, key, view.model_dump_json()))
            return view, True
        return await self._tx(operation)

    async def settle_web_call(self, call_id: str, phase: Literal["unknown", "done", "failed"],
                              error: str, result: str) -> WebCallView:
        def operation(db: sqlite3.Connection, _changes: Changes) -> WebCallView:
            current = self._web_call(db, call_id)
            if current.phase != "unknown":
                return current
            current.phase = phase
            current.error = error
            current.result = result
            db.execute("UPDATE web_calls SET payload=? WHERE id=? AND json_extract(payload,'$.phase')='unknown'",
                       (current.model_dump_json(), call_id))
            return self._web_call(db, call_id)
        return await self._tx(operation)

    def _computer_policy(self, db: sqlite3.Connection) -> ComputerPolicy:
        row = db.execute("SELECT payload FROM computer_policies WHERE id='policy'").fetchone()
        if row is None:
            return ComputerPolicy()
        return ComputerPolicy.model_validate_json(row[0])

    def _computer_runtime(self, db: sqlite3.Connection) -> tuple[bool, int | None, str]:
        row = db.execute("SELECT blocked,exit_code,proof FROM computer_runtime WHERE id='current'").fetchone()
        if row is None:
            return False, None, ""
        exit_code = None if row[1] is None else int(row[1])
        return bool(row[0]), exit_code, str(row[2])

    async def computer_policy(self) -> ComputerPolicy:
        return await self.db.call(self._computer_policy)

    async def save_computer_policy(self, value: ComputerPolicy) -> ComputerPolicy:
        def operation(db: sqlite3.Connection, _changes: Changes) -> ComputerPolicy:
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            db.execute(
                "INSERT INTO computer_policies(id,payload) VALUES('policy',?) "
                "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                (value.model_dump_json(),))
            return value
        return await self._tx(operation)

    async def computer_blocked(self) -> bool:
        blocked, _exit, _proof = await self.db.call(self._computer_runtime)
        return blocked

    async def computer_runtime(self) -> tuple[bool, int | None, str]:
        return await self.db.call(self._computer_runtime)

    async def note_computer_exit(self, exit_code: int | None) -> None:
        def operation(db: sqlite3.Connection, _changes: Changes) -> None:
            _blocked, previous, proof = self._computer_runtime(db)
            code = previous if exit_code is None else exit_code
            db.execute(
                "INSERT INTO computer_runtime(id,blocked,exit_code,proof) VALUES('current',1,?,?) "
                "ON CONFLICT(id) DO UPDATE SET blocked=1,exit_code=excluded.exit_code,proof=computer_runtime.proof",
                (code, proof))
        await self._tx(operation)

    async def finish_computer_cleanup(self, proof: str) -> str:
        def operation(db: sqlite3.Connection, _changes: Changes) -> str:
            blocked, exit_code, existing = self._computer_runtime(db)
            if not blocked:
                return existing
            if exit_code is None or not proof:
                raise BackendError("computer_exit_unproven")
            db.execute("UPDATE computer_runtime SET blocked=0,proof=? WHERE id='current'", (proof,))
            return proof
        return await self._tx(operation)

    async def save_computer_capture(self, value: ComputerCaptureView) -> ComputerCaptureView:
        def operation(db: sqlite3.Connection, _changes: Changes) -> ComputerCaptureView:
            db.execute("INSERT INTO computer_captures(id,observed_ms,payload) VALUES(?,?,?)",
                       (value.capture_id, value.observed_ms, value.model_dump_json()))
            return value
        return await self._tx(operation)

    async def latest_computer_capture(self) -> ComputerCaptureView | None:
        def operation(db: sqlite3.Connection) -> ComputerCaptureView | None:
            row = db.execute("SELECT payload FROM computer_captures ORDER BY ordinal DESC LIMIT 1").fetchone()
            if row is None:
                return None
            return ComputerCaptureView.model_validate_json(row[0])
        return await self.db.call(operation)

    async def find_computer_action(self, action_id: str, body: str) -> ComputerActionView | None:
        def operation(db: sqlite3.Connection) -> ComputerActionView | None:
            row = db.execute("SELECT digest,payload FROM computer_actions WHERE id=?", (action_id,)).fetchone()
            if row is None:
                return None
            if str(row[0]) != digest(body):
                raise BackendError("computer_action_conflict")
            return ComputerActionView.model_validate_json(row[1])
        return await self.db.call(operation)

    async def begin_computer_action(self, action_id: str, body: str) -> tuple[ComputerActionView, bool]:
        def operation(db: sqlite3.Connection, _changes: Changes) -> tuple[ComputerActionView, bool]:
            blocked, _exit, _proof = self._computer_runtime(db)
            key = digest(body)
            row = db.execute("SELECT digest,payload FROM computer_actions WHERE id=?", (action_id,)).fetchone()
            if row:
                if str(row[0]) != key:
                    raise BackendError("computer_action_conflict")
                return ComputerActionView.model_validate_json(row[1]), False
            if blocked:
                raise BackendError("computer_blocked")
            view = ComputerActionView(action_id=action_id, session_id=self.session_id, phase="unknown")
            db.execute("INSERT INTO computer_actions(id,digest,payload) VALUES(?,?,?)",
                       (action_id, key, view.model_dump_json()))
            return view, True
        return await self._tx(operation)

    async def settle_computer_action(self, action_id: str, phase: Literal["unknown", "done", "failed"],
                                     error: str, driver_x: int | None, driver_y: int | None) -> ComputerActionView:
        def operation(db: sqlite3.Connection, _changes: Changes) -> ComputerActionView:
            row = db.execute("SELECT payload FROM computer_actions WHERE id=?", (action_id,)).fetchone()
            if row is None:
                raise BackendError("computer_action_missing", status=404)
            current = ComputerActionView.model_validate_json(row[0])
            if current.phase != "unknown":
                return current
            current.phase = phase
            current.error = error
            current.driver_x = driver_x
            current.driver_y = driver_y
            db.execute(
                "UPDATE computer_actions SET payload=? WHERE id=? AND json_extract(payload,'$.phase')='unknown'",
                (current.model_dump_json(), action_id))
            return current
        return await self._tx(operation)

    def _cancel_tree(self, db: sqlite3.Connection, c: Changes, request_id: str) -> None:
        descendants = {request_id}
        all_requests = self._requests(db)
        for _ in range(6):
            descendants.update(r.request_id for r in all_requests if r.parent_id in descendants)
        for r in all_requests:
            if r.request_id not in descendants or r.status in TERMINAL or r.decision or r.cancel_requested:
                continue
            r.cancel_requested = True
            self._expire_approvals(db, c, r.request_id)
            if r.status in {"queued", "waiting_time"} or r.kind == "steer":
                self._decide(db, c, r, Decision(status="cancelled"))
                self._settle(db, c, r)
            else:
                r.status = "cancelling"
                self._save_request(db, c, r)
        self._mark_workflow_cancelled(db, request_id)

    async def cancel(self, request_id: str, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            self._fence(db, fence)
            if (not db.execute("SELECT 1 FROM requests WHERE id=?", (request_id,)).fetchone()
                    and not db.execute("SELECT 1 FROM cancellations WHERE id=?", (request_id,)).fetchone()):
                tombstone = Receipt(request_id=request_id, run_id=request_id, text="", status="cancelled",
                                    cancel_requested=True, decision=Decision(status="cancelled"),
                                    accepted_revision=str(c.seq), revision=str(c.seq))
                db.execute("INSERT INTO cancellations VALUES(?,?)", (request_id, tombstone.model_dump_json()))
                c.emit("status", request_id, "cancel_tombstone", receipt=tombstone)
            self._cancel_tree(db, c, request_id)
            self._finish_workflow_parent(db, c, request_id)
            row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
            return Receipt.model_validate_json(row[0] if row else db.execute(
                "SELECT payload FROM cancellations WHERE id=?", (request_id,)).fetchone()[0])
        return await self._tx(operation)

    @staticmethod
    def _expire_approvals(db: sqlite3.Connection, c: Changes, request_id: str) -> None:
        for row in db.execute("SELECT payload FROM approvals WHERE request_id=?", (request_id,)).fetchall():
            approval = Approval.model_validate_json(row[0])
            if approval.state in {"pending", "approved"}:
                approval.state = "expired"
                db.execute("UPDATE approvals SET payload=? WHERE id=?", (approval.model_dump_json(), approval.approval_id))
                c.emit("approval", request_id, "expired", approval=approval)

    def _binding(self, db: sqlite3.Connection, request_id: str, call: ToolCall) -> str:
        pending_steer = [r.model_dump_json() for r in self._requests(db)
                         if r.kind == "steer" and r.parent_id == request_id and r.status not in TERMINAL]
        context = [m.model_dump_json() for m in self._messages(db, request_id)]
        arguments: object = json.loads(normalized_call(call).arguments)
        return digest(json.dumps({"call": call.name, "arguments": arguments, "context": context,
                                  "steer": pending_steer, "policy": self.approval_policy, "build": self.build,
                                  "run": request_id}, sort_keys=True, ensure_ascii=False))

    async def approve(self, value: ApprovalDecision, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            self._fence(db, fence)
            old = db.execute("SELECT digest,request_id FROM decisions WHERE id=?", (value.decision_id,)).fetchone()
            key = digest(value.model_dump_json())
            if old:
                if old[0] != key:
                    raise BackendError("approval_decision_conflict")
                return self._request(db, old[1])
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            if self._meta(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            row = db.execute("SELECT payload FROM approvals WHERE id=?", (value.approval_id,)).fetchone()
            if not row:
                raise BackendError("approval_not_found", status=404)
            approval = Approval.model_validate_json(row[0])
            request = self._request(db, approval.request_id)
            if (approval.state != "pending" or approval.build_id != self.build or request.cancel_requested
                    or request.decision or approval.revision != value.expected_revision
                    or approval.proposal_digest != value.proposal_digest
                    or self._binding(db, request.request_id, approval.call) != approval.proposal_digest):
                raise BackendError("stale_approval")
            approval.state = "approved" if value.approve else "denied"
            db.execute("UPDATE approvals SET payload=? WHERE id=?", (approval.model_dump_json(), approval.approval_id))
            db.execute("INSERT INTO decisions VALUES(?,?,?)", (value.decision_id, key, request.request_id))
            c.emit("approval", request.request_id, approval.state, approval=approval)
            c.hit("approval", request.request_id, approval.call_id)
            return request
        return await self._tx(operation)

    async def resolve(self, value: EffectResolution, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            self._fence(db, fence)
            row = db.execute("SELECT digest,request_id FROM resolutions WHERE id=? OR json_extract(payload,'$.call_id')=?",
                             (value.resolution_id, value.call_id)).fetchone()
            key = digest(value.model_dump_json())
            if row:
                if row[0] != key:
                    raise BackendError("resolution_conflict")
                return self._request(db, row[1])
            if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                raise BackendError("worker_frozen")
            if self._meta(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            row = db.execute("SELECT payload FROM effects WHERE id=?", (value.call_id,)).fetchone()
            if not row:
                raise BackendError("effect_not_found", status=404)
            hold = EffectHold.model_validate_json(row[0])
            if hold.reconciled:
                raise BackendError("resolution_conflict")
            if not hold.resource_clean:
                raise BackendError("execution_cleanup_pending")
            db.execute("INSERT INTO resolutions(id,digest,request_id,payload) VALUES(?,?,?,?)",
                       (value.resolution_id, key, hold.request_id, value.model_dump_json()))
            c.emit("effect", hold.request_id, value.model_dump_json())
            return self._request(db, hold.request_id)
        return await self._tx(operation)

    async def recover(self, *, frozen: bool = False, initial_cleanup: Cleanup | None = None,
                      validation: bool = False) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            if initial_cleanup and (initial_cleanup.session_id != self.session_id
                                    or initial_cleanup.state != "clean" or not initial_cleanup.proof_id):
                raise BackendError("cleanup_identity_mismatch")
            if self._meta(db, "driver_id") != self.instance:
                self._set_meta(db, "stopping", "")
                if initial_cleanup and initial_cleanup.state == "clean" and initial_cleanup.proof_id:
                    self._set_meta(db, "blocked", "")
                self._set_meta(db, "driver_id", self.instance)
                self._set_meta(db, "execution_epoch", "0")
            if initial_cleanup:
                self._set_meta(db, "execution_epoch", str(initial_cleanup.execution_epoch))
            if frozen and not self._meta(db, "freeze_id"):
                self._set_meta(db, "freeze_id", "startup")
                c.emit("freeze", text="startup")
            if validation:
                return
            db.execute("DELETE FROM previews")
            for r in self._requests(db):
                if r.status in TERMINAL or r.kind == "steer":
                    continue
                r.generation += 1
                self._save_request(db, c, r)
                run = self._run(db, r.request_id)
                run.opening = False
                if run.lease:
                    run.cleanup_required = True
                self._save_run(db, run)
                for step in self._steps(db, r.request_id):
                    if step.kind == "model" and step.phase == "intent":
                        step.phase = "unknown"
                        self._save_step(db, step)
                        self._decide(db, c, r, Decision(status="unknown", error="model_outcome_unknown"))
                for row in db.execute("SELECT payload FROM approvals WHERE request_id=?", (r.request_id,)).fetchall():
                    approval = Approval.model_validate_json(row[0])
                    if approval.state in {"pending", "approved"} and (
                        approval.build_id != self.build or approval.proposal_digest != self._binding(db, r.request_id, approval.call)
                    ):
                        self._expire_approvals(db, c, r.request_id)
                        break
        await self._tx(operation)

    def _decide(self, db: sqlite3.Connection, c: Changes, request: Receipt, decision: Decision) -> None:
        if request.decision:
            return
        request.decision, request.status = decision, "cleaning"
        request.answer, request.error = decision.answer, decision.error
        self._expire_approvals(db, c, request.request_id)
        db.execute("DELETE FROM previews WHERE request_id=?", (request.request_id,))
        self._save_request(db, c, request)
        c.hit("decision", request.request_id)
        if decision.status != "succeeded":
            for child in self._requests(db):
                if child.parent_id == request.request_id and child.kind == "child" and child.status not in TERMINAL:
                    self._cancel_tree(db, c, child.request_id)
        for r in self._requests(db):
            if r.parent_id == request.request_id and r.kind == "steer" and r.status not in TERMINAL:
                self._decide(db, c, r, Decision(status="interrupted", error="target_settled"))
                self._settle(db, c, r)

    def _settle(self, db: sqlite3.Connection, c: Changes, request: Receipt) -> None:
        assert request.decision is not None
        if request.kind != "steer":
            run = self._run(db, request.request_id)
            if run.lease or run.opening or any(
                r.parent_id == request.request_id and r.kind == "child" and r.status not in TERMINAL
                for r in self._requests(db)
            ):
                raise BackendError("settlement_pending")
        request.status = request.decision.status
        self._save_request(db, c, request)

    def _payloads(self, db: sqlite3.Connection, request_id: str) -> list[str]:
        return [str(row[0]) for row in db.execute(
            "SELECT payload FROM messages WHERE request_id=? ORDER BY ordinal", (request_id,))]

    def _match_compaction(self, db: sqlite3.Connection, payloads: list[str]) -> Compaction | None:
        best: Compaction | None = None
        for row in db.execute("SELECT payload FROM compactions"):
            record = Compaction.model_validate_json(row[0])
            if record.message_count > len(payloads):
                continue
            if compaction_basis(payloads[:record.message_count]) != record.basis:
                continue
            if best is None or record.message_count > best.message_count:
                best = record
        return best

    def _active_summary(self, db: sqlite3.Connection) -> str:
        previous = db.execute(
            "SELECT id FROM requests WHERE kind='root' AND status='succeeded' ORDER BY ordinal DESC LIMIT 1").fetchone()
        if previous is None:
            return ""
        matched = self._match_compaction(db, self._payloads(db, str(previous[0])))
        return matched.summary if matched else ""

    def _claim(self, db: sqlite3.Connection, c: Changes, request: Receipt) -> None:
        if request.kind == "root":
            previous = db.execute("SELECT id FROM requests WHERE kind='root' AND status='succeeded' ORDER BY ordinal DESC LIMIT 1").fetchone()
            if previous:
                payloads = self._payloads(db, str(previous[0]))
                matched = self._match_compaction(db, payloads)
                if matched is None:
                    history = payloads
                else:
                    self._message(db, c, request.request_id, "compaction",
                                  Message(role="user", content=matched.summary))
                    history = payloads[matched.message_count:]
                for index, payload in enumerate(history):
                    self._message(db, c, request.request_id, f"history:{index}", Message.model_validate_json(payload))
        self._message(db, c, request.request_id, "input", Message(role="user", content=request.text))
        request.status = "running"
        request.generation += 1
        self._save_request(db, c, request)
        c.hit("claimed", request.request_id)

    def _grant(self, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> bool:
        assert step.call is not None
        binding = self._binding(db, request.request_id, step.call)
        required = self.approval_policy == "all" or (
            self.approval_policy == "mutations" and step.call.name in {"shell", "write_file"})
        if not required:
            return True
        approval: Approval | None = None
        if step.approval_id:
            row = db.execute("SELECT payload FROM approvals WHERE id=?", (step.approval_id,)).fetchone()
            approval = Approval.model_validate_json(row[0]) if row else None
        if approval and (approval.proposal_digest != binding or approval.build_id != self.build):
            self._expire_approvals(db, c, request.request_id)
            approval = None
        if approval and approval.state == "denied":
            self._decide(db, c, request, Decision(status="failed", error="approval_denied"))
            return False
        if approval and approval.state in {"approved", "consumed"}:
            # Consume in the same transaction that creates an execution/delegation intent.
            return True
        if approval is None or approval.state == "expired":
            approval = Approval(approval_id=digest(step.step_id + binding + str(c.seq)), request_id=request.request_id,
                                run_id=request.run_id, call_id=step.step_id, call=step.call, build_id=self.build,
                                proposal_digest=binding, revision=str(c.seq), state="pending")
            step.approval_id, step.proposal_digest = approval.approval_id, binding
            self._save_step(db, step)
            db.execute("INSERT INTO approvals VALUES(?,?,?)", (approval.approval_id, request.request_id, approval.model_dump_json()))
            c.emit("approval", request.request_id, "pending", approval=approval)
            c.hit("approval", request.request_id, step.step_id)
        if request.status != "waiting_approval":
            request.status = "waiting_approval"
            self._save_request(db, c, request)
        return False

    @staticmethod
    def _consume(db: sqlite3.Connection, c: Changes, step: Step) -> None:
        if step.approval_id:
            approval = Approval.model_validate_json(db.execute("SELECT payload FROM approvals WHERE id=?", (step.approval_id,)).fetchone()[0])
            approval.state = "consumed"
            db.execute("UPDATE approvals SET payload=? WHERE id=?", (approval.model_dump_json(), approval.approval_id))
            c.emit("approval", step.request_id, "consumed", approval=approval)

    def _materialize(self, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> None:
        if step.kind == "model":
            completion = Completion.model_validate_json(step.result)
            message = completion.message
            message.provider_response_id = completion.response_id
            self._message(db, c, request.request_id, step.step_id, message)
            previous = db.execute("SELECT payload FROM previews WHERE request_id=?", (request.request_id,)).fetchone()
            if previous:
                c.events[-1].preview = Preview.model_validate_json(previous[0])
                db.execute("DELETE FROM previews WHERE request_id=?", (request.request_id,))
            if not message.tool_calls:
                if not any(r.kind == "steer" and r.parent_id == request.request_id and r.status not in TERMINAL
                           for r in self._requests(db)):
                    self._decide(db, c, request, Decision(status="succeeded", answer=message.content))
            else:
                for i, call in enumerate(message.tool_calls):
                    call = normalized_call(call)
                    tool_id = digest(f"{self.session_id}:{step.step_id}:{i}:{call.id}")
                    self._save_step(db, Step(step_id=tool_id, request_id=request.request_id,
                                            ordinal=step.ordinal + i + 1, kind="tool", phase="proposed",
                                            generation=request.generation, call=call))
        else:
            assert step.call is not None
            self._message(db, c, request.request_id, step.step_id,
                          Message(role="tool", content=step.result, tool_call_id=step.call.id))
        step.phase = "applied"
        self._save_step(db, step)

    def _delegate(self, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> None:
        assert step.call is not None
        tasks = DelegateTasks.model_validate_json(step.call.arguments)
        run = self._run(db, request.request_id)
        current = [r for r in self._requests(db) if r.parent_id == request.request_id and r.kind == "child"]
        if (run.depth >= 4 or len(current) + len(tasks.tasks) > 8
                or len(self._pending_ids(db)) + len(tasks.tasks) > PENDING_LIMIT):
            raise BackendError("child_capacity")
        for i, text in enumerate(tasks.tasks):
            child_id = digest(f"{step.step_id}:child:{i}")
            child = self._new_request(db, c, Submit(request_id=child_id, text=text),
                                      parent_id=request.request_id, depth=run.depth + 1)
            step.children.append(child.request_id)
            request.children.append(child.request_id)
        self._consume(db, c, step)
        step.phase = "children"
        self._save_step(db, step)
        request.status = "waiting_children"
        self._save_request(db, c, request, "children")

    def _join(self, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> bool:
        children = [self._request(db, key) for key in step.children]
        failures = [r for r in children if r.status in TERMINAL and r.status != "succeeded"]
        if failures:
            for child in children:
                if child.status not in TERMINAL:
                    self._cancel_tree(db, c, child.request_id)
        if any(r.status not in TERMINAL for r in children):
            return False
        step.result = json.dumps([{"request_id": r.request_id, "status": r.status,
                                   "answer": r.answer[:8000], "error": r.error} for r in children], ensure_ascii=False)
        step.phase = "result"
        self._save_step(db, step)
        c.emit("children", request.request_id, step.result)
        c.hit("child_join", request.request_id, step.step_id)
        request.status = "running"
        self._save_request(db, c, request)
        if failures:
            self._decide(db, c, request, Decision(status="unknown" if any(r.status == "unknown" for r in failures) else "failed",
                                                 error="required_child_failed"))
        return True

    def _advance_request(self, db: sqlite3.Connection, c: Changes, request: Receipt) -> Action:
        run = self._run(db, request.request_id)
        steps = self._steps(db, request.request_id)
        for step in steps:
            web_intent = step.kind == "tool" and step.phase == "intent" and step.call and step.call.name in {
                "web_search", "web_fetch"}
            if web_intent:
                row = db.execute("SELECT payload FROM web_calls WHERE id=?", (step.step_id,)).fetchone()
                if row:
                    held = WebCallView.model_validate_json(row[0])
                    if held.phase == "unknown":
                        step.phase = "unknown"
                        self._save_step(db, step)
                        self._decide(db, c, request, Decision(
                            status="cancelled" if request.cancel_requested else "unknown",
                            error=held.error or "web_transport"))
                        c.emit("tool", request.request_id, held.error or "web_transport")
                        return Continue()
                if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
                    return Park("frozen")
                if request.cancel_requested and not request.decision:
                    self._decide(db, c, request, Decision(status="cancelled"))
                    return Continue()
                assert step.call is not None
                return WebRetrieval(step.step_id, request.request_id, request.generation, step.call)
            if step.kind == "tool" and step.phase == "intent":
                return QueryTool(step.step_id, request.request_id, request.generation)
        if request.cancel_requested and not request.decision:
            for child in self._requests(db):
                if child.parent_id == request.request_id and child.status not in TERMINAL:
                    return Park("children")
            self._decide(db, c, request, Decision(status="cancelled"))
            return Continue()
        if request.decision:
            if run.lease:
                return CloseEpoch(request.request_id, run.lease)
            if any(r.parent_id == request.request_id and r.kind == "child" and r.status not in TERMINAL
                   for r in self._requests(db)):
                return Park("children")
            self._settle(db, c, request)
            return Continue()
        if run.cleanup_required and run.lease:
            return CloseEpoch(request.request_id, run.lease)
        if self._meta(db, "freeze_id") or self._meta(db, "stopping"):
            if run.lease:
                return CloseEpoch(request.request_id, run.lease)
            return Park("frozen")
        if request.status in {"queued", "waiting_time"}:
            if request.not_before_ms > now_ms():
                return Park("time", request.not_before_ms)
            self._claim(db, c, request)
            return Continue()
        for step in steps:
            if step.phase == "result":
                self._materialize(db, c, request, step)
                return Continue()
            if step.phase == "children":
                if run.lease:
                    return CloseEpoch(request.request_id, run.lease)
                if self._join(db, c, request, step):
                    return Continue()
                return Park("children")
            if step.phase == "proposed":
                if not self._grant(db, c, request, step):
                    if request.decision:
                        return Continue()
                    if run.lease:
                        return CloseEpoch(request.request_id, run.lease)
                    return Park("approval")
                assert step.call is not None
                if request.status != "running":
                    request.status = "running"
                    self._save_request(db, c, request)
                if step.call.name == "delegate_task":
                    self._delegate(db, c, request, step)
                    return Continue()
                if step.call.name in {"web_search", "web_fetch"}:
                    # The call id is the step id. No epoch: the supervisor cannot prove a paid HTTP call.
                    self._consume(db, c, step)
                    step.phase, step.generation = "intent", request.generation
                    self._save_step(db, step)
                    request.status = "running"
                    self._save_request(db, c, request)
                    c.emit("tool", request.request_id, step.model_dump_json())
                    c.hit("web_intent", request.request_id, step.step_id)
                    return WebRetrieval(step.step_id, request.request_id, request.generation, step.call)
                if not run.lease:
                    run.opening = True
                    self._save_run(db, run)
                    c.emit("cleanup", request.request_id, "epoch_open_intent")
                    return OpenEpoch(request.request_id)
                self._consume(db, c, step)
                step.phase, step.generation = "intent", request.generation
                self._save_step(db, step)
                request.status = "running"
                self._save_request(db, c, request)
                c.emit("tool", request.request_id, step.model_dump_json())
                c.hit("tool_intent", request.request_id, step.step_id)
                return ToolInvocation(step.step_id, request.request_id, request.generation, run.lease, step.call)
            if step.kind == "model" and step.phase == "intent":
                self._decide(db, c, request, Decision(status="unknown", error="model_outcome_unknown"))
                return Continue()
        if run.lease:
            return CloseEpoch(request.request_id, run.lease)
        # A workflow parent waits for an independent verdict. It must not claim and copy session history.
        held = self._workflow_parent(db, request.request_id)
        if held is not None and not request.decision:
            return self._park_or_settle_workflow(db, c, request, held)
        if len([s for s in steps if s.kind == "model"]) >= 32:
            self._decide(db, c, request, Decision(status="failed", error="model_round_limit"))
            return Continue()
        for steer in self._requests(db):
            if steer.kind == "steer" and steer.parent_id == request.request_id and steer.status not in TERMINAL:
                self._message(db, c, request.request_id, "steer:" + steer.request_id, Message(role="user", content=steer.text))
                self._decide(db, c, steer, Decision(status="succeeded", answer="steering_applied"))
                self._settle(db, c, steer)
        ordinal = max((s.ordinal for s in steps), default=0) + 1
        step_id = digest(f"{self.session_id}:{request.request_id}:model:{ordinal}")
        step = Step(step_id=step_id, request_id=request.request_id, ordinal=ordinal, kind="model",
                    phase="intent", generation=request.generation)
        self._save_step(db, step)
        request.status = "running"
        self._save_request(db, c, request)
        c.emit("tool", request.request_id, step.model_dump_json())
        c.hit("model_intent", request.request_id, step_id)
        return ModelInvocation(step_id, request.request_id, request.generation,
                               self._messages(db, request.request_id), run.config)

    def _observe(self, db: sqlite3.Connection, c: Changes, observation: Observation) -> None:
        if isinstance(observation, EpochOpened):
            run = self._run(db, observation.request_id)
            if not run.opening or run.lease:
                raise BackendError("stale_epoch_result")
            lease = observation.lease
            if (lease.session_id != self.session_id or lease.worker_id != self.instance
                    or lease.build_id != self.build or not lease.supervisor_id
                    or lease.execution_epoch <= int(self._meta(db, "execution_epoch"))):
                raise BackendError("execution_lease_mismatch")
            run.lease, run.opening = observation.lease, False
            self._set_meta(db, "execution_epoch", str(observation.lease.execution_epoch))
            run.cleanup, run.cleanup_required = None, False
            self._save_run(db, run)
            c.emit("cleanup", run.request_id, run.lease.model_dump_json())
            return
        if isinstance(observation, EpochClosed):
            run = self._run(db, observation.request_id)
            if run.lease != observation.lease:
                raise BackendError("stale_cleanup_result")
            proof = observation.cleanup
            if proof.session_id != self.session_id or proof.execution_epoch != observation.lease.execution_epoch:
                raise BackendError("cleanup_identity_mismatch")
            if proof.state != "clean" or not proof.proof_id:
                self._set_meta(db, "blocked", proof.reason or "execution_cleanup_pending")
                c.emit("cleanup", run.request_id, proof.model_dump_json())
                return
            run.cleanup, run.lease, run.cleanup_required = proof, None, False
            self._save_run(db, run)
            for row in db.execute("SELECT payload FROM effects").fetchall():
                hold = EffectHold.model_validate_json(row[0])
                if hold.request_id == run.request_id:
                    hold.resource_clean = True
                    db.execute("UPDATE effects SET payload=? WHERE id=?", (hold.model_dump_json(), hold.call_id))
            c.emit("cleanup", run.request_id, proof.model_dump_json())
            c.hit("cleanup", run.request_id)
            return
        if isinstance(observation, EffectResolved):
            value, hold = observation.resolution, observation.hold
            if hold.call_id != value.call_id or hold.session_id != self.session_id or not hold.resource_clean or not hold.reconciled:
                raise BackendError("invalid_effect_resolution")
            row = db.execute("SELECT payload,request_id FROM resolutions WHERE id=?", (value.resolution_id,)).fetchone()
            if row is None or EffectResolution.model_validate_json(row[0]) != value or row[1] != hold.request_id:
                raise BackendError("stale_effect_resolution")
            db.execute("UPDATE resolutions SET result=? WHERE id=?", (hold.model_dump_json(), value.resolution_id))
            db.execute("UPDATE effects SET payload=? WHERE id=?", (hold.model_dump_json(), hold.call_id))
            c.emit("effect", hold.request_id, hold.model_dump_json())
            return
        if isinstance(observation, WebReturned):
            action = observation.invocation
            request = self._request(db, action.request_id)
            step = self._step(db, action.step_id)
            if (request.generation != action.generation or step.phase != "intent"
                    or step.request_id != request.request_id or step.call is None
                    or step.call.name not in {"web_search", "web_fetch"}):
                raise BackendError("stale_generation")
            if observation.phase == "refused":
                step.phase = "applied"
                self._save_step(db, step)
                self._decide(db, c, request, Decision(status="failed", error=observation.error or "web_disabled"))
                c.emit("tool", request.request_id, observation.error or "web_disabled")
                return
            if observation.phase == "unknown":
                step.phase = "unknown"
                self._save_step(db, step)
                self._decide(db, c, request, Decision(
                    status="cancelled" if request.cancel_requested else "unknown",
                    error=observation.error or "web_transport"))
                c.emit("tool", request.request_id, observation.error or "web_transport")
                return
            step.result = observation.result if observation.phase == "done" else observation.error
            step.phase = "result"
            self._save_step(db, step)
            c.emit("tool", request.request_id, step.model_dump_json())
            c.hit("web_result", request.request_id, step.step_id)
            return
        if isinstance(observation, Failed):
            action = observation.action
            if isinstance(action, (CloseEpoch, OpenEpoch, QueryTool, ReconcileEffect)):
                self._set_meta(db, "blocked", observation.error)
                c.emit("cleanup", action.request_id, observation.error)
                return
            if isinstance(action, (ModelInvocation, ToolInvocation, WebRetrieval)):
                request = self._request(db, action.request_id)
                step = self._step(db, action.step_id)
                if request.generation != action.generation or step.request_id != request.request_id or step.phase != "intent":
                    raise BackendError("stale_generation")
                if isinstance(action, ModelInvocation):
                    step.phase = "unknown"
                    self._save_step(db, step)
                    self._decide(db, c, request, Decision(status="cancelled" if request.cancel_requested else "unknown",
                                                         error=observation.error))
                elif isinstance(action, WebRetrieval):
                    row = db.execute("SELECT payload FROM web_calls WHERE id=?", (action.step_id,)).fetchone()
                    step.phase = "unknown"
                    self._save_step(db, step)
                    if row:
                        self._decide(db, c, request, Decision(status="unknown", error=observation.error or "web_transport"))
                    else:
                        self._decide(db, c, request, Decision(
                            status="cancelled" if request.cancel_requested else "failed", error=observation.error))
                # Tool failures are queried; a transport exception says nothing about effects.
                return
            raise BackendError("invalid_failed_action")
        action = observation.query if isinstance(observation, ToolObserved) else observation.invocation
        request = self._request(db, action.request_id)
        step = self._step(db, action.step_id)
        if (request.generation != action.generation or step.phase != "intent"
                or step.request_id != request.request_id):
            raise BackendError("stale_generation")
        if isinstance(observation, Previewed):
            preview = observation.preview
            if (preview.generation != request.generation or preview.run_id != request.run_id
                    or preview.request_id != request.request_id or request.cancel_requested or request.decision
                    or self._meta(db, "freeze_id") or self._meta(db, "stopping")):
                raise BackendError("stale_generation")
            row = db.execute("SELECT payload FROM previews WHERE request_id=?", (request.request_id,)).fetchone()
            if row and int(Preview.model_validate_json(row[0]).preview_seq) >= int(preview.preview_seq):
                return
            db.execute("INSERT INTO previews VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload",
                       (request.request_id, preview.model_dump_json()))
            c.emit("preview", request.request_id, preview=preview)
            return
        if isinstance(observation, ModelReturned):
            completion = observation.completion
            calls = completion.message.tool_calls
            if (completion.message.role != "assistant" or len(calls) > 16
                    or any(not call.id for call in calls) or len({call.id for call in calls}) != len(calls)):
                raise BackendError("invalid_tool_calls")
            step.result, step.phase = completion.model_dump_json(), "result"
            c.emit("tool", request.request_id, step.model_dump_json())
            c.hit("model_result", request.request_id, step.step_id)
        elif isinstance(observation, ToolReturned) or observation.observation.state == "completed":
            result = observation.result if isinstance(observation, ToolReturned) else observation.observation.result
            if result is None or result.call_id != step.step_id:
                raise BackendError("tool_result_identity_mismatch")
            step.result, step.phase = result.model_dump_json(), "result"
            c.emit("tool", request.request_id, step.model_dump_json())
            c.hit("tool_result", request.request_id, step.step_id)
        else:
            observed = observation.observation
            if observed.call_id != step.step_id:
                raise BackendError("tool_result_identity_mismatch")
            run = self._run(db, request.request_id)
            if observed.state == "pending" and run.lease:
                run.cleanup_required = True
                self._save_run(db, run)
                step.query_after_cleanup = True
            elif observed.state == "pending":
                self._set_meta(db, "blocked", "tool_pending_after_cleanup")
            else:
                step.phase = "unknown"
                if observed.state == "unknown" and step.call and step.call.name in {"shell", "write_file"}:
                    hold = EffectHold(call_id=step.step_id, session_id=self.session_id, request_id=request.request_id,
                                      reason="tool_outcome_unknown", resource_clean=observed.resource_clean)
                    db.execute("INSERT INTO effects VALUES(?,?) ON CONFLICT(id) DO NOTHING", (hold.call_id, hold.model_dump_json()))
                    c.emit("effect", request.request_id, hold.model_dump_json())
                if observed.state == "unknown" and not observed.resource_clean and not run.lease:
                    self._set_meta(db, "blocked", "execution_cleanup_pending")
                self._decide(db, c, request, Decision(status="cancelled" if request.cancel_requested else "unknown",
                                                     error="tool_outcome_unknown"))
            c.emit("tool", request.request_id, step.model_dump_json())
        self._save_step(db, step)

    async def advance(self, observation: Observation | None = None) -> Action:
        def operation(db: sqlite3.Connection, c: Changes) -> Action:
            if observation is not None:
                self._observe(db, c, observation)
                return Continue()
            if self._meta(db, "blocked"):
                return Park("blocked")
            resolution = db.execute("SELECT request_id,payload FROM resolutions WHERE result='' ORDER BY rowid LIMIT 1").fetchone()
            if resolution and not self._meta(db, "freeze_id") and not self._meta(db, "stopping"):
                return ReconcileEffect(resolution[0], EffectResolution.model_validate_json(resolution[1]))
            requests = [r for r in self._requests(db) if r.status not in TERMINAL and r.kind != "steer"]
            # Clean every owned lease before selecting more business work, including when frozen.
            for request in requests:
                run = self._run(db, request.request_id)
                if run.lease and (run.cleanup_required or request.decision or request.status in {"waiting_approval", "waiting_children"}
                                  or self._meta(db, "freeze_id") or self._meta(db, "stopping")):
                    return CloseEpoch(request.request_id, run.lease)
            for request in requests:
                if request.status == "waiting_children":
                    for step in self._steps(db, request.request_id):
                        if step.phase == "children" and any(
                            (child := self._request(db, key)).status in TERMINAL and child.status != "succeeded"
                            for key in step.children
                        ):
                            self._join(db, c, request, step)
                            if c.events:
                                return Continue()
            # Children are independent contexts, driven deepest first; root FIFO remains intact.
            active = [r for r in requests if r.status not in {"queued", "waiting_time"}]
            root = next((r for r in active if r.kind == "root"), None)
            candidates = requests
            if root:
                tree = {root.request_id}
                for _ in range(4):
                    tree.update(r.request_id for r in requests if r.parent_id in tree)
                candidates = [r for r in requests if r.request_id in tree]
            candidates.sort(key=lambda r: -self._run(db, r.request_id).depth)
            wake = min((r.not_before_ms for r in requests if r.not_before_ms > now_ms()), default=0)
            for request in candidates:
                db.execute("SAVEPOINT advance_request")
                event_count, hook_count = len(c.events), len(c.hooks)
                try:
                    action = self._advance_request(db, c, request)
                    db.execute("RELEASE advance_request")
                except (ValueError, BackendError) as exc:
                    db.execute("ROLLBACK TO advance_request")
                    db.execute("RELEASE advance_request")
                    del c.events[event_count:]
                    del c.hooks[hook_count:]
                    request = self._request(db, request.request_id)
                    self._decide(db, c, request, Decision(status="failed", error=exc.code if isinstance(exc, BackendError) else "invalid_tool_arguments"))
                    return Continue()
                if not isinstance(action, Park):
                    return action
                if action.reason in {"approval", "children"}:
                    return action
            return Park("frozen" if self._meta(db, "freeze_id") else "idle", wake)
        return await self._tx(operation)

    async def commit_compaction(self, compaction_id: str, through_request_id: str, summary: str, basis: str) -> Compaction:
        """Store a summary without deleting the messages it covers. A stale basis writes nothing."""
        def operation(db: sqlite3.Connection, c: Changes) -> Compaction:
            row = db.execute("SELECT payload FROM requests WHERE id=?", (through_request_id,)).fetchone()
            if row is None:
                raise BackendError("compaction_unsettled")
            receipt = Receipt.model_validate_json(row[0])
            payloads = self._payloads(db, through_request_id)
            if receipt.kind != "root" or receipt.status != "succeeded" or receipt.decision is None or not payloads:
                raise BackendError("compaction_unsettled")
            current = compaction_basis(payloads)
            if current != basis:
                raise BackendError("compaction_expired")
            record = Compaction(compaction_id=compaction_id, through_request_id=through_request_id, basis=current,
                                message_count=len(payloads), summary=summary)
            existing = db.execute("SELECT payload FROM compactions WHERE id=?", (compaction_id,)).fetchone()
            if existing:
                previous = Compaction.model_validate_json(existing[0])
                if previous != record:
                    raise BackendError("compaction_conflict")
                return previous
            db.execute("INSERT INTO compactions(id,basis,payload) VALUES(?,?,?)",
                       (compaction_id, current, record.model_dump_json()))
            c.emit("compaction", through_request_id, summary)
            return record
        return await self._tx(operation)

    async def freeze(self, fence: HostFence, freeze_id: str, *, cancel_work: bool = False) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            self._fence(db, fence)
            existing = self._meta(db, "freeze_id")
            if existing and existing not in {freeze_id, "startup"}:
                raise BackendError("freeze_conflict")
            if not freeze_id:
                raise BackendError("invalid_freeze_id")
            self._set_meta(db, "freeze_id", freeze_id)
            c.emit("freeze", text=freeze_id)
            if cancel_work:
                for r in self._requests(db):
                    if r.kind == "root" and r.status not in TERMINAL:
                        self._cancel_tree(db, c, r.request_id)
        await self._tx(operation)

    async def thaw(self, fence: HostFence, freeze_id: str) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            self._fence(db, fence)
            if self._meta(db, "freeze_id") != freeze_id or not freeze_id:
                raise BackendError("freeze_conflict")
            if self._meta(db, "blocked") or self._meta(db, "stopping"):
                raise BackendError("worker_blocked")
            self._set_meta(db, "freeze_id", "")
            c.emit("freeze", text="thawed:" + freeze_id)
        await self._tx(operation)

    async def stopping(self, fence: HostFence, execution_epoch: int | None = None, *,
                       cancel_work: bool = True) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            self._fence(db, fence)
            if execution_epoch is not None and execution_epoch != int(self._meta(db, "execution_epoch")):
                raise BackendError("stale_execution_epoch")
            self._set_meta(db, "stopping", "1")
            c.emit("status", text="stopping")
            if cancel_work:
                for r in self._requests(db):
                    if r.kind == "root" and r.status not in TERMINAL:
                        self._cancel_tree(db, c, r.request_id)
        await self._tx(operation)

    async def block(self, reason: str) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            self._set_meta(db, "blocked", reason)
            c.emit("status", text="blocked:" + reason)
        await self._tx(operation)

    def _activity(self, db: sqlite3.Connection) -> WorkerActivity:
        terminal = ",".join("?" for _ in TERMINAL)
        requests = [Receipt.model_validate_json(r[0]) for r in db.execute(
            f"SELECT payload FROM requests WHERE status NOT IN ({terminal})", tuple(TERMINAL))]
        resolutions = db.execute("SELECT count(*) FROM resolutions WHERE result=''").fetchone()[0]
        due = min((r.not_before_ms for r in requests if r.not_before_ms > now_ms()), default=0)
        state: WorkerState = "blocked" if self._meta(db, "blocked") else (
            "stopping" if self._meta(db, "stopping") else "frozen" if self._meta(db, "freeze_id") else "ready")
        runnable = state == "ready" and (resolutions > 0 or any(
            r.kind != "steer" and r.status not in {"waiting_approval", "waiting_children"} and r.not_before_ms <= now_ms()
            for r in requests))
        return WorkerActivity(pending=len(self._pending_ids(db)),
                              runnable=runnable, next_wake_ms=due, state=state)

    async def activity(self) -> WorkerActivity:
        return await self.db.call(self._activity)

    async def messages(self, request_id: str) -> list[Message]:
        return await self.db.call(lambda db: self._messages(db, request_id))

    async def message_payloads(self, request_id: str) -> list[str]:
        return await self.db.call(lambda db: self._payloads(db, request_id))

    def _transcript(self, db: sqlite3.Connection) -> list[tuple[str, str, str]]:
        rows = db.execute(
            "SELECT m.request_id, m.payload FROM messages m JOIN requests r ON r.id=m.request_id "
            "ORDER BY r.ordinal, m.ordinal").fetchall()
        result: list[tuple[str, str, str]] = []
        for request_id, payload in rows:
            message = Message.model_validate_json(payload)
            result.append((str(request_id), message.role, message.content))
        return result

    async def transcript(self) -> list[tuple[str, str, str]]:
        return await self.db.call(self._transcript)

    async def import_transcript(self, messages: list[tuple[str, str, str]]) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            existing = self._transcript(db)
            if existing:
                if existing != messages:
                    raise BackendError("import_conflict")
                return
            grouped: dict[str, list[tuple[str, str]]] = {}
            order: list[str] = []
            for request_id, role, content in messages:
                if request_id not in grouped:
                    order.append(request_id)
                    grouped[request_id] = []
                grouped[request_id].append((role, content))
            for request_id in order:
                items = grouped[request_id]
                text = next((content for role, content in items if role == "user"), items[0][1])
                receipt = self._new_request(db, c, Submit(request_id=request_id, text=text[:16000]))
                for index, (role, content) in enumerate(items):
                    message = Message.model_validate({"role": role, "content": content})
                    self._message(db, c, request_id, f"import:{index}", message)
                self._decide(db, c, receipt, Decision(status="succeeded", answer=""))
                self._settle(db, c, receipt)
        await self._tx(operation)

    async def search(self, query: str) -> list[SearchHit]:
        text = query.strip()
        if not text or len(text) > 200:
            raise BackendError("search_query")
        needle = text.casefold()

        def operation(db: sqlite3.Connection) -> list[SearchHit]:
            hits: list[SearchHit] = []
            rows = db.execute(
                "SELECT id, payload FROM requests ORDER BY ordinal")
            messages = db.execute(
                "SELECT request_id, ordinal, payload FROM messages ORDER BY rowid")
            grouped: dict[str, list[tuple[int, str]]] = {}
            for request_id, ordinal, payload in messages:
                grouped.setdefault(str(request_id), []).append((int(ordinal), str(payload)))
            for request_id, payload in rows:
                if len(hits) >= 50:
                    break
                receipt = Receipt.model_validate_json(str(payload))
                hits.extend(_search_text(str(request_id), 0, "user", receipt.text, needle))
                for ordinal, body in sorted(grouped.get(str(request_id), [])):
                    if len(hits) >= 50:
                        break
                    message = Message.model_validate_json(body)
                    hits.extend(_search_text(str(request_id), ordinal, message.role, message.content, needle))
            return hits[:50]

        return await self.db.call(operation)

    async def usage(self) -> UsageReport:
        """Sum tokens from finished model steps. In-progress calls and tool results are not usage."""

        def operation(db: sqlite3.Connection) -> UsageReport:
            calls = 0
            input_tokens = 0
            output_tokens = 0
            for (payload,) in db.execute("SELECT payload FROM steps"):
                step = Step.model_validate_json(str(payload))
                if step.kind != "model" or step.phase not in {"result", "applied"} or not step.result:
                    continue
                completion = Completion.model_validate_json(step.result)
                calls += 1
                input_tokens += completion.input_tokens
                output_tokens += completion.output_tokens
            return UsageReport(session_id=self.session_id, model_calls=calls,
                               input_tokens=input_tokens, output_tokens=output_tokens)

        return await self.db.call(operation)

    async def import_settled_root(self, parent: Path, request_id: str) -> Receipt:
        """Copy one settled root into an empty session. No lease, effect, or approval is copied."""
        copied_digest, receipt, messages, run_payload = read_settled_root(parent, request_id)

        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            count = int(db.execute("SELECT count(*) FROM requests").fetchone()[0])
            existing = db.execute("SELECT digest FROM requests WHERE id=?", (request_id,)).fetchone()
            if count:
                if count == 1 and existing is not None and str(existing[0]) == copied_digest:
                    return self._request(db, request_id)
                raise BackendError("branch_target_not_empty")
            db.execute("INSERT INTO requests(id,digest,payload) VALUES(?,?,?)",
                       (request_id, copied_digest, receipt.model_dump_json()))
            db.execute("INSERT INTO runs(request_id,payload) VALUES(?,?)", (request_id, run_payload))
            for key, payload in messages:
                self._message(db, c, request_id, key, Message.model_validate_json(payload))
            c.emit("status", request_id, "branched", receipt=receipt.model_copy(deep=True))
            return receipt

        return await self._tx(operation)

    @staticmethod
    def _pending_ids(db: sqlite3.Connection) -> set[str]:
        terminal = ",".join("?" for _ in TERMINAL)
        requests = {str(r[0]) for r in db.execute(
            f"SELECT id FROM requests WHERE status NOT IN ({terminal})", tuple(TERMINAL))}
        requests.update(str(r[0]) for r in db.execute(
            "SELECT json_extract(payload,'$.request_id') FROM effects "
            "WHERE NOT json_extract(payload,'$.reconciled') OR NOT json_extract(payload,'$.resource_clean')"))
        requests.update(str(r[0]) for r in db.execute("SELECT request_id FROM resolutions WHERE result=''"))
        return requests

    async def snapshot(self, state: WorkerState | None = None) -> Snapshot:
        def operation(db: sqlite3.Connection) -> Snapshot:
            activity = self._activity(db)
            fact_bytes = 0

            def load[T: Model](model: type[T], query: str, args: tuple[str | int, ...] = ()) -> list[T]:
                nonlocal fact_bytes
                values: list[T] = []
                for row in db.execute(query, args):
                    payload = str(row[0])
                    fact_bytes += len(payload.encode())
                    if fact_bytes > SNAPSHOT_MAX_BYTES - SNAPSHOT_VIEW_BYTES - 65536:
                        raise BackendError("snapshot_fact_limit", status=503)
                    values.append(model.model_validate_json(payload))
                return values

            selected = self._pending_ids(db)
            terminal = ",".join("?" for _ in TERMINAL)
            selected.update(str(r[0]) for r in db.execute(
                f"SELECT id FROM requests WHERE kind='root' AND status IN ({terminal}) "
                "ORDER BY CAST(json_extract(payload,'$.revision') AS INTEGER) DESC,ordinal DESC LIMIT 20", tuple(TERMINAL)))
            children = db.execute(f"SELECT id,payload FROM requests WHERE kind!='root' AND status IN ({terminal}) "
                "ORDER BY CAST(json_extract(payload,'$.revision') AS INTEGER) DESC,ordinal DESC LIMIT 21", tuple(TERMINAL)).fetchall()
            child_bytes = 0
            truncated = len(children) > 20
            for row in children[:20]:
                if str(row[0]) in selected:
                    continue
                size = len(str(row[1]).encode())
                if child_bytes + size > SNAPSHOT_CHILD_BYTES:
                    truncated = True
                    continue
                child_bytes += size
                selected.add(str(row[0]))
            ids = tuple(sorted(selected))
            slots = ",".join("?" for _ in ids) or "NULL"
            requests = load(Receipt, f"SELECT payload FROM requests WHERE id IN ({slots}) ORDER BY ordinal", ids)
            requests.extend(load(Receipt,
                "SELECT payload FROM cancellations WHERE id NOT IN (SELECT id FROM requests) ORDER BY rowid DESC LIMIT 20"))
            effects = load(EffectHold, "SELECT payload FROM effects WHERE "
                "NOT json_extract(payload,'$.reconciled') OR NOT json_extract(payload,'$.resource_clean') "
                "OR rowid IN (SELECT rowid FROM effects WHERE json_extract(payload,'$.reconciled') "
                "AND json_extract(payload,'$.resource_clean') ORDER BY rowid DESC LIMIT 20) ORDER BY rowid")
            approvals = load(Approval, f"SELECT payload FROM approvals WHERE request_id IN ({slots}) AND "
                "(json_extract(payload,'$.state') IN ('pending','approved') OR rowid IN "
                "(SELECT rowid FROM approvals ORDER BY rowid DESC LIMIT 20)) ORDER BY rowid", ids)
            previews = load(Preview, "SELECT p.payload FROM previews p JOIN requests r ON r.id=p.request_id "
                "WHERE r.status='running' AND json_extract(r.payload,'$.decision') IS NULL "
                "AND json_extract(p.payload,'$.generation')=json_extract(r.payload,'$.generation')")
            seq = self._meta(db, "revision")
            events: list[Event] = []
            for run in load(Run, f"SELECT payload FROM runs WHERE request_id IN ({slots})", ids):
                if run.lease or run.opening or run.cleanup:
                    events.append(Event(seq=seq, kind="cleanup", request_id=run.request_id, text=run.model_dump_json()))
            for row in db.execute("SELECT request_id,payload FROM resolutions WHERE result=''"):
                event = Event(seq=seq, kind="effect", request_id=str(row[0]), text=str(row[1]))
                fact_bytes += len(event.model_dump_json().encode())
                if fact_bytes > SNAPSHOT_MAX_BYTES - SNAPSHOT_VIEW_BYTES - 65536:
                    raise BackendError("snapshot_fact_limit", status=503)
                events.append(event)

            view_bytes = 0
            # Display history is bounded separately from all pending business facts.
            for request in reversed(requests):
                for table, kind in (("messages", "message"), ("steps", "tool")):
                    rows = db.execute(f"SELECT payload FROM {table} WHERE request_id=? ORDER BY ordinal DESC LIMIT 9",
                                      (request.request_id,)).fetchall()
                    truncated = truncated or len(rows) > 8
                    accepted: list[Event] = []
                    for row in rows[:8]:
                        event = Event.model_validate(dict(seq=seq, kind=kind, request_id=request.request_id,
                                                          text=str(row[0])))
                        size = len(event.model_dump_json().encode())
                        if view_bytes + size > SNAPSHOT_VIEW_BYTES - 256:
                            truncated = True
                            continue
                        view_bytes += size
                        accepted.append(event)
                    events.extend(reversed(accepted))
            if truncated:
                events.append(Event(seq=seq, kind="status", request_id="", text="snapshot_view_truncated"))
            snapshot = Snapshot(session_id=self.session_id, stream_id=self._meta(db, "stream_id"), seq=seq,
                                compaction=self._active_summary(db),
                                state=activity.state if activity.state != "ready" else state or "ready", requests=requests,
                                events=events, approvals=approvals, effects=effects, previews=previews,
                                next_wake_ms=activity.next_wake_ms, pending=activity.pending)
            if len(snapshot.model_dump_json().encode()) > SNAPSHOT_MAX_BYTES:
                raise BackendError("snapshot_fact_limit", status=503)
            return snapshot
        return await self.db.call(operation)

    async def events(self, after: int, stream_id: str = "") -> Replay:
        def operation(db: sqlite3.Connection) -> Replay:
            current = self._meta(db, "stream_id")
            seq = int(self._meta(db, "revision"))
            earliest = db.execute("SELECT coalesce(min(seq),?) FROM batches", (seq + 1,)).fetchone()[0]
            resync = (bool(stream_id and stream_id != current) or after < 0 or after > seq or after < earliest - 1)
            batches: list[CommitBatch] = []
            size = 0
            if not resync:
                for row in db.execute("SELECT payload,bytes FROM batches WHERE seq>? ORDER BY seq LIMIT 16", (after,)):
                    if batches and size + row[1] > 524288:
                        break
                    batches.append(CommitBatch.model_validate_json(row[0]))
                    size += row[1]
            # seq is the watermark actually delivered, never an unseen later transaction.
            return Replay(stream_id=current, seq=str(seq if resync else int(batches[-1].seq) if batches else after),
                          batches=batches, resync=resync)
        return await self.db.call(operation)
