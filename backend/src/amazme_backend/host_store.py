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
    InterfacePreferences,
    Model,
    ModelSelection,
    PreparedFileWrite,
    PrepareUpdate,
    ProcessLease,
    ProductSettings,
    ProjectUpdate,
    ProjectView,
    ProviderConfig,
    Receipt,
    ServiceInfo,
    Session,
    SessionList,
    SessionModel,
    Submit,
    UpdateRecord,
    WorkerActivity,
    WorkerInfo,
    WriteFile,
)
from .manage import contains_secret
from .providers import selected_provider
from .storage import Database


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def checkpoint_id(workspace: str, path: str, digest: str) -> str:
    """One id for the same workspace file bytes. A different file or digest is a different row."""
    return hashlib.sha256(f"{workspace}\n{path}\n{digest}".encode()).hexdigest()[:32]


def _grant_present(db: sqlite3.Connection, workspace: str) -> bool:
    """Primary is the profile directory. Any other name must still be granted."""
    if workspace == "primary":
        return True
    try:
        row = db.execute("SELECT 1 FROM workspace_grants WHERE name=?", (workspace,)).fetchone()
    except sqlite3.OperationalError:
        return False
    return row is not None


def _delivery_provider(db: sqlite3.Connection, session: str, value: Submit, provider: ProviderConfig) -> str:
    if value.mode == "steer":
        return ""
    selection = value.model_selection
    if selection is None:
        chosen = db.execute("SELECT provider,model FROM session_models WHERE session=?", (session,)).fetchone()
        if chosen is not None:
            selection = ModelSelection(provider=str(chosen[0]), model=str(chosen[1]))
    captured = selected_provider(provider, selection)
    db.execute("INSERT INTO session_models(session,provider,model) VALUES(?,?,?) "
        "ON CONFLICT(session) DO UPDATE SET provider=excluded.provider,model=excluded.model",
        (session, captured.provider, captured.model))
    return captured.model_dump_json()


