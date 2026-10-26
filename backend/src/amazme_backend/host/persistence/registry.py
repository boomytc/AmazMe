import sqlite3

from amazme_backend.contracts.execution import ProcessLease, ServiceInfo
from amazme_backend.host.keys import now_ms
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.host.records import ServiceRecord
from amazme_backend.shared.errors import BackendError


async def port(self: PersistenceOwner, value: int | None = None) -> int:

    def operation(db: sqlite3.Connection) -> int:
        if value is not None:
            db.execute("UPDATE control SET port=? WHERE id=1", (value,))
        return int(db.execute("SELECT port FROM control WHERE id=1").fetchone()[0])

    return await self.call(operation)


async def service(self: PersistenceOwner) -> ServiceRecord | None:

    def operation(db: sqlite3.Connection) -> ServiceRecord | None:
        records = [
            ServiceRecord.model_validate_json(row[0])
            for row in db.execute("SELECT payload FROM services ORDER BY ordinal")
        ]
        live = [value for value in records if value.state != "stopped"]
        if len(live) > 1:
            raise BackendError("supervisor_registry_conflict", status=503)
        return live[0] if live else None

    return await self.call(operation)


async def services(self: PersistenceOwner) -> list[ServiceInfo]:
    return await self.call(
        lambda db: [
            ServiceInfo.model_validate_json(row[0])
            for row in db.execute("SELECT payload FROM services ORDER BY ordinal")
        ]
    )


async def blocked(self: PersistenceOwner) -> str:
    return await self.call(lambda db: str(db.execute("SELECT blocked FROM control WHERE id=1").fetchone()[0]))


async def last_build(self: PersistenceOwner, current: str) -> str:

    def operation(db: sqlite3.Connection) -> str:
        row = db.execute(
            "SELECT build FROM hosts WHERE instance!=? ORDER BY epoch DESC LIMIT 1", (current,)
        ).fetchone()
        return str(row[0]) if row else ""

    return await self.call(operation)


async def save_service(self: PersistenceOwner, value: ServiceRecord) -> None:

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
        elif any(
            (
                ServiceRecord.model_validate_json(row[0]).state != "stopped"
                for row in db.execute("SELECT payload FROM services")
            )
        ):
            raise BackendError("supervisor_registry_conflict", status=503)
        db.execute(
            "INSERT INTO services(instance,payload) VALUES(?,?) ON CONFLICT(instance) DO UPDATE SET payload=excluded.payload",
            (value.instance_id, value.model_dump_json()),
        )
        if value.state == "running":
            db.execute("UPDATE control SET execution_initialized=1 WHERE id=1")

    await self.transaction(operation)


async def execution_initialized(self: PersistenceOwner) -> bool:
    return await self.call(
        lambda db: bool(db.execute("SELECT execution_initialized FROM control WHERE id=1").fetchone()[0])
    )


async def allow_restart(self: PersistenceOwner, *, explicit: bool = False) -> None:

    def operation(db: sqlite3.Connection) -> bool:
        if explicit:
            db.execute("DELETE FROM restarts")
            db.execute("UPDATE control SET blocked='' WHERE id=1")
        db.execute("DELETE FROM restarts WHERE at<?", (now_ms() - 600000,))
        blocked = db.execute("SELECT blocked FROM control WHERE id=1").fetchone()[0]
        if blocked or db.execute("SELECT count(*) FROM restarts").fetchone()[0] >= 3:
            db.execute("UPDATE control SET blocked='supervisor_restart_budget' WHERE id=1")
            return False
        db.execute("INSERT INTO restarts VALUES(?)", (now_ms(),))
        return True

    if not await self.transaction(operation):
        raise BackendError("supervisor_restart_budget", status=503)


async def source_hosts(self: PersistenceOwner, current: str) -> list[ProcessLease]:
    return await self.call(
        lambda db: [
            ProcessLease.model_validate_json(row[0])
            for row in db.execute("SELECT lease FROM hosts WHERE instance!=?", (current,))
        ]
    )
