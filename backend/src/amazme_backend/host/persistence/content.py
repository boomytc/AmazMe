import hashlib
import json
import sqlite3
import time

from amazme_backend.contracts.accounts import ProviderCheck, ProviderCheckRequest
from amazme_backend.contracts.feedback import AnswerFeedback, AnswerFeedbackWrite
from amazme_backend.contracts.projects import ProjectUpdate, ProjectView
from amazme_backend.contracts.settings import InterfacePreferences, ProductSettings
from amazme_backend.host.keys import answer_feedback_key
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


def project_row(row: sqlite3.Row) -> ProjectView:
    return ProjectView(
        project_id=str(row["id"]),
        name=str(row["name"]),
        workspaces=json.loads(str(row["workspaces"])),
        revision=int(row["revision"]),
        removed=bool(row["removed"]),
    )


async def save_project(
    self: PersistenceOwner, project_id: str, name: str, workspaces: list[str]
) -> ProjectView:
    key = hashlib.sha256(json.dumps([name, workspaces], ensure_ascii=False).encode()).hexdigest()

    def operation(db: sqlite3.Connection) -> ProjectView:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is not None:
            if str(row["digest"]) != key:
                raise BackendError("project_conflict")
            return project_row(row)
        db.execute(
            "INSERT INTO projects(id,name,digest,workspaces) VALUES(?,?,?,?)",
            (project_id, name, key, json.dumps(workspaces)),
        )
        return project_row(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())

    return await self.transaction(operation)


async def projects(self: PersistenceOwner) -> list[ProjectView]:
    return await self.call(
        lambda db: [project_row(row) for row in db.execute("SELECT * FROM projects ORDER BY rowid")]
    )


async def update_project(self: PersistenceOwner, project_id: str, value: ProjectUpdate) -> ProjectView:

    def operation(db: sqlite3.Connection) -> ProjectView:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise BackendError("project_not_found", status=404)
        current = project_row(row)
        if (current.name, current.workspaces, current.removed) == (
            value.name,
            value.workspaces,
            value.removed,
        ):
            return current
        if current.revision != value.expected_revision:
            raise BackendError("project_conflict", status=409)
        db.execute(
            "UPDATE projects SET name=?,workspaces=?,removed=?,revision=revision+1 WHERE id=?",
            (value.name, json.dumps(value.workspaces), int(value.removed), project_id),
        )
        if value.removed:
            db.execute(
                "UPDATE sessions SET archived=1,wanted=0,next_check=0 WHERE id IN (SELECT session FROM project_sessions WHERE project=?)",
                (project_id,),
            )
            db.execute(
                "UPDATE deliveries SET state='rejected',error_code='session_archived',error_status=409 WHERE kind='submit' AND state='pending' AND session IN (SELECT session FROM project_sessions WHERE project=?)",
                (project_id,),
            )
        return project_row(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())

    return await self.transaction(operation)


def settings_row(row: sqlite3.Row | None) -> ProductSettings:
    if row is None:
        return ProductSettings()
    return ProductSettings(
        display_name=str(row["display_name"]),
        revision=int(row["revision"]),
        preferences=InterfacePreferences.model_validate_json(str(row["preferences"])),
    )


async def product_settings(self: PersistenceOwner) -> ProductSettings:

    def operation(db: sqlite3.Connection) -> ProductSettings:
        return settings_row(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())

    return await self.call(operation)


async def save_product_settings(self: PersistenceOwner, name: str, expected: int) -> ProductSettings:

    def operation(db: sqlite3.Connection) -> ProductSettings:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute("SELECT display_name,revision FROM product_settings WHERE id=1").fetchone()
        current = int(row[1]) if row else 0
        if current != expected:
            raise BackendError("settings_conflict")
        revision = current + 1
        db.execute(
            "INSERT INTO product_settings(id,display_name,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,revision=excluded.revision",
            (name, revision),
        )
        return settings_row(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())

    return await self.transaction(operation)


