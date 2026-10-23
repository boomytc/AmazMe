import hashlib
import json
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from .contracts import (
    ApprovalDecision,
    BackendError,
    Cancel,
    CreateSession,
    EffectResolution,
    Model,
    PrepareUpdate,
    ProcessLease,
    Receipt,
    ServiceInfo,
    Session,
    SessionList,
    Submit,
    UpdateRecord,
    WorkerActivity,
    WorkerInfo,
)
from .storage import Database


def now_ms() -> int:
    return time.time_ns() // 1_000_000


class Delivery(Model):
    delivery_id: str
    session_id: str
    kind: Literal["submit", "cancel", "approval", "resolve"]
    payload: str
    state: Literal["pending", "delivered", "rejected"]
    receipt: Receipt | None = None
    error_code: str = ""
    error_status: int = 0


ServiceRecord = ServiceInfo


class HostStore:
    def __init__(self, path: Path, *, require_existing: bool = False):
        self.db = Database(path, require_existing=require_existing, preflight=self._preflight)
        self.failed = False

    @staticmethod
    def _preflight(db: sqlite3.Connection) -> None:
        required = {
            "control": {"id", "epoch", "port", "freeze_id", "blocked", "execution_initialized"},
            "hosts": {"epoch", "instance", "build", "lease"},
            "services": {"ordinal", "instance", "payload"},
            "sessions": {"id", "title", "wanted", "next_check"},
            "deliveries": {"ordinal", "id", "session", "kind", "digest", "payload", "state", "receipt", "error_code", "error_status"},
            "updates": {"ordinal", "id", "payload"},
            "restarts": {"at"},
        }
        for table, columns in required.items():
            if not columns <= {str(row[1]) for row in db.execute(f"PRAGMA table_info({table})")}:
                raise BackendError("storage_incomplete", status=503)
        control = db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()
        if control is None:
            raise BackendError("storage_incomplete", status=503)
        if control[0] and not db.execute("SELECT 1 FROM updates WHERE id=?", (control[0],)).fetchone():
            raise BackendError("storage_corrupt", status=503)

    async def _call[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.failed:
            raise BackendError("storage_blocked", status=503)
        try:
            return await self.db.call(operation)
        except BackendError as error:
            if error.code.startswith("storage_") or error.code in {"database_closed", "unsupported_storage_format"}:
                self.failed = True
            raise
        except (sqlite3.Error, OSError, ValidationError) as error:
            self.failed = True
            raise BackendError("storage_failure", status=503) from error

    async def transaction[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        def invoke(db: sqlite3.Connection) -> T:
            db.execute("BEGIN IMMEDIATE")
            try:
                result = operation(db)
                db.execute("COMMIT")
                return result
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        return await self._call(invoke)

    async def initialize(self, instance: str, build: str, lease: ProcessLease) -> int:
        def create(db: sqlite3.Connection) -> None:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,
                  port INTEGER NOT NULL DEFAULT 0,freeze_id TEXT NOT NULL DEFAULT '',blocked TEXT NOT NULL DEFAULT '',
                  execution_initialized INTEGER NOT NULL DEFAULT 0);
                INSERT OR IGNORE INTO control(id,epoch) VALUES(1,0);
                CREATE TABLE IF NOT EXISTS hosts(epoch INTEGER PRIMARY KEY,instance TEXT UNIQUE NOT NULL,
                  build TEXT NOT NULL,lease TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS services(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                  instance TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,
                  wanted INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL DEFAULT 0,
                  parent_id TEXT NOT NULL DEFAULT '',fork_request_id TEXT NOT NULL DEFAULT '',
                  archived INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS deliveries(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                  id TEXT UNIQUE NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,
                  payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',receipt TEXT NOT NULL DEFAULT '',
                  error_code TEXT NOT NULL DEFAULT '',error_status INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS updates(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                  id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS restarts(at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS workspace_grants(name TEXT PRIMARY KEY, host_path TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, workspace TEXT NOT NULL,
                  text TEXT NOT NULL, digest TEXT NOT NULL);
                PRAGMA user_version=2;
            """)
            # Format 2 already shipped without branch columns. Adding them keeps every existing row.
            present = {str(row[1]) for row in db.execute("PRAGMA table_info(sessions)")}
            if "parent_id" not in present:
                db.execute("ALTER TABLE sessions ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''")
            if "fork_request_id" not in present:
                db.execute("ALTER TABLE sessions ADD COLUMN fork_request_id TEXT NOT NULL DEFAULT ''")
            if "archived" not in present:
                db.execute("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
            if "workspace" not in present:
                db.execute("ALTER TABLE sessions ADD COLUMN workspace TEXT NOT NULL DEFAULT 'primary'")
        await self._call(create)
        def begin(db: sqlite3.Connection) -> int:
            db.execute("UPDATE control SET epoch=epoch+1 WHERE id=1")
            epoch = int(db.execute("SELECT epoch FROM control WHERE id=1").fetchone()[0])
            db.execute("INSERT INTO hosts VALUES(?,?,?,?)", (epoch, instance, build, lease.model_dump_json()))
            return epoch
        return await self.transaction(begin)

    async def port(self, value: int | None = None) -> int:
        def operation(db: sqlite3.Connection) -> int:
            if value is not None:
                db.execute("UPDATE control SET port=? WHERE id=1", (value,))
            return int(db.execute("SELECT port FROM control WHERE id=1").fetchone()[0])
        return await self._call(operation)

    @staticmethod
    def _session(row: sqlite3.Row) -> Session:
        return Session(session_id=str(row["id"]), title=str(row["title"]), parent_id=str(row["parent_id"]),
                       fork_request_id=str(row["fork_request_id"]), archived=bool(row["archived"]),
                       workspace=str(row["workspace"] or "primary"))

    async def sessions(self) -> SessionList:
        return await self._call(lambda db: SessionList(sessions=[
            self._session(row) for row in db.execute(
                "SELECT id,title,parent_id,fork_request_id,archived,workspace FROM sessions ORDER BY rowid")]))

    async def workspace_grants(self) -> list[tuple[str, str]]:
        def operation(db: sqlite3.Connection) -> list[tuple[str, str]]:
            try:
                rows = db.execute("SELECT name, host_path FROM workspace_grants ORDER BY name").fetchall()
            except sqlite3.OperationalError:
                return []
            return [(str(row[0]), str(row[1])) for row in rows]
        return await self._call(operation)

    async def add_workspace_grant(self, name: str, host_path: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            if db.execute("SELECT count(*) FROM workspace_grants").fetchone()[0] >= 8:
                raise BackendError("workspace_capacity", status=429)
            current = db.execute("SELECT host_path FROM workspace_grants WHERE name=?", (name,)).fetchone()
            if current is not None and str(current[0]) != host_path:
                raise BackendError("workspace_conflict")
            used = db.execute("SELECT name FROM workspace_grants WHERE host_path=?", (host_path,)).fetchone()
            if used is not None and str(used[0]) != name:
                raise BackendError("workspace_conflict")
            db.execute("INSERT INTO workspace_grants(name, host_path) VALUES(?,?) ON CONFLICT(name) DO NOTHING",
                       (name, host_path))
        await self.transaction(operation)

    async def remove_workspace_grant(self, name: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            if db.execute("DELETE FROM workspace_grants WHERE name=?", (name,)).rowcount != 1:
                raise BackendError("workspace_not_found", status=404)
        await self.transaction(operation)

    async def save_memory(self, memory_id: str, workspace: str, text: str, digest: str) -> tuple[str, str, str]:
        def operation(db: sqlite3.Connection) -> tuple[str, str, str]:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute("SELECT workspace, text, digest FROM memories WHERE id=?", (memory_id,)).fetchone()
            if row is not None:
                if str(row[0]) != workspace or str(row[2]) != digest:
                    raise BackendError("memory_conflict")
                return memory_id, workspace, str(row[1])
            if db.execute("SELECT count(*) FROM memories").fetchone()[0] >= 200:
                raise BackendError("memory_capacity", status=429)
            db.execute("INSERT INTO memories(id,workspace,text,digest) VALUES(?,?,?,?)",
                       (memory_id, workspace, text, digest))
            return memory_id, workspace, text
        return await self.transaction(operation)

    async def memory_rows(self) -> list[tuple[str, str, str]]:
        def operation(db: sqlite3.Connection) -> list[tuple[str, str, str]]:
            try:
                rows = db.execute("SELECT id, workspace, text FROM memories ORDER BY id").fetchall()
            except sqlite3.OperationalError:
                return []
            return [(str(row[0]), str(row[1]), str(row[2])) for row in rows]
        return await self._call(operation)

    async def create_session(self, session_id: str, value: CreateSession) -> Session:
        def operation(db: sqlite3.Connection) -> Session:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 128:
                raise BackendError("session_capacity", status=429)
            workspace = value.workspace or "primary"
            db.execute("INSERT INTO sessions(id,title,workspace) VALUES(?,?,?)", (session_id, value.title, workspace))
            return Session(session_id=session_id, title=value.title, workspace=workspace)
        return await self.transaction(operation)

    async def create_branch(self, session_id: str, parent_id: str, fork_request_id: str, title: str) -> Session:
        def operation(db: sqlite3.Connection) -> Session:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            parent = db.execute("SELECT workspace FROM sessions WHERE id=?", (parent_id,)).fetchone()
            if parent is None:
                raise BackendError("session_not_found", status=404)
            if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 128:
                raise BackendError("session_capacity", status=429)
            workspace = str(parent[0] or "primary")
            db.execute("INSERT INTO sessions(id,title,parent_id,fork_request_id,workspace) VALUES(?,?,?,?,?)",
                       (session_id, title, parent_id, fork_request_id, workspace))
            return Session(session_id=session_id, title=title, parent_id=parent_id,
                           fork_request_id=fork_request_id, workspace=workspace)
        return await self.transaction(operation)

    async def discard_unopened_branch(self, session_id: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            row = db.execute("SELECT parent_id FROM sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                return
            if not str(row[0]) or db.execute("SELECT 1 FROM deliveries WHERE session=?", (session_id,)).fetchone():
                raise BackendError("branch_discard_refused")
            db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        await self.transaction(operation)

    async def exists(self, session: str) -> bool:
        return await self._call(lambda db: db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone() is not None)

    @staticmethod
    def _delivery(row: sqlite3.Row) -> Delivery:
        value = Delivery.model_validate({"delivery_id": row["id"], "session_id": row["session"], "kind": row["kind"],
                                       "payload": row["payload"], "state": row["state"],
                                       "receipt": Receipt.model_validate_json(row["receipt"]) if row["receipt"] else None,
                                       "error_code": row["error_code"], "error_status": row["error_status"]})
        commands = {"submit": Submit, "cancel": Cancel, "approval": ApprovalDecision, "resolve": EffectResolution}
        commands[value.kind].model_validate_json(value.payload)
        return value

    async def enqueue(self, session: str, kind: Literal["submit", "cancel", "approval", "resolve"],
                      key: str, value: Model) -> Delivery:
        payload = value.model_dump_json()
        digest = hashlib.sha256(payload.encode()).hexdigest()
        identity = hashlib.sha256(json.dumps([session, kind, key]).encode()).hexdigest()
        def operation(db: sqlite3.Connection) -> Delivery:
            existing = db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone()
            if existing:
                if existing["digest"] != digest:
                    raise BackendError("request_conflict")
                return self._delivery(existing)
            row = db.execute("SELECT archived FROM sessions WHERE id=?", (session,)).fetchone()
            if row is None:
                raise BackendError("session_not_found", status=404)
            if kind == "submit" and int(row[0]):
                raise BackendError("session_archived")
            if kind not in {"cancel", "resolve"} and db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]:
                raise BackendError("update_frozen", status=503)
            if db.execute("SELECT count(*) FROM deliveries WHERE state='pending'").fetchone()[0] >= 128:
                raise BackendError("delivery_capacity", status=429)
            db.execute("INSERT INTO deliveries(id,session,kind,digest,payload) VALUES(?,?,?,?,?)",
                       (identity, session, kind, digest, payload))
            db.execute("UPDATE sessions SET wanted=1,next_check=0 WHERE id=?", (session,))
            return self._delivery(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())
        return await self.transaction(operation)

    async def delivered(self, identity: str, receipt: Receipt) -> Delivery:
        def operation(db: sqlite3.Connection) -> Delivery:
            db.execute("UPDATE deliveries SET state='delivered',receipt=? WHERE id=? AND state='pending'",
                       (receipt.model_dump_json(), identity))
            return self._delivery(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())
        return await self.transaction(operation)

    async def rejected(self, identity: str, error: BackendError) -> Delivery:
        def operation(db: sqlite3.Connection) -> Delivery:
            db.execute("UPDATE deliveries SET state='rejected',error_code=?,error_status=? WHERE id=? AND state='pending'",
                       (error.code, error.status, identity))
            return self._delivery(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())
        return await self.transaction(operation)

    async def pending(self, session: str | None = None) -> list[Delivery]:
        return await self._call(lambda db: [self._delivery(row) for row in db.execute(
            "SELECT * FROM deliveries WHERE state='pending' AND (? IS NULL OR session=?) ORDER BY ordinal LIMIT 128",
            (session, session))])

    async def set_archived(self, session_id: str, archived: bool) -> Session:
        def operation(db: sqlite3.Connection) -> Session:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            current = db.execute(
                "SELECT id,title,parent_id,fork_request_id,archived,workspace FROM sessions WHERE id=?",
                (session_id,)).fetchone()
            if current is None:
                raise BackendError("session_not_found", status=404)
            db.execute("UPDATE sessions SET archived=? WHERE id=?", (int(archived), session_id))
            if archived:
                db.execute("UPDATE sessions SET wanted=0,next_check=0 WHERE id=?", (session_id,))
                db.execute(
                    "UPDATE deliveries SET state='rejected',error_code='session_archived',error_status=409 "
                    "WHERE session=? AND kind='submit' AND state='pending'", (session_id,))
            return self._session(db.execute(
                "SELECT id,title,parent_id,fork_request_id,archived,workspace FROM sessions WHERE id=?",
                (session_id,)).fetchone())
        return await self.transaction(operation)

    async def activity(self, session: str, activity: WorkerActivity) -> None:
        wanted = activity.runnable or activity.next_wake_ms > 0
        check = now_ms() + 500 if activity.runnable else activity.next_wake_ms
        await self._call(lambda db: db.execute("UPDATE sessions SET wanted=?,next_check=? WHERE id=?", (int(wanted), check, session)))

    async def demand(self, session: str = "") -> None:
        await self._call(lambda db: db.execute(
            "UPDATE sessions SET wanted=1,next_check=0 WHERE archived=0 AND (?='' OR id=?)", (session, session)))

    async def due(self) -> list[str]:
        return await self._call(lambda db: [str(row[0]) for row in db.execute(
            "SELECT id FROM sessions WHERE wanted=1 AND next_check<=? ORDER BY next_check LIMIT 128", (now_ms(),))])

    async def service(self) -> ServiceRecord | None:
        def operation(db: sqlite3.Connection) -> ServiceRecord | None:
            records = [ServiceRecord.model_validate_json(row[0]) for row in db.execute(
                "SELECT payload FROM services ORDER BY ordinal")]
            live = [value for value in records if value.state != "stopped"]
            if len(live) > 1:
                raise BackendError("supervisor_registry_conflict", status=503)
            return live[0] if live else None
        return await self._call(operation)

    async def services(self) -> list[ServiceInfo]:
        return await self._call(lambda db: [ServiceInfo.model_validate_json(row[0]) for row in db.execute(
            "SELECT payload FROM services ORDER BY ordinal")])

    async def blocked(self) -> str:
        return await self._call(lambda db: str(db.execute("SELECT blocked FROM control WHERE id=1").fetchone()[0]))

    async def last_build(self, current: str) -> str:
        def operation(db: sqlite3.Connection) -> str:
            row = db.execute("SELECT build FROM hosts WHERE instance!=? ORDER BY epoch DESC LIMIT 1", (current,)).fetchone()
            return str(row[0]) if row else ""
        return await self._call(operation)

    async def save_service(self, value: ServiceRecord) -> None:
        def operation(db: sqlite3.Connection) -> None:
            row = db.execute("SELECT payload FROM services WHERE instance=?", (value.instance_id,)).fetchone()
            if row:
                old = ServiceRecord.model_validate_json(row[0])
                if old.build_id != value.build_id or old.process_lease != value.process_lease:
                    raise BackendError("supervisor_identity_mismatch", status=503)
                if old.state in {"stopping", "stopped"} and value.state not in (
                    {"stopped"} if old.state == "stopped" else {"stopping", "stopped"}
                ):
                    raise BackendError("supervisor_retirement_pending", status=503)
            elif any(ServiceRecord.model_validate_json(row[0]).state != "stopped" for row in db.execute(
                "SELECT payload FROM services"
            )):
                raise BackendError("supervisor_registry_conflict", status=503)
            db.execute("INSERT INTO services(instance,payload) VALUES(?,?) ON CONFLICT(instance) DO UPDATE SET payload=excluded.payload",
                       (value.instance_id, value.model_dump_json()))
            if value.state == "running":
                db.execute("UPDATE control SET execution_initialized=1 WHERE id=1")
        await self.transaction(operation)

    async def execution_initialized(self) -> bool:
        return await self._call(lambda db: bool(db.execute("SELECT execution_initialized FROM control WHERE id=1").fetchone()[0]))

    async def allow_restart(self, *, explicit: bool = False) -> None:
        def operation(db: sqlite3.Connection) -> bool:
            if explicit:
                db.execute("DELETE FROM restarts")
                db.execute("UPDATE control SET blocked='' WHERE id=1")
            db.execute("DELETE FROM restarts WHERE at<?", (now_ms() - 600_000,))
            blocked = db.execute("SELECT blocked FROM control WHERE id=1").fetchone()[0]
            if blocked or db.execute("SELECT count(*) FROM restarts").fetchone()[0] >= 3:
                db.execute("UPDATE control SET blocked='supervisor_restart_budget' WHERE id=1")
                return False
            db.execute("INSERT INTO restarts VALUES(?)", (now_ms(),))
            return True
        if not await self.transaction(operation):
            raise BackendError("supervisor_restart_budget", status=503)

    async def active_update(self) -> UpdateRecord | None:
        def operation(db: sqlite3.Connection) -> UpdateRecord | None:
            identity = str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0])
            if not identity:
                return None
            row = db.execute("SELECT payload FROM updates WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise BackendError("storage_corrupt", status=503)
            return UpdateRecord.model_validate_json(row[0])
        return await self._call(operation)

    async def update(self, identity: str) -> UpdateRecord:
        def operation(db: sqlite3.Connection) -> UpdateRecord:
            row = db.execute("SELECT payload FROM updates WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise BackendError("update_not_found", status=404)
            return UpdateRecord.model_validate_json(row[0])
        return await self._call(operation)

    async def begin_update(self, value: PrepareUpdate, source: str) -> UpdateRecord:
        def operation(db: sqlite3.Connection) -> UpdateRecord:
            existing = db.execute("SELECT payload FROM updates WHERE id=?", (value.update_id,)).fetchone()
            if existing:
                result = UpdateRecord.model_validate_json(existing[0])
                if result.target_build != value.target_build or result.cancel_work != value.cancel_work:
                    raise BackendError("update_conflict")
                return result
            if db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]:
                raise BackendError("update_in_progress")
            result = UpdateRecord(update_id=value.update_id, source_build=source, target_build=value.target_build,
                                  phase="freezing", revision="1", cancel_work=value.cancel_work)
            db.execute("INSERT INTO updates(id,payload) VALUES(?,?)", (value.update_id, result.model_dump_json()))
            db.execute("UPDATE control SET freeze_id=? WHERE id=1", (value.update_id,))
            return result
        return await self.transaction(operation)

    async def save_update(self, value: UpdateRecord) -> UpdateRecord:
        def operation(db: sqlite3.Connection) -> UpdateRecord:
            old = UpdateRecord.model_validate_json(db.execute("SELECT payload FROM updates WHERE id=?", (value.update_id,)).fetchone()[0])
            if value.revision != old.revision:
                raise BackendError("update_revision_conflict")
            if (value.source_build, value.target_build, value.cancel_work) != (
                old.source_build, old.target_build, old.cancel_work
            ) or (old.activated and not value.activated):
                raise BackendError("invalid_update_transition")
            self.verify_roster(old.roster, value.roster)
            if not old.activated and db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0] != value.update_id:
                raise BackendError("update_identity_mismatch")
            order = ["freezing", "retiring", "prepared", "validating", "completed"]
            if order.index(value.phase) < order.index(old.phase):
                raise BackendError("invalid_update_transition")
            result = value.model_copy(update={"revision": str(int(old.revision) + 1)})
            db.execute("UPDATE updates SET payload=? WHERE id=?", (result.model_dump_json(), value.update_id))
            if result.activated:
                if result.phase != "completed":
                    raise BackendError("invalid_update_activation")
                db.execute("UPDATE control SET freeze_id='' WHERE id=1 AND freeze_id=?", (result.update_id,))
            return result
        return await self.transaction(operation)

    async def source_hosts(self, current: str) -> list[ProcessLease]:
        return await self._call(lambda db: [ProcessLease.model_validate_json(row[0]) for row in db.execute(
            "SELECT lease FROM hosts WHERE instance!=?", (current,))])

    @staticmethod
    def verify_roster(previous: list[WorkerInfo], current: list[WorkerInfo]) -> None:
        indexed = {worker.worker_id: worker for worker in current}
        if len(indexed) != len(current):
            raise BackendError("participant_identity_mismatch", status=503)
        for old in previous:
            worker = indexed.get(old.worker_id)
            if worker is None:
                raise BackendError("participant_missing", old.worker_id, 503)
            if (worker.session_id, worker.build_id, worker.process_lease, worker.purpose) != (
                old.session_id, old.build_id, old.process_lease, old.purpose
            ) or (old.state == "stopped" and worker.state != "stopped"):
                raise BackendError("participant_identity_mismatch", old.worker_id, 503)

    async def source_roster(self, identity: str, roster: list[WorkerInfo]) -> UpdateRecord:
        def operation(db: sqlite3.Connection) -> UpdateRecord:
            row = db.execute("SELECT payload FROM updates WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise BackendError("update_not_found", status=404)
            value = UpdateRecord.model_validate_json(row[0])
            self.verify_roster(value.roster, roster)
            if value.roster != roster:
                if value.activated:
                    raise BackendError("invalid_update_transition")
                value.roster = roster
                value.revision = str(int(value.revision) + 1)
                db.execute("UPDATE updates SET payload=? WHERE id=?", (value.model_dump_json(), identity))
            return value
        return await self.transaction(operation)
