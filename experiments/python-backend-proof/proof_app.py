"""Executable feasibility probe, not a production backend or process supervisor."""

import argparse
import asyncio
import fcntl
import hashlib
import json
import os
import socket
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field


class Submission(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)
    text: str = Field(max_length=4096)


def identity() -> dict[str, str]:
    resource = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "build.json"
    if resource.exists():
        return json.loads(resource.read_text())
    return {
        "version": "0.1.0",
        "build_id": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }


class Store:
    """A caller must own this connection on one thread for its entire lifetime."""

    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS requests(
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, text TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('accepted','executing','done','unknown')));
            CREATE TABLE IF NOT EXISTS outbox(
                seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES requests(id),
                status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS control(
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL);
            INSERT OR IGNORE INTO control VALUES(1,0);
        """)

    def event(self, request_id: str, status: str):
        self.db.execute("INSERT INTO outbox(request_id,status) VALUES(?,?)", (request_id, status))

    def accept(self, request: Submission):
        digest = hashlib.sha256(json.dumps({"text": request.text}, sort_keys=True).encode()).hexdigest()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT * FROM requests WHERE id=?", (request.request_id,)).fetchone()
            if row:
                if row["digest"] != digest:
                    raise ValueError("request_conflict")
            else:
                self.db.execute(
                    "INSERT INTO requests VALUES(?,?,?,'accepted')",
                    (request.request_id, digest, request.text),
                )
                self.event(request.request_id, "accepted")
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return self.get(request.request_id)

    def get(self, request_id: str):
        row = self.db.execute("SELECT id,status,text FROM requests WHERE id=?", (request_id,)).fetchone()
        return dict(row) if row else None

    def transition(self, request_id: str, expected: str, status: str) -> bool:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            updated = (
                self.db.execute(
                    "UPDATE requests SET status=? WHERE id=? AND status=?", (status, request_id, expected)
                ).rowcount
                == 1
            )
            if updated:
                self.event(request_id, status)
            self.db.execute("COMMIT")
            return updated
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def recover(self):
        rows = self.db.execute("SELECT id FROM requests WHERE status='executing'").fetchall()
        for row in rows:
            self.transition(row["id"], "executing", "unknown")
        return [dict(row) for row in self.db.execute("SELECT id,status FROM requests ORDER BY id")]

    def snapshot(self):
        self.db.execute("BEGIN")
        try:
            rows = [dict(row) for row in self.db.execute("SELECT id,status FROM requests ORDER BY id")]
            seq = self.db.execute("SELECT COALESCE(MAX(seq),0) FROM outbox").fetchone()[0]
            return {"requests": rows, "seq": str(seq)}
        finally:
            self.db.execute("COMMIT")

    def events(self, seq: int):
        return [
            {**dict(row), "seq": str(row["seq"])}
            for row in self.db.execute(
                "SELECT seq,request_id,status FROM outbox WHERE seq>? ORDER BY seq LIMIT 128", (seq,)
            )
        ]

    def next_epoch(self) -> int:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("UPDATE control SET epoch=epoch+1 WHERE singleton=1")
            epoch = self.db.execute("SELECT epoch FROM control").fetchone()[0]
            self.db.execute("COMMIT")
            return epoch
        except BaseException:
            self.db.execute("ROLLBACK")
            raise


async def serve(path: Path, token: str):
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sqlite-owner")
    loop = asyncio.get_running_loop()
    store = await loop.run_in_executor(pool, Store, path)
    build = identity()  # Capture the running identity once, before accepting work.
    epoch = await loop.run_in_executor(pool, store.next_epoch)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(64)
    sock.setblocking(False)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        print(
            json.dumps({"port": sock.getsockname()[1], "pid": os.getpid(), "host_epoch": epoch, **build}),
            flush=True,
        )
        try:
            yield
        finally:
            await loop.run_in_executor(pool, store.db.close)
            pool.shutdown(wait=True)

    app = FastAPI(lifespan=lifespan)

    def authorize(value: str | None):
        if value != f"Bearer {token}":
            raise HTTPException(401, "unauthenticated")

    @app.get("/bootstrap")
    async def bootstrap(authorization: str | None = Header(default=None)):
        authorize(authorization)
        return {**build, "host_epoch": epoch, "pid": os.getpid()}

    @app.post("/submissions", status_code=202)
    async def submit(
        request: Submission,
        authorization: str | None = Header(default=None),
        x_proof_crash: str | None = Header(default=None),
    ):
        authorize(authorization)
        try:
            receipt = await loop.run_in_executor(pool, store.accept, request)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        if x_proof_crash == "after-commit":
            os._exit(91)
        return receipt

    @app.get("/requests/{request_id}")
    async def request_status(request_id: str, authorization: str | None = Header(default=None)):
        authorize(authorization)
        result = await loop.run_in_executor(pool, store.get, request_id)
        if result is None:
            raise HTTPException(404, "not_found")
        return result

    @app.get("/snapshot")
    async def snapshot(authorization: str | None = Header(default=None)):
        authorize(authorization)
        return await loop.run_in_executor(pool, store.snapshot)

    @app.post("/control/stop")
    async def stop_control(body: dict[str, str | int], authorization: str | None = Header(default=None)):
        authorize(authorization)
        if body.get("build_id") != build["build_id"]:
            raise HTTPException(409, "build_mismatch")
        if body.get("host_epoch") != epoch:
            raise HTTPException(409, "stale_epoch")
        server.should_exit = True
        return {"status": "stopping"}

    @app.websocket("/events")
    async def events(ws: WebSocket):
        if ws.headers.get("authorization") != f"Bearer {token}":
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            data = await ws.receive_json()
            seq = int(data["after"])
            if seq < 0:
                await ws.close(code=1008)
                return
            while True:
                batch = await loop.run_in_executor(pool, store.events, seq)
                for event in batch:
                    await ws.send_json(event)
                    seq = int(event["seq"])
                try:
                    await asyncio.wait_for(ws.receive_text(), timeout=0.02)
                except TimeoutError:
                    pass
        except WebSocketDisconnect:
            pass

    config = uvicorn.Config(
        app,
        loop="asyncio",
        ws="websockets-sansio",
        log_level="error",
        access_log=False,
        timeout_graceful_shutdown=2,
    )
    server = uvicorn.Server(config)
    await server.serve(sockets=[sock])


def execution_probe(args):
    store = Store(Path(args.database))

    def gate(phase):
        if args.pause == phase:
            print(json.dumps({"phase": phase}), flush=True)
            sys.stdin.readline()

    gate("before-intent")
    if not store.transition(args.request_id, "accepted", "executing"):
        print(json.dumps({"not_executed": store.get(args.request_id)}), flush=True)
        return
    gate("after-intent")
    # This is an actual external filesystem side effect, outside the SQLite transaction.
    fd = os.open(args.effect, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.write(fd, (args.request_id + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    gate("after-effect")
    store.transition(args.request_id, "executing", "done")
    gate("after-result")
    print(json.dumps(store.get(args.request_id)), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve", "execute", "recover", "identity"])
    parser.add_argument("--database", default="proof.sqlite")
    parser.add_argument("--request-id")
    parser.add_argument("--effect")
    parser.add_argument("--pause", default="none")
    args = parser.parse_args()
    if args.mode == "serve":
        with Path(args.database + ".host.lock").open("a+") as lease:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            asyncio.run(serve(Path(args.database), os.environ["AMAZME_PROOF_TOKEN"]))
    elif args.mode == "execute":
        execution_probe(args)
    elif args.mode == "recover":
        store = Store(Path(args.database))
        print(json.dumps(store.recover()))
        store.db.close()
    else:
        print(
            json.dumps(
                {
                    **identity(),
                    "frozen": bool(getattr(sys, "frozen", False)),
                    "python": sys.version,
                    "sqlite": sqlite3.sqlite_version,
                }
            )
        )


if __name__ == "__main__":
    main()
