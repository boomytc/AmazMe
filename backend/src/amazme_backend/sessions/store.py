"""The session transaction owner; all operations share one database executor."""
import sqlite3
from collections.abc import Callable
from pathlib import Path

from amazme_backend.contracts.events import CommitBatch
from amazme_backend.sessions.persistence.database import Database
from amazme_backend.sessions.persistence.records import Changes, metadata_value, set_metadata_value
from amazme_backend.sessions.persistence.schema import preflight
from amazme_backend.sessions.persistence.state import SessionContext
from amazme_backend.sessions.policy.limits import RETAIN_BATCHES, RETAIN_BYTES


class SessionTransactions:
    def __init__(self, path: Path, state: SessionContext, *, require_existing: bool, read_only: bool):
        self.state = state
        self.database = Database(path, require_existing=require_existing, read_only=read_only, preflight=preflight)

    async def transact[T](self, operation: Callable[[sqlite3.Connection, Changes], T]) -> T:
        def transact(db: sqlite3.Connection) -> tuple[T, Changes]:
            db.execute("BEGIN IMMEDIATE")
            changes = Changes(int(metadata_value(db, "revision")) + 1)
            try:
                result = operation(db, changes)
                if changes.events:
                    batch = CommitBatch(stream_id=metadata_value(db, "stream_id"), seq=str(changes.seq),
                                        base_revision=str(changes.seq - 1), revision=str(changes.seq),
                                        events=changes.events)
                    payload = batch.model_dump_json()
                    db.execute("INSERT INTO batches VALUES(?,?,?)", (changes.seq, payload, len(payload.encode())))
                    set_metadata_value(db, "revision", str(changes.seq))
                    db.execute("DELETE FROM batches WHERE seq<=?", (changes.seq - RETAIN_BATCHES,))
                    while db.execute("SELECT coalesce(sum(bytes),0) FROM batches").fetchone()[0] > RETAIN_BYTES:
                        first = db.execute("SELECT min(seq) FROM batches").fetchone()[0]
                        if first == changes.seq:
                            break
                        db.execute("DELETE FROM batches WHERE seq=?", (first,))
                if self.state.faults:
                    for point, request_id, call_id in changes.hooks:
                        if point == "accepted":
                            self.state.faults.sync_hit("before_commit", session_id=self.state.session_id,
                                                 request_id=request_id, call_id=call_id)
                db.execute("COMMIT")
                return result, changes
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        result, changes = await self.database.call(transact)
        if self.state.faults:
            for point, request_id, call_id in changes.hooks:
                await self.state.faults.hit(point, session_id=self.state.session_id, request_id=request_id, call_id=call_id)
        return result
