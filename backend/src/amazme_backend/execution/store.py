"""Execution schema and one serialized SQLite writer for a Supervisor."""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from amazme_backend.shared.errors import BackendError

RESOLUTION_SCHEMA = """CREATE TABLE IF NOT EXISTS resolutions(
    id TEXT PRIMARY KEY,call TEXT NOT NULL UNIQUE,session TEXT NOT NULL,payload TEXT NOT NULL,
    native_call TEXT,plugin_call TEXT,code_call TEXT,
    CHECK((native_call IS NOT NULL AND plugin_call IS NULL AND code_call IS NULL AND call=native_call)
          OR (native_call IS NULL AND plugin_call IS NOT NULL AND code_call IS NULL)
          OR (native_call IS NULL AND plugin_call IS NULL AND code_call IS NOT NULL)),
    FOREIGN KEY(native_call) REFERENCES scopes(id),
    FOREIGN KEY(plugin_call,call) REFERENCES plugin_calls(id,step_id),
    FOREIGN KEY(code_call,call) REFERENCES code_runs(id,parent_step));"""


def ensure_resolution_schema(db: sqlite3.Connection) -> None:
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS plugin_call_step ON plugin_calls(id,step_id)")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS code_parent_step ON code_runs(id,parent_step)")
    resolution_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(resolutions)")}
    if "code_call" not in resolution_columns:
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("ALTER TABLE resolutions RENAME TO previous_resolutions")
            db.execute(RESOLUTION_SCHEMA)
            if "native_call" in resolution_columns:
                db.execute("INSERT INTO resolutions(id,call,session,payload,native_call,plugin_call) "
                           "SELECT id,call,session,payload,native_call,plugin_call FROM previous_resolutions")
            else:
                db.execute("INSERT INTO resolutions(id,call,session,payload,native_call) "
                           "SELECT id,call,session,payload,call FROM previous_resolutions")
            db.execute("DROP TABLE previous_resolutions")
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise


def initialize_schema(db: sqlite3.Connection) -> sqlite3.Row:
    db.executescript(f"""
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
      {RESOLUTION_SCHEMA}
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
      CREATE TABLE IF NOT EXISTS code_state(session TEXT NOT NULL,scope TEXT NOT NULL,document TEXT NOT NULL,
        PRIMARY KEY(session,scope));
      CREATE TABLE IF NOT EXISTS code_results(id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS code_cancellations(id TEXT PRIMARY KEY,session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS code_tools(id TEXT PRIMARY KEY,tools TEXT NOT NULL,mcp TEXT NOT NULL,plugins TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS code_tool_calls(id TEXT PRIMARY KEY,run TEXT NOT NULL,sequence INTEGER NOT NULL,
          payload TEXT NOT NULL,binding TEXT NOT NULL,UNIQUE(run,sequence));
      CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,name TEXT NOT NULL,
        capabilities TEXT NOT NULL,config TEXT NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_calls(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,
        session TEXT NOT NULL,text TEXT NOT NULL,phase TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
      PRAGMA user_version=3;
      COMMIT;
    """)
    for table, additions in {
        "scopes":{"log_expires":"INTEGER NOT NULL DEFAULT 0", "log_workspace":"TEXT NOT NULL DEFAULT ''",
                  "background":"INTEGER NOT NULL DEFAULT 0", "job_ack":"TEXT NOT NULL DEFAULT ''",
                  "job_cancel":"INTEGER NOT NULL DEFAULT 0", "job_notified":"INTEGER NOT NULL DEFAULT 0",
                  "job_started":"INTEGER NOT NULL DEFAULT 0", "job_finished":"INTEGER NOT NULL DEFAULT 0"},
        "plugins":{"session":"TEXT NOT NULL DEFAULT ''", "entry":"TEXT NOT NULL DEFAULT ''", "source_digest":"TEXT NOT NULL DEFAULT ''",
                   "tools":"TEXT NOT NULL DEFAULT '[]'", "load_id":"TEXT NOT NULL DEFAULT ''",
                   "phase":"TEXT NOT NULL DEFAULT 'disconnected'", "error":"TEXT NOT NULL DEFAULT ''",
                   "lease":"TEXT NOT NULL DEFAULT ''", "directory":"TEXT NOT NULL DEFAULT ''"},
        "plugin_calls":{"step_id":"TEXT NOT NULL DEFAULT ''", "request_id":"TEXT NOT NULL DEFAULT ''",
                        "origin":"TEXT NOT NULL DEFAULT 'manual'", "error":"TEXT NOT NULL DEFAULT ''", "fingerprint":"TEXT NOT NULL DEFAULT ''",
                        "cancel_requested":"INTEGER NOT NULL DEFAULT 0", "clean":"INTEGER NOT NULL DEFAULT 0"},
        "code_runs":{"parent_request":"TEXT NOT NULL DEFAULT ''", "parent_step":"TEXT NOT NULL DEFAULT ''", "intent":"TEXT NOT NULL DEFAULT ''"},
    }.items():
        present = {str(row[1]) for row in db.execute("PRAGMA table_info(" + table + ")")}
        for column, definition in additions.items():
            if column not in present:
                db.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition)
    db.execute("CREATE TABLE IF NOT EXISTS plugin_cancels(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,session TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS plugin_loads(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL DEFAULT '')")
    if "scope" not in {str(row[1]) for row in db.execute("PRAGMA table_info(code_state)")}:
        db.executescript("""BEGIN IMMEDIATE;
            ALTER TABLE code_state RENAME TO code_state_unscoped;
            CREATE TABLE code_state(session TEXT NOT NULL,scope TEXT NOT NULL,document TEXT NOT NULL,
                PRIMARY KEY(session,scope));
            INSERT INTO code_state SELECT session,'',document FROM code_state_unscoped;
            DROP TABLE code_state_unscoped;
            COMMIT;""")
    ensure_resolution_schema(db)
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
                        "launch_digest": "TEXT NOT NULL DEFAULT ''",
                        "managed_id": "TEXT NOT NULL DEFAULT ''", "name": "TEXT NOT NULL DEFAULT ''",
                        "lease": "TEXT NOT NULL DEFAULT ''", "directory": "TEXT NOT NULL DEFAULT ''", "permitted": "INTEGER NOT NULL DEFAULT 0"},
        "mcp_calls": {"result_data": "TEXT", "is_error": "INTEGER NOT NULL DEFAULT 0",
                      "schema_digest": "TEXT NOT NULL DEFAULT ''", "origin": "TEXT NOT NULL DEFAULT 'manual'"},
    }.items():
        present = {str(row[1]) for row in db.execute(f"PRAGMA table_info({table})")}
        for column, definition in additions.items():
            if column not in present:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    return db.execute("SELECT * FROM control WHERE id=1").fetchone()


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

    async def initialize(self) -> sqlite3.Row:
        return await self.call(initialize_schema)
