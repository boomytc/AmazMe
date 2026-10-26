import sqlite3

from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


def grant_present(db: sqlite3.Connection, workspace: str) -> bool:
    """Primary is the profile directory. Any other name must still be granted."""
    if workspace == "primary":
        return True
    try:
        row = db.execute("SELECT 1 FROM workspace_grants WHERE name=?", (workspace,)).fetchone()
    except sqlite3.OperationalError:
        return False
    return row is not None


async def workspace_grants(self: PersistenceOwner) -> list[tuple[str, str]]:

    def operation(db: sqlite3.Connection) -> list[tuple[str, str]]:
        try:
            rows = db.execute("SELECT name, host_path FROM workspace_grants ORDER BY name").fetchall()
        except sqlite3.OperationalError:
            return []
        return [(str(row[0]), str(row[1])) for row in rows]

    return await self.call(operation)


async def add_workspace_grant(self: PersistenceOwner, name: str, host_path: str) -> None:

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
        db.execute(
            "INSERT INTO workspace_grants(name, host_path) VALUES(?,?) ON CONFLICT(name) DO NOTHING",
            (name, host_path),
        )

    await self.transaction(operation)


async def remove_workspace_grant(self: PersistenceOwner, name: str) -> None:

    def operation(db: sqlite3.Connection) -> None:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        if db.execute("DELETE FROM workspace_grants WHERE name=?", (name,)).rowcount != 1:
            raise BackendError("workspace_not_found", status=404)

    await self.transaction(operation)
