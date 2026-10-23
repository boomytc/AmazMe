import asyncio
import hashlib
import secrets
import sqlite3
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pydantic import TypeAdapter

from .contracts import BackendError, Event, Message, Receipt, Snapshot, Status, Submit, WorkerState


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sqlite-owner")
        self.connection: sqlite3.Connection | None = None

    def _invoke[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.connection is None:
            if self.path.exists():
                # Inspect an unknown format without creating WAL files or changing its journal mode.
                with sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True) as probe:
                    version = probe.execute("PRAGMA user_version").fetchone()[0]
                probe.close()
                if version not in (0, 1):
                    raise BackendError("unsupported_storage_format")
            self.connection = sqlite3.connect(self.path, isolation_level=None)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA foreign_keys=ON")
        return operation(self.connection)

    async def call[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        # Cancellation ends waiting, not an already submitted transaction.
        return await asyncio.shield(asyncio.get_running_loop().run_in_executor(self.pool, self._invoke, operation))

    async def close(self) -> None:
        def close_connection() -> None:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
        try:
            await asyncio.get_running_loop().run_in_executor(self.pool, close_connection)
        finally:
            self.pool.shutdown(wait=True)


class SessionStore:
    def __init__(self, path: Path, session_id: str):
        self.db = Database(path)
        self.session_id = session_id

    async def initialize(self) -> None:
        def operation(db: sqlite3.Connection) -> None:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise BackendError("unsupported_storage_format")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests(
                  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,
                  text TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
                  accepted_revision TEXT NOT NULL DEFAULT '0');
                CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                  request_id TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tools(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,
                  arguments TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                  kind TEXT NOT NULL,request_id TEXT NOT NULL,text TEXT NOT NULL);
                PRAGMA user_version=1;
            """)
            db.execute("INSERT OR IGNORE INTO metadata VALUES('stream_id',?)", (secrets.token_hex(16),))
        await self.db.call(operation)

    @staticmethod
    def event(db: sqlite3.Connection, kind: str, request_id: str, text: str) -> None:
        db.execute("INSERT INTO outbox(kind,request_id,text) VALUES(?,?,?)", (kind, request_id, text))

    @staticmethod
    def receipt(row: sqlite3.Row) -> Receipt:
        return Receipt(request_id=str(row["id"]), text=str(row["text"]),
                       status=TypeAdapter(Status).validate_python(row["status"]),
                       answer=str(row["answer"]), error=str(row["error"]), accepted_revision=str(row["accepted_revision"]))

    async def accept(self, value: Submit) -> Receipt:
        digest = hashlib.sha256(value.text.encode()).hexdigest()
        def operation(db: sqlite3.Connection) -> Receipt:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM requests WHERE id=?", (value.request_id,)).fetchone()
                if row is not None:
                    if row["digest"] != digest:
                        raise BackendError("request_conflict")
                else:
                    if db.execute("SELECT count(*) FROM requests").fetchone()[0] >= 128:
                        raise BackendError("session_capacity", "P1 session limit: 128 requests; create a new session", 429)
                    count = db.execute("SELECT count(*) FROM requests WHERE status='queued'").fetchone()[0]
                    if count >= 32:
                        raise BackendError("queue_full", status=429)
                    db.execute("INSERT INTO requests(id,digest,text,status) VALUES(?,?,?,'queued')",
                               (value.request_id, digest, value.text))
                    self.event(db, "accepted", value.request_id, value.text)
                    db.execute("UPDATE requests SET accepted_revision=CAST(last_insert_rowid() AS TEXT) WHERE id=?", (value.request_id,))
                    row = db.execute("SELECT * FROM requests WHERE id=?", (value.request_id,)).fetchone()
                result = self.receipt(row)
                db.execute("COMMIT")
                return result
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return await self.db.call(operation)

    async def get(self, request_id: str) -> Receipt:
        def operation(db: sqlite3.Connection) -> Receipt:
            row = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if row is None:
                raise BackendError("request_not_found", status=404)
            return self.receipt(row)
        return await self.db.call(operation)

    async def claim(self) -> Receipt | None:
        def operation(db: sqlite3.Connection) -> Receipt | None:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM requests WHERE status='queued' ORDER BY ordinal LIMIT 1").fetchone()
                if row is None:
                    db.execute("COMMIT")
                    return None
                request_id = str(row["id"])
                db.execute("UPDATE requests SET status='running' WHERE id=?", (request_id,))
                db.execute("INSERT INTO messages(request_id,payload) VALUES(?,?)", (
                    request_id, Message(role="user", content=str(row["text"])).model_dump_json()))
                self.event(db, "status", request_id, "running")
                db.execute("COMMIT")
                return self.receipt(db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone())
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return await self.db.call(operation)

    async def cancel(self, request_id: str) -> Receipt:
        def operation(db: sqlite3.Connection) -> Receipt:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
                if row is None:
                    raise BackendError("request_not_found", status=404)
                if row["status"] in ("queued", "running"):
                    status = "cancelled" if row["status"] == "queued" else "cancelling"
                    db.execute("UPDATE requests SET status=? WHERE id=?", (status, request_id))
                    self.event(db, "status", request_id, status)
                db.execute("COMMIT")
                return self.receipt(db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone())
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return await self.db.call(operation)

    async def update(self, request_id: str, status: Status | None = None,
                     answer: str | None = None, error: str = "") -> None:
        def operation(db: sqlite3.Connection) -> None:
            db.execute("BEGIN IMMEDIATE")
            try:
                if status:
                    current = str(db.execute("SELECT status FROM requests WHERE id=?", (request_id,)).fetchone()[0])
                    final = "cancelled" if current == "cancelling" and status == "succeeded" else status
                    unresolved = db.execute("SELECT 1 FROM tools WHERE request_id=? AND status='executing'", (request_id,)).fetchone()
                    if unresolved and final == "failed":
                        final = "unknown"
                    if final in {"cancelled", "failed", "interrupted", "unknown"}:
                        db.execute("UPDATE tools SET status='unknown' WHERE request_id=? AND status='executing'", (request_id,))
                    db.execute("UPDATE requests SET status=?,error=? WHERE id=?", (final, error, request_id))
                    self.event(db, "status", request_id, final)
                    if final in {"cancelled", "failed", "interrupted", "unknown"}:
                        db.execute("DELETE FROM messages WHERE request_id=?", (request_id,))
                if answer is not None:
                    db.execute("UPDATE requests SET answer=? WHERE id=?", (answer, request_id))
                    self.event(db, "preview", request_id, answer)
                if error and status is None:
                    db.execute("UPDATE requests SET error=? WHERE id=?", (error, request_id))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        await self.db.call(operation)

    async def blocked(self, request_id: str, error: str) -> None:
        def operation(db: sqlite3.Connection) -> None:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("UPDATE requests SET error=? WHERE id=?", (error, request_id))
                self.event(db, "cleanup", request_id, error)
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        await self.db.call(operation)

    async def message(self, request_id: str, message: Message) -> None:
        def operation(db: sqlite3.Connection) -> None:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("INSERT INTO messages(request_id,payload) VALUES(?,?)",
                           (request_id, message.model_dump_json()))
                self.event(db, "message", request_id, message.model_dump_json())
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        await self.db.call(operation)

    async def messages(self) -> list[Message]:
        def operation(db: sqlite3.Connection) -> list[Message]:
            result: list[Message] = []
            size = 0
            for row in db.execute("SELECT payload FROM messages ORDER BY seq"):
                payload = str(row[0])
                size += len(payload.encode())
                if size > 262144:
                    raise BackendError("context_limit", "P1 context limit reached; create a new session")
                result.append(Message.model_validate_json(payload))
            return result
        return await self.db.call(operation)

    async def tool(self, request_id: str, call_id: str, arguments: str, result: str | None = None) -> None:
        def operation(db: sqlite3.Connection) -> None:
            db.execute("BEGIN IMMEDIATE")
            try:
                if result is None:
                    db.execute("INSERT INTO tools(id,request_id,arguments,status) VALUES(?,?,?,'executing')",
                               (call_id, request_id, arguments))
                else:
                    db.execute("UPDATE tools SET status='done',result=? WHERE id=?", (result, call_id))
                self.event(db, "tool", request_id, result if result is not None else arguments)
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        await self.db.call(operation)

    async def recover(self) -> None:
        def operation(db: sqlite3.Connection) -> None:
            db.execute("BEGIN IMMEDIATE")
            try:
                for row in db.execute("SELECT id,status FROM requests WHERE status IN ('running','cancelling')").fetchall():
                    request_id = str(row["id"])
                    unknown = db.execute("SELECT id FROM tools WHERE request_id=? AND status='executing'",
                                         (request_id,)).fetchall()
                    status = "unknown" if unknown else ("cancelled" if row["status"] == "cancelling" else "interrupted")
                    db.execute("UPDATE requests SET status=?,error='process_interrupted' WHERE id=?", (status, request_id))
                    # Incomplete turn is excluded from future provider history; receipt/tool evidence remains intact.
                    db.execute("DELETE FROM messages WHERE request_id=?", (request_id,))
                    db.execute("UPDATE tools SET status='unknown' WHERE request_id=? AND status='executing'", (request_id,))
                    self.event(db, "status", request_id, status)
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        await self.db.call(operation)

    async def finish(self, request_id: str, status: Status, error: str = "") -> None:
        await self.update(request_id, status=status, error=error)

    async def snapshot(self, state: WorkerState = "ready") -> Snapshot:
        def operation(db: sqlite3.Connection) -> Snapshot:
            db.execute("BEGIN")
            try:
                requests = [self.receipt(row) for row in db.execute("""
                    SELECT * FROM requests WHERE status IN ('running','cancelling')
                      OR ordinal IN (SELECT ordinal FROM requests ORDER BY ordinal DESC LIMIT 20)
                    ORDER BY ordinal
                """)]
                rows = db.execute("SELECT * FROM outbox WHERE kind='tool' ORDER BY seq DESC LIMIT 16").fetchall()
                seq = str(db.execute("SELECT COALESCE(max(seq),0) FROM outbox").fetchone()[0])
                events = [Event(seq=str(r["seq"]), kind=r["kind"], request_id=str(r["request_id"]), text=str(r["text"]))
                          for r in reversed(rows)]
                return Snapshot(session_id=self.session_id,
                                stream_id=str(db.execute("SELECT value FROM metadata WHERE key='stream_id'").fetchone()[0]),
                                seq=seq, state=state,
                                requests=requests, events=events)
            finally:
                db.execute("COMMIT")
        return await self.db.call(operation)

    async def events(self, after: int) -> list[Event]:
        def operation(db: sqlite3.Connection) -> list[Event]:
            return [Event(seq=str(r["seq"]), kind=r["kind"], request_id=str(r["request_id"]), text=str(r["text"]))
                    for r in db.execute("SELECT * FROM outbox WHERE seq>? ORDER BY seq LIMIT 16", (after,))]
        return await self.db.call(operation)
