import hashlib
import json
import sqlite3
import time

from amazme_backend.contracts.ipc.worker import WorkerActivity
from amazme_backend.contracts.sessions import CreateSession, Session, SessionList, SessionModel
from amazme_backend.host.keys import now_ms
from amazme_backend.host.persistence import content, rows
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


async def sessions(self: PersistenceOwner) -> SessionList:
    return await self.call(
        lambda db: SessionList(
            sessions=[
                rows.session_row(row) for row in db.execute(rows.session_sql("ORDER BY s.updated_ms,s.rowid"))
            ]
        )
    )


async def session(self: PersistenceOwner, session_id: str) -> Session | None:

    def operation(db: sqlite3.Connection) -> Session | None:
        row = db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone()
        return rows.session_row(row) if row is not None else None

    return await self.call(operation)


async def session_model(self: PersistenceOwner, session_id: str) -> SessionModel | None:

    def operation(db: sqlite3.Connection) -> SessionModel | None:
        row = db.execute(
            "SELECT provider, model FROM session_models WHERE session=?", (session_id,)
        ).fetchone()
        if row is None:
            return None
        return SessionModel(session_id=session_id, provider=str(row[0]), model=str(row[1]))

    return await self.db.call(operation)


async def save_session_model(self: PersistenceOwner, value: SessionModel) -> SessionModel:

    def operation(db: sqlite3.Connection) -> SessionModel:
        db.execute(
            "INSERT INTO session_models(session, provider, model) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET provider=excluded.provider, model=excluded.model",
            (value.session_id, value.provider, value.model),
        )
        return value

    return await self.transaction(operation)


