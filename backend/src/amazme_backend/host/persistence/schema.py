import sqlite3

from amazme_backend.contracts.execution import ProcessLease
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


def preflight(db: sqlite3.Connection) -> None:
    required = {
        "control": {"id", "epoch", "port", "freeze_id", "blocked", "execution_initialized"},
        "hosts": {"epoch", "instance", "build", "lease"},
        "services": {"ordinal", "instance", "payload"},
        "sessions": {"id", "title", "wanted", "next_check"},
        "deliveries": {
            "ordinal",
            "id",
            "session",
            "kind",
            "digest",
            "payload",
            "state",
            "receipt",
            "error_code",
            "error_status",
        },
        "updates": {"ordinal", "id", "payload"},
        "restarts": {"at"},
    }
    for table, columns in required.items():
        if not columns <= {str(row[1]) for row in db.execute(f"PRAGMA table_info({table})")}:
            raise BackendError("storage_incomplete", status=503)
    control = db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()
    if control is None:
        raise BackendError("storage_incomplete", status=503)
    if control[0] and (not db.execute("SELECT 1 FROM updates WHERE id=?", (control[0],)).fetchone()):
        raise BackendError("storage_corrupt", status=503)


async def initialize(self: PersistenceOwner, instance: str, build: str, lease: ProcessLease) -> int:

    def create(db: sqlite3.Connection) -> None:
        db.executescript(
            "\n                CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,\n                  port INTEGER NOT NULL DEFAULT 0,freeze_id TEXT NOT NULL DEFAULT '',blocked TEXT NOT NULL DEFAULT '',\n                  execution_initialized INTEGER NOT NULL DEFAULT 0,quitting INTEGER NOT NULL DEFAULT 0);\n                INSERT OR IGNORE INTO control(id,epoch) VALUES(1,0);\n                CREATE TABLE IF NOT EXISTS hosts(epoch INTEGER PRIMARY KEY,instance TEXT UNIQUE NOT NULL,\n                  build TEXT NOT NULL,lease TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS services(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,\n                  instance TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,\n                  wanted INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL DEFAULT 0,\n                  parent_id TEXT NOT NULL DEFAULT '',fork_request_id TEXT NOT NULL DEFAULT '',\n                  archived INTEGER NOT NULL DEFAULT 0);\n                CREATE TABLE IF NOT EXISTS session_removals(session TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0);\n                CREATE TABLE IF NOT EXISTS deliveries(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,\n                  id TEXT UNIQUE NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,\n                  payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',receipt TEXT NOT NULL DEFAULT '',\n                  error_code TEXT NOT NULL DEFAULT '',error_status INTEGER NOT NULL DEFAULT 0);\n                CREATE TABLE IF NOT EXISTS updates(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,\n                  id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS restarts(at INTEGER NOT NULL);\n                CREATE TABLE IF NOT EXISTS workspace_grants(name TEXT PRIMARY KEY, host_path TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, workspace TEXT NOT NULL,\n                  text TEXT NOT NULL, digest TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS file_checkpoints(id TEXT PRIMARY KEY, workspace TEXT NOT NULL,\n                  path TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);\n                CREATE TABLE IF NOT EXISTS file_write_preparations(session TEXT NOT NULL, call TEXT NOT NULL,\n                  request_digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session,call));\n                CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, session TEXT NOT NULL,\n                  digest TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);\n                CREATE TABLE IF NOT EXISTS schedule_runs(schedule TEXT NOT NULL,request TEXT NOT NULL,\n                  outcome TEXT NOT NULL DEFAULT '',PRIMARY KEY(schedule,request));\n                CREATE TABLE IF NOT EXISTS plugin_packages(id TEXT PRIMARY KEY,entry TEXT NOT NULL,intent TEXT NOT NULL,phase TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS plugin_package_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);\n                INSERT OR IGNORE INTO plugin_package_revision(id,revision) VALUES(1,0);\n                CREATE TABLE IF NOT EXISTS mcp_configuration(workspace TEXT NOT NULL,name TEXT NOT NULL,id TEXT NOT NULL,\n                  launch TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace,name));\n                CREATE TABLE IF NOT EXISTS mcp_config_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);\n                INSERT OR IGNORE INTO mcp_config_revision(id,revision) VALUES(1,0);\n                CREATE TABLE IF NOT EXISTS mcp_config_changes(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS mcp_logins(id TEXT PRIMARY KEY,payload TEXT NOT NULL,view TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS mcp_reconnects(operation TEXT PRIMARY KEY,session TEXT NOT NULL,name TEXT NOT NULL,\n                  launch TEXT NOT NULL,server TEXT NOT NULL,payload TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS project_sessions(session TEXT PRIMARY KEY, project TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS product_settings(id INTEGER PRIMARY KEY, display_name TEXT NOT NULL,\n                  revision INTEGER NOT NULL);\n                CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, session TEXT NOT NULL,\n                  text TEXT NOT NULL, digest TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS answer_feedback(id TEXT PRIMARY KEY,session TEXT NOT NULL,request TEXT NOT NULL,\n                  revision INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(session,request,revision));\n                CREATE TABLE IF NOT EXISTS provider_checks(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, session TEXT NOT NULL,\n                  digest TEXT NOT NULL, payload TEXT NOT NULL);\n                CREATE TABLE IF NOT EXISTS session_models(\n                  session TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL);\n                PRAGMA user_version=2;\n            "
        )
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
        present = {str(row[1]) for row in db.execute("PRAGMA table_info(sessions)")}
        if "parent_id" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''")
        if "fork_request_id" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN fork_request_id TEXT NOT NULL DEFAULT ''")
        if "archived" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        if "workspace" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN workspace TEXT NOT NULL DEFAULT 'primary'")
        if "create_digest" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN create_digest TEXT NOT NULL DEFAULT ''")
        if "branch_ready" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN branch_ready INTEGER NOT NULL DEFAULT 1")
        if "empty_draft" not in present:
            db.execute("ALTER TABLE sessions ADD COLUMN empty_draft INTEGER NOT NULL DEFAULT 0")
        db.execute("CREATE TABLE IF NOT EXISTS session_create_aliases(id TEXT PRIMARY KEY,digest TEXT NOT NULL,session TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS update_supersessions(update_id TEXT NOT NULL,revision TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(update_id,revision))")
        settings_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(product_settings)")}
        if "preferences" not in settings_columns:
            db.execute("ALTER TABLE product_settings ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'")
        project_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(projects)")}
        for name, declaration in {
            "workspaces": "TEXT NOT NULL DEFAULT '[\"primary\"]'",
            "revision": "INTEGER NOT NULL DEFAULT 0",
            "removed": "INTEGER NOT NULL DEFAULT 0",
        }.items():
            if name not in project_columns:
                db.execute(f"ALTER TABLE projects ADD COLUMN {name} {declaration}")
        if "quitting" not in {str(row[1]) for row in db.execute("PRAGMA table_info(control)")}:
            db.execute("ALTER TABLE control ADD COLUMN quitting INTEGER NOT NULL DEFAULT 0")

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