async def save_preferences(
    self: PersistenceOwner, preferences: InterfacePreferences, expected: int
) -> ProductSettings:

    def operation(db: sqlite3.Connection) -> ProductSettings:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        current = settings_row(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())
        if current.preferences == preferences:
            return current
        if current.revision != expected:
            raise BackendError("settings_conflict", status=409)
        db.execute(
            "INSERT INTO product_settings(id,display_name,revision,preferences) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,preferences=excluded.preferences",
            (current.display_name, current.revision + 1, preferences.model_dump_json()),
        )
        return settings_row(db.execute("SELECT * FROM product_settings WHERE id=1").fetchone())

    return await self.transaction(operation)


async def save_feedback(
    self: PersistenceOwner, feedback_id: str, session_id: str, text: str, key: str
) -> tuple[str, str, str]:

    def operation(db: sqlite3.Connection) -> tuple[str, str, str]:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute("SELECT digest,session,text FROM feedback WHERE id=?", (feedback_id,)).fetchone()
        if row is not None:
            if str(row[0]) != key:
                raise BackendError("feedback_conflict")
            return (feedback_id, str(row[1]), str(row[2]))
        db.execute(
            "INSERT INTO feedback(id,session,text,digest) VALUES(?,?,?,?)",
            (feedback_id, session_id, text, key),
        )
        return (feedback_id, session_id, text)

    return await self.transaction(operation)


async def feedback_rows(self: PersistenceOwner) -> list[tuple[str, str, str]]:
    return await self.call(
        lambda db: [
            (str(row[0]), str(row[1]), str(row[2]))
            for row in db.execute("SELECT id,session,text FROM feedback ORDER BY rowid")
        ]
    )


async def save_answer_feedback(
    self: PersistenceOwner, session: str, value: AnswerFeedbackWrite
) -> AnswerFeedback:
    key = answer_feedback_key(session, value)

    def operation(db: sqlite3.Connection) -> AnswerFeedback:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute(
            "SELECT digest,payload FROM answer_feedback WHERE id=?", (value.operation_id,)
        ).fetchone()
        if row is not None:
            if str(row[0]) != key:
                raise BackendError("feedback_conflict")
            return AnswerFeedback.model_validate_json(row[1])
        if not db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone():
            raise BackendError("session_not_found", status=404)
        current = db.execute(
            "SELECT coalesce(max(revision),0) FROM answer_feedback WHERE session=? AND request=?",
            (session, value.request_id),
        ).fetchone()[0]
        if int(current) != value.expected_revision:
            raise BackendError("feedback_revision_conflict")
        result = AnswerFeedback(
            operation_id=value.operation_id,
            session_id=session,
            request_id=value.request_id,
            rating=value.rating,
            revision=value.expected_revision + 1,
        )
        db.execute(
            "INSERT INTO answer_feedback(id,session,request,revision,digest,payload) VALUES(?,?,?,?,?,?)",
            (value.operation_id, session, value.request_id, result.revision, key, result.model_dump_json()),
        )
        return result

    return await self.transaction(operation)


async def answer_feedback(self: PersistenceOwner, session: str = "") -> list[AnswerFeedback]:

    def operation(db: sqlite3.Connection) -> list[AnswerFeedback]:
        return [
            AnswerFeedback.model_validate_json(row[0])
            for row in db.execute(
                "SELECT a.payload FROM answer_feedback a WHERE (?='' OR a.session=?) AND NOT EXISTS (SELECT 1 FROM answer_feedback b WHERE b.session=a.session AND b.request=a.request AND b.revision>a.revision) ORDER BY a.rowid",
                (session, session),
            )
        ]

    return await self.call(operation)


def check_answer_feedback_row(db: sqlite3.Connection, value: AnswerFeedback) -> bool:
    rows = db.execute(
        "SELECT payload FROM answer_feedback WHERE id=? OR (session=? AND request=?) ORDER BY revision DESC LIMIT 1",
        (value.operation_id, value.session_id, value.request_id),
    ).fetchone()
    if rows is None:
        return False
    if AnswerFeedback.model_validate_json(rows[0]) != value:
        raise BackendError("import_conflict")
    return True


async def check_answer_feedback_import(self: PersistenceOwner, values: list[AnswerFeedback]) -> None:

    def operation(db: sqlite3.Connection) -> None:
        for value in values:
            check_answer_feedback_row(db, value)

    await self.call(operation)