class Delivery(Model):
    delivery_id: str
    session_id: str
    kind: Literal["submit", "cancel", "approval", "resolve"]
    payload: str
    provider: ProviderConfig | None = None
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
                CREATE TABLE IF NOT EXISTS session_removals(session TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0);
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
                CREATE TABLE IF NOT EXISTS file_checkpoints(id TEXT PRIMARY KEY, workspace TEXT NOT NULL,
                  path TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS file_write_preparations(session TEXT NOT NULL, call TEXT NOT NULL,
                  request_digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session,call));
                CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY, session TEXT NOT NULL,
                  workspace TEXT NOT NULL, text TEXT NOT NULL, zone TEXT NOT NULL, local TEXT NOT NULL,
                  fold INTEGER NOT NULL, due_ms INTEGER NOT NULL, phase TEXT NOT NULL,
                  delivery_id TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS project_sessions(session TEXT PRIMARY KEY, project TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS product_settings(id INTEGER PRIMARY KEY, display_name TEXT NOT NULL,
                  revision INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, session TEXT NOT NULL,
                  text TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, session TEXT NOT NULL,
                  digest TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS session_models(
                  session TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL);
                PRAGMA user_version=2;
            """)
            session_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(sessions)")}
            delivery_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(deliveries)")}
            if "provider" not in delivery_columns:
                db.execute("ALTER TABLE deliveries ADD COLUMN provider TEXT NOT NULL DEFAULT ''")
            if "updated_ms" not in session_columns:
                db.execute("ALTER TABLE sessions ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0")
            checkpoints = {str(row[1]) for row in db.execute("PRAGMA table_info(file_checkpoints)")}
            if "used" not in checkpoints:
                db.execute("ALTER TABLE file_checkpoints ADD COLUMN used INTEGER NOT NULL DEFAULT 0")
                db.execute("UPDATE file_checkpoints SET used=rowid")
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
            settings_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(product_settings)")}
            if "preferences" not in settings_columns:
                db.execute("ALTER TABLE product_settings ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'")
            project_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(projects)")}
            for name, declaration in {"workspaces": "TEXT NOT NULL DEFAULT '[\"primary\"]'",
                                      "revision": "INTEGER NOT NULL DEFAULT 0", "removed": "INTEGER NOT NULL DEFAULT 0"}.items():
                if name not in project_columns:
                    db.execute(f"ALTER TABLE projects ADD COLUMN {name} {declaration}")
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
    def _session_sql(tail: str) -> str:
        return (
            "SELECT s.id AS id,s.title AS title,s.parent_id AS parent_id,"
            "s.fork_request_id AS fork_request_id,s.archived AS archived,s.workspace AS workspace,s.updated_ms AS updated_ms,"
            "coalesce(p.project,'') AS project_id FROM sessions s "
            "LEFT JOIN project_sessions p ON p.session=s.id " + tail
        )

    @staticmethod
    def _session(row: sqlite3.Row) -> Session:
        keys = set(row.keys())
        project_id = str(row["project_id"]) if "project_id" in keys else ""
        return Session(session_id=str(row["id"]), title=str(row["title"]), parent_id=str(row["parent_id"]),
                       fork_request_id=str(row["fork_request_id"]), archived=bool(row["archived"]),
                       workspace=str(row["workspace"] or "primary"), project_id=project_id, updated_ms=int(row["updated_ms"]))

    async def sessions(self) -> SessionList:
        return await self._call(lambda db: SessionList(sessions=[
            self._session(row) for row in db.execute(self._session_sql("ORDER BY s.updated_ms,s.rowid"))]))

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
            current = db.execute("SELECT host_path FROM workspace_grants WHERE name=?", (name,)).fetchone()
            if current is not None and str(current[0]) != host_path:
                raise BackendError("workspace_conflict")
            if current is not None:
                return
            if db.execute("SELECT count(*) FROM workspace_grants").fetchone()[0] >= 8:
                raise BackendError("workspace_capacity", status=429)
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

    @staticmethod
    def _save_checkpoint(db: sqlite3.Connection, cid: str, workspace: str, path: str,
                         digest: str, content: str) -> None:
        row = db.execute("SELECT workspace,path,digest,content FROM file_checkpoints WHERE id=?", (cid,)).fetchone()
        if row is not None and tuple(row) != (workspace, path, digest, content):
            raise BackendError("checkpoint_conflict")
        used = int(db.execute("SELECT coalesce(max(used),0)+1 FROM file_checkpoints").fetchone()[0])
        if row is None:
            if db.execute("SELECT count(*) FROM file_checkpoints").fetchone()[0] >= 200:
                raise BackendError("checkpoint_capacity", status=429)
            db.execute("INSERT INTO file_checkpoints(id,workspace,path,digest,content,used) VALUES(?,?,?,?,?,?)",
                       (cid, workspace, path, digest, content, used))
        else:
            db.execute("UPDATE file_checkpoints SET used=? WHERE id=?", (used, cid))

    async def save_checkpoint(self, checkpoint_id: str, workspace: str, path: str, digest: str, content: str) -> tuple[str, str, str, str]:
        def operation(db: sqlite3.Connection) -> tuple[str, str, str, str]:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            self._save_checkpoint(db, checkpoint_id, workspace, path, digest, content)
            return checkpoint_id, workspace, path, digest
        return await self.transaction(operation)

    async def file_write_preparation(self, session: str, call: str, write: WriteFile) -> PreparedFileWrite | None:
        digest = hashlib.sha256(write.model_dump_json().encode()).hexdigest()

        def operation(db: sqlite3.Connection) -> PreparedFileWrite | None:
            row = db.execute("SELECT request_digest,payload FROM file_write_preparations WHERE session=? AND call=?",
                             (session, call)).fetchone()
            if row is None:
                return None
            if row[0] != digest:
                raise BackendError("call_conflict")
            return PreparedFileWrite.model_validate_json(row[1])

        return await self._call(operation)

    async def prepare_file_write(self, session: str, call: str, write: WriteFile, workspace: str,
                                 path: str, previous: tuple[str, str] | None) -> PreparedFileWrite:
        request_digest = hashlib.sha256(write.model_dump_json().encode()).hexdigest()

        def operation(db: sqlite3.Connection) -> PreparedFileWrite:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            old = db.execute("SELECT request_digest,payload FROM file_write_preparations WHERE session=? AND call=?",
                             (session, call)).fetchone()
            if old:
                if old[0] != request_digest:
                    raise BackendError("call_conflict")
                return PreparedFileWrite.model_validate_json(old[1])
            digest, content = previous if previous is not None else ("", "")
            cid = checkpoint_id(workspace, path, digest) if previous is not None else ""
            if cid:
                self._save_checkpoint(db, cid, workspace, path, digest, content)
            prepared = PreparedFileWrite(call_id=call, path=path, expected_digest=digest, checkpoint_id=cid)
            db.execute("INSERT INTO file_write_preparations VALUES(?,?,?,?)",
                       (session, call, request_digest, prepared.model_dump_json()))
            return prepared

        return await self.transaction(operation)

    async def checkpoints_for(self, workspace: str, path: str) -> list[tuple[str, str, str, str]]:
        def operation(db: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
            rows = db.execute(
                "SELECT id, workspace, path, digest FROM file_checkpoints WHERE workspace=? AND path=? ORDER BY used,rowid",
                (workspace, path)).fetchall()
            return [(str(row[0]), str(row[1]), str(row[2]), str(row[3])) for row in rows]
        return await self._call(operation)

    async def checkpoint(self, checkpoint_id: str) -> tuple[str, str, str, str, str] | None:
        def operation(db: sqlite3.Connection) -> tuple[str, str, str, str, str] | None:
            row = db.execute(
                "SELECT id, workspace, path, digest, content FROM file_checkpoints WHERE id=?", (checkpoint_id,)).fetchone()
            if row is None:
                return None
            return str(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4])
        return await self._call(operation)

    async def save_automation(self, automation_id: str, session_id: str, workspace: str, text: str,
                              zone: str, local: str, fold: int, due_ms: int) -> sqlite3.Row:
        def operation(db: sqlite3.Connection) -> sqlite3.Row:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            existing = db.execute("SELECT * FROM automations WHERE id=?", (automation_id,)).fetchone()
            if existing is not None:
                same = (str(existing["session"]), str(existing["workspace"]), str(existing["text"]),
                        str(existing["zone"]), str(existing["local"]), int(existing["fold"]), int(existing["due_ms"]))
                if same != (session_id, workspace, text, zone, local, fold, due_ms):
                    raise BackendError("automation_conflict")
                return existing
            session = db.execute("SELECT archived, workspace FROM sessions WHERE id=?", (session_id,)).fetchone()
            if session is None:
                raise BackendError("session_not_found", status=404)
            if int(session["archived"]):
                raise BackendError("session_archived")
            if str(session["workspace"] or "primary") != workspace:
                raise BackendError("workspace_conflict")
            db.execute(
                "INSERT INTO automations(id,session,workspace,text,zone,local,fold,due_ms,phase) VALUES(?,?,?,?,?,?,?,?, 'scheduled')",
                (automation_id, session_id, workspace, text, zone, local, fold, due_ms))
            row = db.execute("SELECT * FROM automations WHERE id=?", (automation_id,)).fetchone()
            assert row is not None
            return row
        return await self.transaction(operation)

    async def claim_due_automation(self, now_ms: int, secret: str | tuple[str, ...] = "") -> sqlite3.Row | None:
        """One scheduler claims one due automation and its submit delivery in the same transaction."""
        def operation(db: sqlite3.Connection) -> sqlite3.Row | None:
            row = db.execute(
                "SELECT * FROM automations WHERE phase='scheduled' AND due_ms<=? ORDER BY due_ms, id LIMIT 1",
                (now_ms,)).fetchone()
            if row is None:
                return None
            session = db.execute("SELECT archived, workspace FROM sessions WHERE id=?", (str(row["session"]),)).fetchone()
            workspace = "" if session is None else str(session["workspace"] or "primary")
            if (session is None or int(session["archived"]) or workspace != str(row["workspace"] or "primary")
                    or not _grant_present(db, workspace) or contains_secret(str(row["text"]), secret)):
                db.execute("UPDATE automations SET phase='unknown' WHERE id=? AND phase='scheduled'", (str(row["id"]),))
                updated = db.execute("SELECT * FROM automations WHERE id=?", (str(row["id"]),)).fetchone()
                assert updated is not None
                return updated
            claimed = db.execute(
                "UPDATE automations SET phase='unknown' WHERE id=? AND phase='scheduled'", (str(row["id"]),))
            if claimed.rowcount != 1:
                return None
            submit = Submit(request_id=str(row["id"]), text=str(row["text"]))
            payload = submit.model_dump_json()
            digest = hashlib.sha256(payload.encode()).hexdigest()
            identity = hashlib.sha256(json.dumps([str(row["session"]), "submit", str(row["id"])]).encode()).hexdigest()
            existing = db.execute("SELECT digest FROM deliveries WHERE id=?", (identity,)).fetchone()
            if existing is not None and str(existing["digest"]) != digest:
                return db.execute("SELECT * FROM automations WHERE id=?", (str(row["id"]),)).fetchone()
            if existing is None:
                db.execute("INSERT INTO deliveries(id,session,kind,digest,payload) VALUES(?,?,?,?,?)",
                           (identity, str(row["session"]), "submit", digest, payload))
                db.execute("UPDATE sessions SET wanted=1,next_check=0,updated_ms=? WHERE id=?", (time.time_ns() // 1_000_000, str(row["session"])))
            db.execute("UPDATE automations SET phase='done', delivery_id=? WHERE id=?", (identity, str(row["id"])))
            done = db.execute("SELECT * FROM automations WHERE id=?", (str(row["id"]),)).fetchone()
            assert done is not None
            return done
        return await self.transaction(operation)

    async def session_model(self, session_id: str) -> SessionModel | None:
        def operation(db: sqlite3.Connection) -> SessionModel | None:
            row = db.execute("SELECT provider, model FROM session_models WHERE session=?", (session_id,)).fetchone()
            if row is None:
                return None
            return SessionModel(session_id=session_id, provider=str(row[0]), model=str(row[1]))
        return await self.db.call(operation)

    async def save_session_model(self, value: SessionModel) -> SessionModel:
        def operation(db: sqlite3.Connection) -> SessionModel:
            db.execute(
                "INSERT INTO session_models(session, provider, model) VALUES(?,?,?) "
                "ON CONFLICT(session) DO UPDATE SET provider=excluded.provider, model=excluded.model",
                (value.session_id, value.provider, value.model))
            return value
        return await self.transaction(operation)

    async def create_session(self, session_id: str, value: CreateSession) -> Session:
        def operation(db: sqlite3.Connection) -> Session:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            if db.execute("SELECT 1 FROM session_removals WHERE session=?", (session_id,)).fetchone():
                raise BackendError("session_removed")
            workspace = value.workspace or "primary"
            project_id = value.project_id
            row = db.execute("SELECT title, workspace FROM sessions WHERE id=?", (session_id,)).fetchone()
            if row is not None:
                linked = db.execute("SELECT project FROM project_sessions WHERE session=?", (session_id,)).fetchone()
                stored_project = "" if linked is None else str(linked[0])
                if str(row[0]) != value.title or str(row[1] or "primary") != workspace or stored_project != project_id:
                    raise BackendError("session_conflict")
                return self._session(db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone())
            if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 128:
                raise BackendError("session_capacity", status=429)
            if project_id and db.execute("SELECT 1 FROM projects WHERE id=? AND removed=0", (project_id,)).fetchone() is None:
                raise BackendError("project_not_found", status=404)
            if project_id:
                project = self._project(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
                if workspace not in project.workspaces:
                    raise BackendError("project_workspace_mismatch")
            db.execute("INSERT INTO sessions(id,title,workspace,updated_ms) VALUES(?,?,?,?)", (session_id, value.title, workspace, time.time_ns() // 1_000_000))
            if project_id:
                db.execute("INSERT INTO project_sessions(session,project) VALUES(?,?)", (session_id, project_id))
            return self._session(db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone())
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
            project = db.execute("SELECT project FROM project_sessions WHERE session=?", (parent_id,)).fetchone()
            project_id = str(project[0]) if project else ""
            db.execute("INSERT INTO sessions(id,title,parent_id,fork_request_id,workspace,updated_ms) VALUES(?,?,?,?,?,?)",
                       (session_id, title, parent_id, fork_request_id, workspace, time.time_ns() // 1_000_000))
            db.execute("INSERT INTO session_models(session,provider,model) "
                       "SELECT ?,provider,model FROM session_models WHERE session=?", (session_id, parent_id))
            if project_id:
                db.execute("INSERT INTO project_sessions(session,project) VALUES(?,?)", (session_id, project_id))
            return self._session(db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone())
        return await self.transaction(operation)

    async def discard_unopened_branch(self, session_id: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            row = db.execute("SELECT parent_id FROM sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                return
            if not str(row[0]) or db.execute("SELECT 1 FROM deliveries WHERE session=?", (session_id,)).fetchone():
                raise BackendError("branch_discard_refused")
            db.execute("DELETE FROM project_sessions WHERE session=?", (session_id,))
            db.execute("DELETE FROM session_models WHERE session=?", (session_id,))
            db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        await self.transaction(operation)

    async def exists(self, session: str) -> bool:
        return await self._call(lambda db: db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone() is not None)

    @staticmethod
    def _delivery(row: sqlite3.Row) -> Delivery:
        value = Delivery.model_validate({"delivery_id": row["id"], "session_id": row["session"], "kind": row["kind"],
                                       "payload": row["payload"], "state": row["state"],
                                       "receipt": Receipt.model_validate_json(row["receipt"]) if row["receipt"] else None,
                                       "error_code": row["error_code"], "error_status": row["error_status"],
                                       "provider": ProviderConfig.model_validate_json(row["provider"]) if row["provider"] else None})
        commands = {"submit": Submit, "cancel": Cancel, "approval": ApprovalDecision, "resolve": EffectResolution}
        commands[value.kind].model_validate_json(value.payload)
        return value

    async def enqueue(self, session: str, kind: Literal["submit", "cancel", "approval", "resolve"],
                      key: str, value: Model, *, provider: ProviderConfig | None = None) -> Delivery:
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
            configured = ""
            if isinstance(value, Submit) and provider is not None:
                configured = _delivery_provider(db, session, value, provider)
            db.execute("INSERT INTO deliveries(id,session,kind,digest,payload,provider) VALUES(?,?,?,?,?,?)",
                       (identity, session, kind, digest, payload, configured))
            db.execute("UPDATE sessions SET wanted=1,next_check=0,updated_ms=? WHERE id=?", (time.time_ns() // 1_000_000, session))
            return self._delivery(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())
        return await self.transaction(operation)

    async def pin_delivery_provider(self, identity: str, provider: ProviderConfig) -> Delivery:
        """Scheduled deliveries reserve their model before starting any worker."""
        def operation(db: sqlite3.Connection) -> Delivery:
            row = db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise BackendError("delivery_not_found")
            if row["kind"] == "submit" and row["state"] == "pending" and not row["provider"]:
                value = Submit.model_validate_json(row["payload"])
                captured = _delivery_provider(db, str(row["session"]), value, provider)
                db.execute("UPDATE deliveries SET provider=? WHERE id=? AND provider=''", (captured, identity))
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
            if not archived and db.execute("SELECT 1 FROM session_removals WHERE session=?", (session_id,)).fetchone():
                raise BackendError("session_removal_pending")
            current = db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone()
            if current is None:
                raise BackendError("session_not_found", status=404)
            db.execute("UPDATE sessions SET archived=? WHERE id=?", (int(archived), session_id))
            if archived:
                db.execute("UPDATE sessions SET wanted=0,next_check=0 WHERE id=?", (session_id,))
                db.execute(
                    "UPDATE deliveries SET state='rejected',error_code='session_archived',error_status=409 "
                    "WHERE session=? AND kind='submit' AND state='pending'", (session_id,))
            return self._session(db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone())
        return await self.transaction(operation)

    async def rename_session(self, session_id: str, title: str, expected: str) -> Session:
        def operation(db: sqlite3.Connection) -> Session:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone()
            if row is None:
                raise BackendError("session_not_found", status=404)
            if str(row["title"]) not in {expected, title}:
                raise BackendError("session_conflict", status=409)
            db.execute("UPDATE sessions SET title=? WHERE id=?", (title, session_id))
            return self._session(db.execute(self._session_sql("WHERE s.id=?"), (session_id,)).fetchone())
        return await self.transaction(operation)

    async def begin_session_removal(self, session: str) -> bool:
        def operation(db: sqlite3.Connection) -> bool:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            removal = db.execute("SELECT completed FROM session_removals WHERE session=?", (session,)).fetchone()
            if removal is not None and bool(removal[0]):
                return False
            if not db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone():
                raise BackendError("session_not_found", status=404)
            db.execute("INSERT OR IGNORE INTO session_removals(session) VALUES(?)", (session,))
            db.execute("UPDATE sessions SET archived=1,wanted=0,next_check=0 WHERE id=?", (session,))
            db.execute("UPDATE deliveries SET state='rejected',error_code='session_removed',error_status=409 "
                       "WHERE session=? AND kind='submit' AND state='pending'", (session,))
            return True
        return await self.transaction(operation)

    async def finish_session_removal(self, session: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            if not db.execute("SELECT 1 FROM session_removals WHERE session=?", (session,)).fetchone():
                raise BackendError("session_removal_pending")
            for table in ("project_sessions", "session_models", "deliveries", "automations", "feedback", "shares", "file_write_preparations"):
                db.execute(f"DELETE FROM {table} WHERE session=?", (session,))
            db.execute("DELETE FROM sessions WHERE id=?", (session,))
            db.execute("UPDATE session_removals SET completed=1 WHERE session=?", (session,))
        await self.transaction(operation)

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

    @staticmethod
    def _project(row: sqlite3.Row) -> ProjectView:
        return ProjectView(project_id=str(row["id"]), name=str(row["name"]),
                           workspaces=json.loads(str(row["workspaces"])), revision=int(row["revision"]),
                           removed=bool(row["removed"]))

    async def save_project(self, project_id: str, name: str, workspaces: list[str]) -> ProjectView:
        key = hashlib.sha256(json.dumps([name, workspaces], ensure_ascii=False).encode()).hexdigest()

        def operation(db: sqlite3.Connection) -> ProjectView:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is not None:
                if str(row["digest"]) != key:
                    raise BackendError("project_conflict")
                return self._project(row)
            db.execute("INSERT INTO projects(id,name,digest,workspaces) VALUES(?,?,?,?)",
                       (project_id, name, key, json.dumps(workspaces)))
            return self._project(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
        return await self.transaction(operation)

    async def projects(self) -> list[ProjectView]:
        return await self._call(lambda db: [self._project(row) for row in db.execute("SELECT * FROM projects ORDER BY rowid")])

    async def update_project(self, project_id: str, value: ProjectUpdate) -> ProjectView:
        def operation(db: sqlite3.Connection) -> ProjectView:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                raise BackendError("project_not_found", status=404)
            current = self._project(row)
            if (current.name, current.workspaces, current.removed) == (value.name, value.workspaces, value.removed):
                return current
            if current.revision != value.expected_revision:
                raise BackendError("project_conflict", status=409)
            db.execute("UPDATE projects SET name=?,workspaces=?,removed=?,revision=revision+1 WHERE id=?",
                       (value.name, json.dumps(value.workspaces), int(value.removed), project_id))
            if value.removed:
                db.execute("UPDATE sessions SET archived=1,wanted=0,next_check=0 "
                           "WHERE id IN (SELECT session FROM project_sessions WHERE project=?)", (project_id,))
                db.execute("UPDATE deliveries SET state='rejected',error_code='session_archived',error_status=409 "
                           "WHERE kind='submit' AND state='pending' AND session IN "
                           "(SELECT session FROM project_sessions WHERE project=?)", (project_id,))
            return self._project(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
        return await self.transaction(operation)

    @staticmethod
    def _settings(row: sqlite3.Row | None) -> ProductSettings:
        if row is None:
            return ProductSettings()
        return ProductSettings(display_name=str(row["display_name"]), revision=int(row["revision"]),
                               preferences=InterfacePreferences.model_validate_json(str(row["preferences"])))

    async def product_settings(self) -> ProductSettings:
        def operation(db: sqlite3.Connection) -> ProductSettings:
            return self._settings(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())
        return await self._call(operation)

    async def save_product_settings(self, name: str, expected: int) -> ProductSettings:
        def operation(db: sqlite3.Connection) -> ProductSettings:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute("SELECT display_name,revision FROM product_settings WHERE id=1").fetchone()
            current = int(row[1]) if row else 0
            if current != expected:
                raise BackendError("settings_conflict")
            revision = current + 1
            db.execute(
                "INSERT INTO product_settings(id,display_name,revision) VALUES(1,?,?) "
                "ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,revision=excluded.revision",
                (name, revision))
            return self._settings(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())
        return await self.transaction(operation)

    async def save_preferences(self, preferences: InterfacePreferences, expected: int) -> ProductSettings:
        def operation(db: sqlite3.Connection) -> ProductSettings:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            current = self._settings(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())
            if current.preferences == preferences:
                return current
            if current.revision != expected:
                raise BackendError("settings_conflict", status=409)
            db.execute("INSERT INTO product_settings(id,display_name,revision,preferences) VALUES(1,?,?,?) "
                       "ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,preferences=excluded.preferences",
                       (current.display_name, current.revision + 1, preferences.model_dump_json()))
            return self._settings(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())
        return await self.transaction(operation)

    async def save_feedback(self, feedback_id: str, session_id: str, text: str, key: str) -> tuple[str, str, str]:
        def operation(db: sqlite3.Connection) -> tuple[str, str, str]:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute("SELECT digest,session,text FROM feedback WHERE id=?", (feedback_id,)).fetchone()
            if row is not None:
                if str(row[0]) != key:
                    raise BackendError("feedback_conflict")
                return feedback_id, str(row[1]), str(row[2])
            db.execute("INSERT INTO feedback(id,session,text,digest) VALUES(?,?,?,?)",
                       (feedback_id, session_id, text, key))
            return feedback_id, session_id, text
        return await self.transaction(operation)

    async def feedback_rows(self) -> list[tuple[str, str, str]]:
        return await self._call(lambda db: [(str(row[0]), str(row[1]), str(row[2])) for row in db.execute(
            "SELECT id,session,text FROM feedback ORDER BY rowid")])

    async def save_share(self, share_id: str, session_id: str, key: str, payload: str) -> str:
        def operation(db: sqlite3.Connection) -> str:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            row = db.execute("SELECT digest,session,payload FROM shares WHERE id=?", (share_id,)).fetchone()
            if row is not None:
                if str(row[0]) != key or str(row[1]) != session_id:
                    raise BackendError("share_conflict")
                return str(row[2])
            db.execute("INSERT INTO shares(id,session,digest,payload) VALUES(?,?,?,?)",
                       (share_id, session_id, key, payload))
            return payload
        return await self.transaction(operation)

    async def share_record(self, share_id: str) -> tuple[str, str] | None:
        def operation(db: sqlite3.Connection) -> tuple[str, str] | None:
            row = db.execute("SELECT digest,session FROM shares WHERE id=?", (share_id,)).fetchone()
            if row is None:
                return None
            return str(row[0]), str(row[1])
        return await self._call(operation)

    async def read_share(self, share_id: str, session_id: str) -> str:
        def operation(db: sqlite3.Connection) -> str:
            row = db.execute("SELECT payload FROM shares WHERE id=? AND session=?", (share_id, session_id)).fetchone()
            if row is None:
                raise BackendError("share_not_found", status=404)
            return str(row[0])
        return await self._call(operation)

    async def ensure_import_session(self, session_id: str, title: str, workspace: str, project_id: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
                raise BackendError("update_frozen", status=503)
            if project_id and db.execute("SELECT 1 FROM projects WHERE id=? AND removed=0", (project_id,)).fetchone() is None:
                raise BackendError("import_conflict")
            row = db.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                db.execute("INSERT INTO sessions(id,title,workspace,updated_ms) VALUES(?,?,?,?)", (session_id, title, workspace, time.time_ns() // 1_000_000))
            if project_id:
                db.execute(
                    "INSERT INTO project_sessions(session,project) VALUES(?,?) "
                    "ON CONFLICT(session) DO NOTHING",
                    (session_id, project_id))
        await self.transaction(operation)
