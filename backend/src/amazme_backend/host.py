import asyncio
import contextlib
import os
import secrets
import socket
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import quote

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field

from .common import Peer, Profile, build_id, child_command, lock, private_write, wait_peer
from .contracts import (
    BackendError,
    CreateSession,
    EventList,
    HostFence,
    Identity,
    Model,
    Receipt,
    Session,
    SessionList,
    Snapshot,
    Stream,
    Submit,
    WorkerInfo,
    WorkerSpec,
)
from .storage import Database
from .transport import app_factory


class Login(Model):
    token: str = Field(min_length=1, max_length=256)


class Host:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.build = build_id()
        self.instance = secrets.token_hex(16)
        self.db = Database(profile.path / "host.sqlite")
        self.supervisor = Peer(profile.socket("supervisor"), profile.token)
        self.fence = HostFence(host_epoch=0, build_id=self.build)
        self.worker_peers: dict[str, tuple[str, Peer]] = {}
        self.worker_locks: dict[str, asyncio.Lock] = {}
        self.attached = False
        self.child: asyncio.subprocess.Process | None = None
        self.stop = asyncio.Event()
        self.closing = False
        self.web_token = (profile.path / "web.token").read_text().strip()
        self.origin = ""

    async def initialize(self) -> None:
        def operation(db: sqlite3.Connection) -> int:
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise BackendError("unsupported_storage_format")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL);
                INSERT OR IGNORE INTO control VALUES(1,0);
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL);
                PRAGMA user_version=1;
            """)
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("UPDATE control SET epoch=epoch+1 WHERE id=1")
                value = int(db.execute("SELECT epoch FROM control WHERE id=1").fetchone()[0])
                db.execute("COMMIT")
                return value
            except BaseException:
                db.execute("ROLLBACK")
                raise
        self.fence.host_epoch = await self.db.call(operation)
        try:
            await asyncio.wait_for(self.supervisor.call("GET", "/identity", Identity), 2)
        except (httpx.TransportError, TimeoutError):
            try:
                probe = lock(self.profile.path / "supervisor.lock")
                probe.close()
            except BlockingIOError:
                pass
            else:
                log_fd = os.open(self.profile.path / "supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    self.child = await asyncio.create_subprocess_exec(
                        *child_command("supervisor", "--profile", str(self.profile.path)),
                        stdin=asyncio.subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, start_new_session=True,
                    )
                finally:
                    os.close(log_fd)
        await wait_peer(self.supervisor, self.build, timeout=240, profile=self.profile.config.profile_id)
        await self.supervisor.call("POST", "/takeover", Identity, self.fence)
        self.attached = True

    async def sessions(self) -> SessionList:
        return await self.db.call(lambda db: SessionList(sessions=[Session(session_id=str(r[0]), title=str(r[1]))
                                            for r in db.execute("SELECT id,title FROM sessions ORDER BY rowid")]))

    async def create_session(self, value: CreateSession) -> Session:
        if self.closing:
            raise BackendError("host_stopping", status=503)
        session = Session(session_id=secrets.token_hex(16), title=value.title)
        await self.db.call(lambda db: db.execute("INSERT INTO sessions VALUES(?,?)", (session.session_id, session.title)))
        await self.worker(session.session_id)
        return session

    async def worker(self, session: str) -> Peer:
        async with self.worker_locks.setdefault(session, asyncio.Lock()):
            return await self._worker(session)

    async def _worker(self, session: str) -> Peer:
        if self.closing:
            raise BackendError("host_stopping", status=503)
        exists = await self.db.call(lambda db: db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone())
        if not exists:
            raise BackendError("session_not_found", status=404)
        info = await self.supervisor.call("POST", "/workers/ensure", WorkerInfo,
                                          WorkerSpec(**self.fence.model_dump(), session_id=session))
        cached = self.worker_peers.get(session)
        if cached and cached[0] == info.worker_id:
            return cached[1]
        if cached:
            await cached[1].close()
        peer = Peer(Path(info.socket), self.profile.token)
        try:
            await wait_peer(peer, self.build, instance=info.worker_id, profile=self.profile.config.profile_id)
        except BaseException:
            await peer.close()
            raise
        self.worker_peers[session] = (info.worker_id, peer)
        return peer

    async def close(self) -> None:
        self.closing = True
        try:
            if self.attached:
                await self.supervisor.call("POST", "/shutdown", Identity, self.fence)
                deadline = asyncio.get_running_loop().time() + 15
                while True:
                    try:
                        with lock(self.profile.path / "supervisor.lock"):
                            break
                    except BlockingIOError:
                        if asyncio.get_running_loop().time() >= deadline:
                            raise BackendError("supervisor_stop_pending", status=503) from None
                        await asyncio.sleep(0.05)
            elif self.child is not None:
                # Only the supervisor spawned by this failed startup is ours to stop.
                if self.child.returncode is None:
                    self.child.terminate()
                    await self.child.wait()
                from .vm import VM
                with lock(self.profile.path / "supervisor.lock"):
                    vm = VM(self.profile)
                    try:
                        if (vm.home / vm.name / "lima.yaml").exists():
                            await vm.stop()
                    finally:
                        await vm.close()
        finally:
            for _, peer in self.worker_peers.values():
                await peer.close()
            await self.supervisor.close()
            await self.db.close()


def application(owner: Host) -> FastAPI:
    app = app_factory()

    @app.middleware("http")
    async def authenticate(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if request.headers.get("host") != owner.origin.removeprefix("http://"):
            return JSONResponse({"code": "invalid_host", "message": "Invalid Host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != owner.origin:
            return JSONResponse({"code": "invalid_origin", "message": "Invalid Origin"}, status_code=403)
        path = request.url.path
        if path.startswith("/control/"):
            valid = secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + owner.profile.token)
        elif path.startswith("/api/"):
            bearer = secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + owner.web_token)
            cookie = secrets.compare_digest(request.cookies.get("amazme", ""), owner.web_token)
            valid = bearer or (cookie and (request.method in {"GET", "HEAD"} or origin == owner.origin))
        else:
            valid = True
        if not valid:
            return JSONResponse({"code": "unauthenticated", "message": "Authentication required"}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; connect-src 'self'; style-src 'self'"
        return response

    @app.post("/auth")
    async def login(value: Login, request: Request, response: Response) -> dict[str, bool]:
        if request.headers.get("origin") != owner.origin or not secrets.compare_digest(value.token, owner.web_token):
            raise BackendError("invalid_pairing", status=403)
        response.set_cookie("amazme", owner.web_token, httponly=True, samesite="strict", path="/")
        return {"ok": True}

    @app.get("/api/v1/bootstrap")
    async def bootstrap() -> Identity:
        identity = owner.profile.identity(owner.instance, owner.build)
        identity.host_epoch = owner.fence.host_epoch
        return identity

    @app.get("/api/v1/sessions")
    async def sessions() -> SessionList:
        return await owner.sessions()

    @app.post("/api/v1/sessions", status_code=201)
    async def create(value: CreateSession) -> Session:
        return await owner.create_session(value)

    @app.get("/api/v1/sessions/{session}/snapshot")
    async def snapshot(session: str) -> Snapshot:
        return await (await owner.worker(session)).call("GET", "/snapshot", Snapshot)

    @app.post("/api/v1/sessions/{session}/submissions", status_code=202)
    async def submit(session: str, value: Submit) -> Receipt:
        return await (await owner.worker(session)).call("POST", "/submissions", Receipt, value)

    @app.get("/api/v1/sessions/{session}/requests/{request_id}")
    async def lookup(session: str, request_id: str) -> Receipt:
        return await (await owner.worker(session)).call("GET", "/requests/" + quote(request_id, safe=""), Receipt)

    @app.post("/api/v1/sessions/{session}/requests/{request_id}/cancel", status_code=202)
    async def cancel(session: str, request_id: str) -> Receipt:
        return await (await owner.worker(session)).call("POST", "/requests/" + quote(request_id, safe="") + "/cancel", Receipt)

    @app.websocket("/api/v1/events/{session}")
    async def events(socket: WebSocket, session: str) -> None:
        if socket.headers.get("origin") != owner.origin or not secrets.compare_digest(socket.cookies.get("amazme", ""), owner.web_token):
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            peer = await owner.worker(session)
            snapshot = await peer.call("GET", "/snapshot", Snapshot)
            await asyncio.wait_for(socket.send_text(Stream(snapshot=snapshot).model_dump_json()), 5)
            after = int(snapshot.seq)
            while True:
                events = await peer.call("GET", f"/events?after={after}", EventList)
                if events.events:
                    await asyncio.wait_for(socket.send_text(Stream(events=events.events).model_dump_json()), 5)
                    after = int(events.events[-1].seq)
                try:
                    await asyncio.wait_for(socket.receive_text(), 0.2)
                except TimeoutError:
                    pass
        except (WebSocketDisconnect, httpx.TransportError, BackendError, TimeoutError):
            with contextlib.suppress(RuntimeError):
                await socket.close(code=1012)

    @app.post("/control/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        if value != owner.fence:
            raise BackendError("stale_host_epoch")
        owner.closing = True
        owner.stop.set()
        return await bootstrap()

    app.mount("/", StaticFiles(directory=Path(__file__).with_name("web"), html=True), name="web")
    return app


async def serve(profile: Profile, port: int = 0) -> None:
    with lock(profile.path / "host.lock"):
        owner = Host(profile)
        try:
            await owner.initialize()
            sock = socket.socket()
            sock.bind(("127.0.0.1", port))
            sock.listen(128)
            sock.setblocking(False)
            owner.origin = f"http://127.0.0.1:{sock.getsockname()[1]}"
            app = application(owner)
            server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False,
                                                  ws="websockets-sansio", timeout_graceful_shutdown=3))
            identity = owner.profile.identity(owner.instance, owner.build)
            identity.host_epoch = owner.fence.host_epoch
            ready = {"url": owner.origin, **identity.model_dump()}
            import json
            private_write(profile.path / "ready.json", json.dumps(ready))
            print(json.dumps(ready), flush=True)

            async def watch() -> None:
                await owner.stop.wait()
                server.should_exit = True
            watcher = asyncio.create_task(watch())
            try:
                await server.serve(sockets=[sock])
            finally:
                watcher.cancel()
                sock.close()
        finally:
            await owner.close()
