import sqlite3

from amazme_backend.contracts.execution import ProcessLease
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.platform.sqlite_schema import require_schema
from amazme_backend.shared.errors import BackendError

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS control(
    id INTEGER PRIMARY KEY,
    epoch INTEGER NOT NULL,
    port INTEGER NOT NULL DEFAULT 0,
    freeze_id TEXT NOT NULL DEFAULT '',
    blocked TEXT NOT NULL DEFAULT '',
    execution_initialized INTEGER NOT NULL DEFAULT 0,
    quitting INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hosts(
    epoch INTEGER PRIMARY KEY,
    instance TEXT UNIQUE NOT NULL,
    build TEXT NOT NULL,
    lease TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services(
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    instance TEXT UNIQUE NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    wanted INTEGER NOT NULL DEFAULT 0,
    next_check INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT NOT NULL DEFAULT '',
    fork_request_id TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    updated_ms INTEGER NOT NULL DEFAULT 0,
    workspace TEXT NOT NULL DEFAULT 'primary',
    create_digest TEXT NOT NULL DEFAULT '',
    branch_ready INTEGER NOT NULL DEFAULT 1,
    empty_draft INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_removals(
    session TEXT PRIMARY KEY,
    completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deliveries(
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session TEXT NOT NULL,
    kind TEXT NOT NULL,
    digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    receipt TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    error_status INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS updates(
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restarts(
    at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_grants(
    name TEXT PRIMARY KEY,
    host_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories(
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    text TEXT NOT NULL,
    digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_checkpoints(
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    path TEXT NOT NULL,
    digest TEXT NOT NULL,
    content TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS file_write_preparations(
    session TEXT NOT NULL,
    call TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(session,call)
);
CREATE TABLE IF NOT EXISTS schedules(
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS schedule_runs(
    schedule TEXT NOT NULL,
    request TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(schedule,request)
);
CREATE TABLE IF NOT EXISTS plugin_packages(
    id TEXT PRIMARY KEY,
    entry TEXT NOT NULL,
    intent TEXT NOT NULL,
    phase TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_package_revision(
    id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_configuration(
    workspace TEXT NOT NULL,
    name TEXT NOT NULL,
    id TEXT NOT NULL,
    launch TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(workspace,name)
);
CREATE TABLE IF NOT EXISTS mcp_config_revision(
    id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_config_changes(
    id TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_logins(
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    view TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_reconnects(
    operation TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    name TEXT NOT NULL,
    launch TEXT NOT NULL,
    server TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    digest TEXT NOT NULL,
    workspaces TEXT NOT NULL DEFAULT '["primary"]',
    revision INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_sessions(
    session TEXT PRIMARY KEY,
    project TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_settings(
    id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    preferences TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS feedback(
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    text TEXT NOT NULL,
    digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answer_feedback(
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    request TEXT NOT NULL,
    revision INTEGER NOT NULL,
    digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(session,request,revision)
);
CREATE TABLE IF NOT EXISTS provider_checks(
    id TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shares(
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    digest TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_models(
    session TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_create_aliases(
    id TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    session TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS update_supersessions(
    update_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(update_id,revision)
);
PRAGMA user_version=2;
INSERT OR IGNORE INTO control(id,epoch) VALUES(1,0);
INSERT OR IGNORE INTO plugin_package_revision(id,revision) VALUES(1,0);
INSERT OR IGNORE INTO mcp_config_revision(id,revision) VALUES(1,0);
COMMIT;
"""


def preflight(db: sqlite3.Connection) -> None:
    require_schema(db, SCHEMA)
    control = db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()
    if control is None:
        raise BackendError("storage_incomplete", status=503)
    if control[0] and (not db.execute("SELECT 1 FROM updates WHERE id=?", (control[0],)).fetchone()):
        raise BackendError("storage_corrupt", status=503)


async def initialize(self: PersistenceOwner, instance: str, build: str, lease: ProcessLease) -> int:

    def create(db: sqlite3.Connection) -> None:
        db.executescript(SCHEMA)

    await self.call(create)

    def begin(db: sqlite3.Connection) -> int:
        if db.execute("SELECT quitting FROM control WHERE id=1").fetchone()[0]:
            db.execute(
                "UPDATE deliveries SET state='rejected',error_code='host_stopping',error_status=503 WHERE state='pending'"
            )
        db.execute("UPDATE control SET epoch=epoch+1,quitting=0 WHERE id=1")
        epoch = int(db.execute("SELECT epoch FROM control WHERE id=1").fetchone()[0])
        db.execute("INSERT INTO hosts VALUES(?,?,?,?)", (epoch, instance, build, lease.model_dump_json()))
        return epoch

    return await self.transaction(begin)