async def import_answer_feedback(self: PersistenceOwner, values: list[AnswerFeedback]) -> None:

    def operation(db: sqlite3.Connection) -> None:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        for value in values:
            if check_answer_feedback_row(db, value):
                continue
            original = AnswerFeedbackWrite(
                operation_id=value.operation_id,
                request_id=value.request_id,
                rating=value.rating,
                expected_revision=value.revision - 1,
            )
            db.execute(
                "INSERT INTO answer_feedback(id,session,request,revision,digest,payload) VALUES(?,?,?,?,?,?)",
                (
                    value.operation_id,
                    value.session_id,
                    value.request_id,
                    value.revision,
                    answer_feedback_key(value.session_id, original),
                    value.model_dump_json(),
                ),
            )

    await self.transaction(operation)


async def begin_provider_check(
    self: PersistenceOwner, value: ProviderCheckRequest, configuration_revision: int, credential_revision: int
) -> tuple[ProviderCheck, bool]:
    key = hashlib.sha256(value.model_dump_json().encode()).hexdigest()

    def operation(db: sqlite3.Connection) -> tuple[ProviderCheck, bool]:
        stored = db.execute(
            "SELECT digest,payload FROM provider_checks WHERE id=?", (value.operation_id,)
        ).fetchone()
        if stored is not None:
            if str(stored[0]) != key:
                raise BackendError("provider_check_conflict")
            return (ProviderCheck.model_validate_json(stored[1]), False)
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        result = ProviderCheck(
            operation_id=value.operation_id,
            provider=value.provider,
            phase="unknown",
            configuration_revision=configuration_revision,
            credential_revision=credential_revision,
        )
        db.execute(
            "INSERT INTO provider_checks(id,digest,payload) VALUES(?,?,?)",
            (value.operation_id, key, result.model_dump_json()),
        )
        return (result, True)

    return await self.transaction(operation)


async def finish_provider_check(self: PersistenceOwner, result: ProviderCheck) -> ProviderCheck:

    def operation(db: sqlite3.Connection) -> ProviderCheck:
        db.execute(
            "UPDATE provider_checks SET payload=? WHERE id=?", (result.model_dump_json(), result.operation_id)
        )
        return result

    return await self.transaction(operation)


async def save_share(self: PersistenceOwner, share_id: str, session_id: str, key: str, payload: str) -> str:

    def operation(db: sqlite3.Connection) -> str:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute("SELECT digest,session,payload FROM shares WHERE id=?", (share_id,)).fetchone()
        if row is not None:
            if str(row[0]) != key or str(row[1]) != session_id:
                raise BackendError("share_conflict")
            return str(row[2])
        db.execute(
            "INSERT INTO shares(id,session,digest,payload) VALUES(?,?,?,?)",
            (share_id, session_id, key, payload),
        )
        return payload

    return await self.transaction(operation)


async def share_record(self: PersistenceOwner, share_id: str) -> tuple[str, str] | None:

    def operation(db: sqlite3.Connection) -> tuple[str, str] | None:
        row = db.execute("SELECT digest,session FROM shares WHERE id=?", (share_id,)).fetchone()
        if row is None:
            return None
        return (str(row[0]), str(row[1]))

    return await self.call(operation)


async def read_share(self: PersistenceOwner, share_id: str, session_id: str) -> str:

    def operation(db: sqlite3.Connection) -> str:
        row = db.execute(
            "SELECT payload FROM shares WHERE id=? AND session=?", (share_id, session_id)
        ).fetchone()
        if row is None:
            raise BackendError("share_not_found", status=404)
        return str(row[0])

    return await self.call(operation)


async def ensure_import_session(
    self: PersistenceOwner, session_id: str, title: str, workspace: str, project_id: str
) -> None:

    def operation(db: sqlite3.Connection) -> None:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        if (
            project_id
            and db.execute("SELECT 1 FROM projects WHERE id=? AND removed=0", (project_id,)).fetchone()
            is None
        ):
            raise BackendError("import_conflict")
        row = db.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone()
        if row is None:
            db.execute(
                "INSERT INTO sessions(id,title,workspace,updated_ms) VALUES(?,?,?,?)",
                (session_id, title, workspace, time.time_ns() // 1000000),
            )
        if project_id:
            db.execute(
                "INSERT INTO project_sessions(session,project) VALUES(?,?) ON CONFLICT(session) DO NOTHING",
                (session_id, project_id),
            )

    await self.transaction(operation)