async def create_session(self: PersistenceOwner, session_id: str, value: CreateSession) -> Session:
    creation = hashlib.sha256(value.model_dump_json(exclude={"session_id"}).encode()).hexdigest()

    def operation(db: sqlite3.Connection) -> Session:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        if db.execute("SELECT 1 FROM session_removals WHERE session=?", (session_id,)).fetchone():
            raise BackendError("session_removed")
        workspace = value.workspace or "primary"
        project_id = value.project_id
        row = db.execute(
            "SELECT title, workspace, create_digest FROM sessions WHERE id=?", (session_id,)
        ).fetchone()
        if row is not None:
            if str(row["create_digest"]):
                if str(row["create_digest"]) != creation:
                    raise BackendError("session_conflict")
                return rows.session_row(
                    db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone()
                )
            linked = db.execute(
                "SELECT project FROM project_sessions WHERE session=?", (session_id,)
            ).fetchone()
            stored_project = "" if linked is None else str(linked[0])
            if (
                str(row[0]) != value.title
                or str(row[1] or "primary") != workspace
                or stored_project != project_id
            ):
                raise BackendError("session_conflict")
            return rows.session_row(db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone())
        if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 128:
            raise BackendError("session_capacity", status=429)
        if (
            project_id
            and db.execute("SELECT 1 FROM projects WHERE id=? AND removed=0", (project_id,)).fetchone()
            is None
        ):
            raise BackendError("project_not_found", status=404)
        if project_id:
            project = content.project_row(
                db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            )
            if workspace not in project.workspaces:
                raise BackendError("project_workspace_mismatch")
        db.execute(
            "INSERT INTO sessions(id,title,workspace,updated_ms,create_digest) VALUES(?,?,?,?,?)",
            (session_id, value.title, workspace, time.time_ns() // 1000000, creation),
        )
        if project_id:
            db.execute("INSERT INTO project_sessions(session,project) VALUES(?,?)", (session_id, project_id))
        return rows.session_row(db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone())

    return await self.transaction(operation)


async def create_branch(
    self: PersistenceOwner,
    session_id: str,
    parent_id: str,
    fork_request_id: str,
    title: str,
    request_key: str = "",
) -> Session:
    creation = (
        request_key or hashlib.sha256(json.dumps([parent_id, fork_request_id, title]).encode()).hexdigest()
    )

    def operation(db: sqlite3.Connection) -> Session:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        if db.execute("SELECT 1 FROM session_removals WHERE session=?", (session_id,)).fetchone():
            raise BackendError("session_removed")
        existing = db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone()
        if existing is not None:
            stored = db.execute("SELECT create_digest FROM sessions WHERE id=?", (session_id,)).fetchone()
            if str(stored[0]) != creation:
                raise BackendError("branch_conflict")
            return rows.session_row(existing)
        parent = db.execute("SELECT workspace FROM sessions WHERE id=?", (parent_id,)).fetchone()
        if parent is None:
            raise BackendError("session_not_found", status=404)
        if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 128:
            raise BackendError("session_capacity", status=429)
        workspace = str(parent[0] or "primary")
        project = db.execute("SELECT project FROM project_sessions WHERE session=?", (parent_id,)).fetchone()
        project_id = str(project[0]) if project else ""
        db.execute(
            "INSERT INTO sessions(id,title,parent_id,fork_request_id,workspace,updated_ms,create_digest,branch_ready) VALUES(?,?,?,?,?,?,?,0)",
            (session_id, title, parent_id, fork_request_id, workspace, time.time_ns() // 1000000, creation),
        )
        db.execute(
            "INSERT INTO session_models(session,provider,model) SELECT ?,provider,model FROM session_models WHERE session=?",
            (session_id, parent_id),
        )
        if project_id:
            db.execute("INSERT INTO project_sessions(session,project) VALUES(?,?)", (session_id, project_id))
        return rows.session_row(db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone())

    return await self.transaction(operation)


async def prepared_branch(self: PersistenceOwner, session: str) -> Session:

    def operation(db: sqlite3.Connection) -> Session:
        db.execute("UPDATE sessions SET branch_ready=1 WHERE id=?", (session,))
        return rows.session_row(db.execute(rows.session_sql("WHERE s.id=?"), (session,)).fetchone())

    return await self.transaction(operation)


async def discard_unopened_branch(self: PersistenceOwner, session_id: str) -> None:

    def operation(db: sqlite3.Connection) -> None:
        row = db.execute("SELECT parent_id FROM sessions WHERE id=?", (session_id,)).fetchone()
        if row is None:
            return
        if (
            not str(row[0])
            or db.execute("SELECT 1 FROM deliveries WHERE session=?", (session_id,)).fetchone()
        ):
            raise BackendError("branch_discard_refused")
        db.execute("DELETE FROM project_sessions WHERE session=?", (session_id,))
        db.execute("DELETE FROM session_models WHERE session=?", (session_id,))
        db.execute("DELETE FROM sessions WHERE id=?", (session_id,))

    await self.transaction(operation)


async def exists(self: PersistenceOwner, session: str) -> bool:
    return await self.call(
        lambda db: db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone() is not None
    )


async def set_archived(self: PersistenceOwner, session_id: str, archived: bool) -> Session:

    def operation(db: sqlite3.Connection) -> Session:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        if (
            not archived
            and db.execute("SELECT 1 FROM session_removals WHERE session=?", (session_id,)).fetchone()
        ):
            raise BackendError("session_removal_pending")
        current = db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone()
        if current is None:
            raise BackendError("session_not_found", status=404)
        db.execute("UPDATE sessions SET archived=? WHERE id=?", (int(archived), session_id))
        if archived:
            db.execute("UPDATE sessions SET wanted=0,next_check=0 WHERE id=?", (session_id,))
            db.execute(
                "UPDATE deliveries SET state='rejected',error_code='session_archived',error_status=409 WHERE session=? AND kind='submit' AND state='pending'",
                (session_id,),
            )
        return rows.session_row(db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone())

    return await self.transaction(operation)


async def rename_session(self: PersistenceOwner, session_id: str, title: str, expected: str) -> Session:

    def operation(db: sqlite3.Connection) -> Session:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone()
        if row is None:
            raise BackendError("session_not_found", status=404)
        if str(row["title"]) not in {expected, title}:
            raise BackendError("session_conflict", status=409)
        db.execute("UPDATE sessions SET title=? WHERE id=?", (title, session_id))
        return rows.session_row(db.execute(rows.session_sql("WHERE s.id=?"), (session_id,)).fetchone())

    return await self.transaction(operation)


async def begin_session_removal(self: PersistenceOwner, session: str) -> bool:

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
        db.execute(
            "UPDATE deliveries SET state='rejected',error_code='session_removed',error_status=409 WHERE session=? AND kind='submit' AND state='pending'",
            (session,),
        )
        return True

    return await self.transaction(operation)


async def finish_session_removal(self: PersistenceOwner, session: str) -> None:

    def operation(db: sqlite3.Connection) -> None:
        if not db.execute("SELECT 1 FROM session_removals WHERE session=?", (session,)).fetchone():
            raise BackendError("session_removal_pending")
        db.execute(
            "DELETE FROM schedule_runs WHERE schedule IN (SELECT id FROM schedules WHERE session=?)",
            (session,),
        )
        for table in (
            "project_sessions",
            "session_models",
            "deliveries",
            "schedules",
            "mcp_reconnects",
            "feedback",
            "answer_feedback",
            "shares",
            "file_write_preparations",
        ):
            db.execute(f"DELETE FROM {table} WHERE session=?", (session,))
        db.execute("DELETE FROM sessions WHERE id=?", (session,))
        db.execute("UPDATE session_removals SET completed=1 WHERE session=?", (session,))

    await self.transaction(operation)


async def activity(self: PersistenceOwner, session: str, activity: WorkerActivity) -> None:
    wanted = activity.runnable or activity.next_wake_ms > 0
    check = now_ms() + 500 if activity.runnable else activity.next_wake_ms
    await self.call(
        lambda db: db.execute(
            "UPDATE sessions SET wanted=?,next_check=? WHERE id=?", (int(wanted), check, session)
        )
    )


async def demand(self: PersistenceOwner, session: str = "") -> None:
    await self.call(
        lambda db: db.execute(
            "UPDATE sessions SET wanted=1,next_check=0 WHERE archived=0 AND (?='' OR id=?)",
            (session, session),
        )
    )


async def due(self: PersistenceOwner) -> list[str]:
    return await self.call(
        lambda db: [
            str(row[0])
            for row in db.execute(
                "SELECT id FROM sessions WHERE wanted=1 AND next_check<=? ORDER BY next_check LIMIT 128",
                (now_ms(),),
            )
        ]
    )
