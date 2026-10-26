import hashlib
import sqlite3

from amazme_backend.contracts.execution import EditFile, WriteFile
from amazme_backend.contracts.ipc.host import PreparedFileWrite
from amazme_backend.host.keys import checkpoint_id
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.shared.errors import BackendError


def save_checkpoint_row(
    db: sqlite3.Connection, cid: str, workspace: str, path: str, digest: str, content: str
) -> None:
    row = db.execute(
        "SELECT workspace,path,digest,content FROM file_checkpoints WHERE id=?", (cid,)
    ).fetchone()
    if row is not None and tuple(row) != (workspace, path, digest, content):
        raise BackendError("checkpoint_conflict")
    used = int(db.execute("SELECT coalesce(max(used),0)+1 FROM file_checkpoints").fetchone()[0])
    if row is None:
        if db.execute("SELECT count(*) FROM file_checkpoints").fetchone()[0] >= 200:
            raise BackendError("checkpoint_capacity", status=429)
        db.execute(
            "INSERT INTO file_checkpoints(id,workspace,path,digest,content,used) VALUES(?,?,?,?,?,?)",
            (cid, workspace, path, digest, content, used),
        )
    else:
        db.execute("UPDATE file_checkpoints SET used=? WHERE id=?", (used, cid))


async def save_checkpoint(
    self: PersistenceOwner, checkpoint_id: str, workspace: str, path: str, digest: str, content: str
) -> tuple[str, str, str, str]:

    def operation(db: sqlite3.Connection) -> tuple[str, str, str, str]:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        save_checkpoint_row(db, checkpoint_id, workspace, path, digest, content)
        return (checkpoint_id, workspace, path, digest)

    return await self.transaction(operation)


async def file_write_preparation(
    self: PersistenceOwner, session: str, call: str, write: WriteFile | EditFile
) -> PreparedFileWrite | None:
    digest = hashlib.sha256(write.model_dump_json().encode()).hexdigest()

    def operation(db: sqlite3.Connection) -> PreparedFileWrite | None:
        row = db.execute(
            "SELECT request_digest,payload FROM file_write_preparations WHERE session=? AND call=?",
            (session, call),
        ).fetchone()
        if row is None:
            return None
        if row[0] != digest:
            raise BackendError("call_conflict")
        return PreparedFileWrite.model_validate_json(row[1])

    return await self.call(operation)


async def prepare_file_write(
    self: PersistenceOwner,
    session: str,
    call: str,
    write: WriteFile | EditFile,
    workspace: str,
    path: str,
    previous: tuple[str, str] | None,
    root: str,
) -> PreparedFileWrite:
    request_digest = hashlib.sha256(write.model_dump_json().encode()).hexdigest()

    def operation(db: sqlite3.Connection) -> PreparedFileWrite:
        if str(db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]):
            raise BackendError("update_frozen", status=503)
        old = db.execute(
            "SELECT request_digest,payload FROM file_write_preparations WHERE session=? AND call=?",
            (session, call),
        ).fetchone()
        if old:
            if old[0] != request_digest:
                raise BackendError("call_conflict")
            return PreparedFileWrite.model_validate_json(old[1])
        digest, content = previous if previous is not None else ("", "")
        cid = checkpoint_id(workspace, path, digest) if previous is not None else ""
        if cid:
            save_checkpoint_row(db, cid, workspace, path, digest, content)
        prepared = PreparedFileWrite(call_id=call, path=path, expected_digest=digest, checkpoint_id=cid, root=root)
        db.execute(
            "INSERT INTO file_write_preparations VALUES(?,?,?,?)",
            (session, call, request_digest, prepared.model_dump_json()),
        )
        return prepared

    return await self.transaction(operation)


async def checkpoints_for(
    self: PersistenceOwner, workspace: str, path: str
) -> list[tuple[str, str, str, str]]:

    def operation(db: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
        rows = db.execute(
            "SELECT id, workspace, path, digest FROM file_checkpoints WHERE workspace=? AND path=? ORDER BY used,rowid",
            (workspace, path),
        ).fetchall()
        return [(str(row[0]), str(row[1]), str(row[2]), str(row[3])) for row in rows]

    return await self.call(operation)


async def checkpoint(self: PersistenceOwner, checkpoint_id: str) -> tuple[str, str, str, str, str] | None:

    def operation(db: sqlite3.Connection) -> tuple[str, str, str, str, str] | None:
        row = db.execute(
            "SELECT id, workspace, path, digest, content FROM file_checkpoints WHERE id=?", (checkpoint_id,)
        ).fetchone()
        if row is None:
            return None
        return (str(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4]))

    return await self.call(operation)
