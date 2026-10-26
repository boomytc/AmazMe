import sqlite3

from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


async def save_memory(
    self: PersistenceOwner, memory_id: str, workspace: str, text: str, digest: str
) -> tuple[str, str, str]:

    def operation(db: sqlite3.Connection) -> tuple[str, str, str]:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        row = db.execute("SELECT workspace, text, digest FROM memories WHERE id=?", (memory_id,)).fetchone()
        if row is not None:
            if str(row[0]) != workspace or str(row[2]) != digest:
                raise BackendError("memory_conflict")
            return (memory_id, workspace, str(row[1]))
        if db.execute("SELECT count(*) FROM memories").fetchone()[0] >= 200:
            raise BackendError("memory_capacity", status=429)
        db.execute(
            "INSERT INTO memories(id,workspace,text,digest) VALUES(?,?,?,?)",
            (memory_id, workspace, text, digest),
        )
        return (memory_id, workspace, text)

    return await self.transaction(operation)


async def memory_rows(self: PersistenceOwner) -> list[tuple[str, str, str]]:

    def operation(db: sqlite3.Connection) -> list[tuple[str, str, str]]:
        try:
            rows = db.execute("SELECT id, workspace, text FROM memories ORDER BY id").fetchall()
        except sqlite3.OperationalError:
            return []
        return [(str(row[0]), str(row[1]), str(row[2])) for row in rows]

    return await self.call(operation)
