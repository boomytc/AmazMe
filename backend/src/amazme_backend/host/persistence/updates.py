import sqlite3

from amazme_backend.contracts.execution import WorkerInfo
from amazme_backend.contracts.host import PrepareUpdate, UpdateRecord
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


async def active_update(self: PersistenceOwner) -> UpdateRecord | None:

    def operation(db: sqlite3.Connection) -> UpdateRecord | None:
        identity = str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0])
        if not identity:
            return None
        row = db.execute("SELECT payload FROM updates WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise BackendError("storage_corrupt", status=503)
        return UpdateRecord.model_validate_json(row[0])

    return await self.call(operation)


async def update(self: PersistenceOwner, identity: str) -> UpdateRecord:

    def operation(db: sqlite3.Connection) -> UpdateRecord:
        row = db.execute("SELECT payload FROM updates WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise BackendError("update_not_found", status=404)
        return UpdateRecord.model_validate_json(row[0])

    return await self.call(operation)


async def begin_update(self: PersistenceOwner, value: PrepareUpdate, source: str) -> UpdateRecord:

    def operation(db: sqlite3.Connection) -> UpdateRecord:
        existing = db.execute("SELECT payload FROM updates WHERE id=?", (value.update_id,)).fetchone()
        if existing:
            result = UpdateRecord.model_validate_json(existing[0])
            if result.target_build != value.target_build or result.cancel_work != value.cancel_work:
                raise BackendError("update_conflict")
            return result
        if db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]:
            raise BackendError("update_in_progress")
        result = UpdateRecord(
            update_id=value.update_id,
            source_build=source,
            target_build=value.target_build,
            phase="freezing",
            revision="1",
            cancel_work=value.cancel_work,
        )
        db.execute("INSERT INTO updates(id,payload) VALUES(?,?)", (value.update_id, result.model_dump_json()))
        db.execute("UPDATE control SET freeze_id=? WHERE id=1", (value.update_id,))
        return result

    return await self.transaction(operation)


async def save_update(self: PersistenceOwner, value: UpdateRecord) -> UpdateRecord:

    def operation(db: sqlite3.Connection) -> UpdateRecord:
        old = UpdateRecord.model_validate_json(
            db.execute("SELECT payload FROM updates WHERE id=?", (value.update_id,)).fetchone()[0]
        )
        if value.revision != old.revision:
            raise BackendError("update_revision_conflict")
        if (value.source_build, value.target_build, value.cancel_work) != (
            old.source_build,
            old.target_build,
            old.cancel_work,
        ) or (old.activated and (not value.activated)):
            raise BackendError("invalid_update_transition")
        verify_roster(old.roster, value.roster)
        if (
            not old.activated
            and db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0] != value.update_id
        ):
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


def verify_roster(previous: list[WorkerInfo], current: list[WorkerInfo]) -> None:
    indexed = {worker.worker_id: worker for worker in current}
    if len(indexed) != len(current):
        raise BackendError("participant_identity_mismatch", status=503)
    for old in previous:
        worker = indexed.get(old.worker_id)
        if worker is None:
            raise BackendError("participant_missing", old.worker_id, 503)
        if (worker.session_id, worker.build_id, worker.process_lease, worker.purpose) != (
            old.session_id,
            old.build_id,
            old.process_lease,
            old.purpose,
        ) or (old.state == "stopped" and worker.state != "stopped"):
            raise BackendError("participant_identity_mismatch", old.worker_id, 503)


async def source_roster(self: PersistenceOwner, identity: str, roster: list[WorkerInfo]) -> UpdateRecord:

    def operation(db: sqlite3.Connection) -> UpdateRecord:
        row = db.execute("SELECT payload FROM updates WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise BackendError("update_not_found", status=404)
        value = UpdateRecord.model_validate_json(row[0])
        verify_roster(value.roster, roster)
        if value.roster != roster:
            if value.activated:
                raise BackendError("invalid_update_transition")
            value.roster = roster
            value.revision = str(int(value.revision) + 1)
            db.execute("UPDATE updates SET payload=? WHERE id=?", (value.model_dump_json(), identity))
        return value

    return await self.transaction(operation)
