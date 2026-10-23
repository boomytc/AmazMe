import asyncio
import contextlib
import hashlib
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI

from .common import Peer, Profile, build_id, child_command, lock, unix_listener
from .contracts import (
    BackendError,
    Cleanup,
    HostFence,
    Identity,
    Lease,
    RunTool,
    StopWorker,
    ToolResult,
    WorkerInfo,
    WorkerRequest,
    WorkerSpec,
)
from .storage import Database
from .transport import app_factory
from .vm import VM


class Supervisor:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.build = build_id()
        self.instance = secrets.token_hex(16)
        self.db = Database(profile.path / "execution.sqlite")
        self.vm = VM(profile)
        self.boot = ""
        self.registered = False
        self.host_epoch = 0
        self.draining = False
        self.control = asyncio.Lock()
        self.retired: set[str] = set()
        self.locks: dict[str, asyncio.Lock] = {}
        self.children: dict[str, asyncio.subprocess.Process] = {}
        self.heartbeats: dict[str, float] = {}
        self.jobs: dict[str, asyncio.Task[ToolResult]] = {}
        self.job_requests: dict[str, RunTool] = {}
        self.monitor_task: asyncio.Task[None] | None = None

    def serial(self, session: str) -> asyncio.Lock:
        return self.locks.setdefault(session, asyncio.Lock())

    async def initialize(self) -> None:
        def init(db: sqlite3.Connection) -> None:
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise BackendError("unsupported_storage_format")
            db.executescript("""
              CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL);
              INSERT OR IGNORE INTO control VALUES(1,0);
              CREATE TABLE IF NOT EXISTS workers(session TEXT PRIMARY KEY,worker TEXT NOT NULL,pid INTEGER NOT NULL,
                socket TEXT NOT NULL,build TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS epochs(session TEXT PRIMARY KEY,epoch INTEGER NOT NULL,worker TEXT NOT NULL,
                state TEXT NOT NULL,receipt TEXT NOT NULL DEFAULT '');
              CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,session TEXT NOT NULL,epoch INTEGER NOT NULL,
                name TEXT NOT NULL,cid TEXT NOT NULL DEFAULT '',cgroup TEXT NOT NULL DEFAULT '',boot TEXT NOT NULL,
                digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
              PRAGMA user_version=1;
            """)
            self.host_epoch = int(db.execute("SELECT epoch FROM control WHERE id=1").fetchone()[0])
        await self.db.call(init)
        self.registered = True
        self.retired.update(await self.db.call(lambda db: [str(r[0]) for r in db.execute("SELECT worker FROM workers")]))
        self.boot = await self.vm.start()
        sessions = await self.db.call(lambda db: [str(r[0]) for r in db.execute("SELECT session FROM epochs")])
        for session in sessions:
            await self.cleanup(session)
        self.monitor_task = asyncio.create_task(self.monitor())

    def check_host(self, fence: HostFence) -> None:
        if fence.build_id != self.build:
            raise BackendError("build_mismatch")
        if fence.host_epoch != self.host_epoch:
            raise BackendError("stale_host_epoch")

    async def takeover(self, value: HostFence) -> Identity:
        async with self.control:
            return await self._takeover(value)

    async def _takeover(self, value: HostFence) -> Identity:
        if self.draining:
            raise BackendError("supervisor_stopping", status=503)
        if value.build_id != self.build:
            raise BackendError("build_mismatch")
        def operation(db: sqlite3.Connection) -> None:
            db.execute("BEGIN IMMEDIATE")
            try:
                current = int(db.execute("SELECT epoch FROM control WHERE id=1").fetchone()[0])
                if value.host_epoch < current:
                    raise BackendError("stale_host_epoch")
                db.execute("UPDATE control SET epoch=? WHERE id=1", (value.host_epoch,))
                db.execute("COMMIT")
                self.host_epoch = value.host_epoch
            except BaseException:
                db.execute("ROLLBACK")
                raise
        await self.db.call(operation)
        result = self.profile.identity(self.instance, self.build)
        result.host_epoch = self.host_epoch
        return result

    async def worker_info(self, session: str) -> WorkerInfo | None:
        def operation(db: sqlite3.Connection) -> WorkerInfo | None:
            row = db.execute("SELECT * FROM workers WHERE session=?", (session,)).fetchone()
            return WorkerInfo(session_id=session, worker_id=str(row["worker"]), pid=int(row["pid"]),
                              socket=str(row["socket"]), build_id=str(row["build"])) if row else None
        return await self.db.call(operation)

    async def ensure_worker(self, value: WorkerSpec) -> WorkerInfo:
        # Keep lookup, cleanup, capacity reservation and spawn one control operation.
        # A worker may not have acquired its OS lock or opened its socket yet.
        async with self.control:
            return await self._ensure_worker(value)

    async def _ensure_worker(self, value: WorkerSpec) -> WorkerInfo:
        if self.draining:
            raise BackendError("supervisor_stopping", status=503)
        async with self.serial(value.session_id):
            self.check_host(value)
            old = await self.worker_info(value.session_id)
            if old:
                peer = Peer(Path(old.socket), self.profile.token)
                try:
                    identity = await asyncio.wait_for(peer.call("GET", "/identity", Identity), 2)
                    if identity.instance_id != old.worker_id or identity.build_id != self.build:
                        raise BackendError("worker_identity_mismatch")
                    if old.worker_id in self.retired:
                        raise BackendError("worker_stopping", status=503)
                    return old
                except (httpx.TransportError, TimeoutError):
                    pass
                finally:
                    await peer.close()
                owned = self.children.get(value.session_id)
                if owned and owned.returncode is None:
                    if old.worker_id in self.retired:
                        raise BackendError("worker_stopping", status=503)
                    return old
                self.retired.add(old.worker_id)
            # Release the control lock before cleanup reacquires it.
        receipt = await self.cleanup(value.session_id)
        if receipt.state != "clean":
            raise BackendError("execution_cleanup_pending", receipt.reason, 503)
        async with self.serial(value.session_id):
            self.check_host(value)
            worker_id = secrets.token_hex(16)
            if len(self.heartbeats) >= 8:
                raise BackendError("worker_capacity", "P1 limit: 8 active session workers", 429)
            socket = self.profile.worker_socket(value.session_id)
            # The session OS lock is authoritative if a previously unresponsive worker survives.
            directory = self.profile.path / "sessions" / value.session_id
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
            try:
                probe = lock(directory / "writer.lock")
                probe.close()
            except BlockingIOError as error:
                raise BackendError("worker_still_owns_session", status=503) from error
            await self.db.call(lambda db: db.execute(
                "INSERT OR REPLACE INTO workers VALUES(?,?,?,?,?)",
                (value.session_id, worker_id, 0, str(socket), self.build)))
            log_fd = os.open(directory / "worker.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                child = await asyncio.create_subprocess_exec(
                    *child_command("worker", "--profile", str(self.profile.path), "--session", value.session_id,
                                   "--instance", worker_id), stdin=asyncio.subprocess.DEVNULL,
                    stdout=log_fd, stderr=log_fd, start_new_session=True,
                )
            finally:
                os.close(log_fd)
            self.children[value.session_id] = child
            await self.db.call(lambda db: db.execute("UPDATE workers SET pid=? WHERE session=? AND worker=?",
                                                   (child.pid, value.session_id, worker_id)))
            self.heartbeats[value.session_id] = time.monotonic()
            return WorkerInfo(session_id=value.session_id, worker_id=worker_id, pid=child.pid,
                              socket=str(socket), build_id=self.build)

    async def validate_worker(self, value: WorkerRequest) -> None:
        worker = await self.worker_info(value.session_id)
        if value.build_id != self.build or not worker or worker.worker_id != value.worker_id or value.worker_id in self.retired:
            raise BackendError("stale_worker")

    async def heartbeat(self, value: WorkerRequest) -> Identity:
        await self.validate_worker(value)
        self.heartbeats[value.session_id] = time.monotonic()
        return self.profile.identity(self.instance, self.build)

    async def open_epoch(self, value: WorkerRequest) -> Lease:
        if self.draining:
            raise BackendError("supervisor_stopping", status=503)
        async with self.serial(value.session_id):
            await self.validate_worker(value)
            def operation(db: sqlite3.Connection) -> int:
                row = db.execute("SELECT * FROM epochs WHERE session=?", (value.session_id,)).fetchone()
                if row and row["state"] != "clean":
                    raise BackendError("execution_cleanup_pending", status=503)
                epoch = int(row["epoch"]) + 1 if row else 1
                db.execute("INSERT OR REPLACE INTO epochs(session,epoch,worker,state) VALUES(?,?,?,'open')",
                           (value.session_id, epoch, value.worker_id))
                return epoch
            epoch = await self.db.call(operation)
            return Lease(session_id=value.session_id, worker_id=value.worker_id,
                         execution_epoch=epoch, build_id=self.build)

    async def check_lease(self, value: Lease) -> None:
        if self.draining:
            raise BackendError("supervisor_stopping", status=503)
        await self.validate_worker(WorkerRequest(session_id=value.session_id, worker_id=value.worker_id,
                                                 build_id=value.build_id))
        row = await self.db.call(lambda db: db.execute("SELECT epoch,worker,state FROM epochs WHERE session=?",
                                                      (value.session_id,)).fetchone())
        if not row or (int(row["epoch"]), str(row["worker"]), str(row["state"])) != (
            value.execution_epoch, value.worker_id, "open"
        ):
            raise BackendError("execution_epoch_closed", status=503)

    async def execute(self, value: RunTool) -> ToolResult:
        async with self.serial(value.session_id):
            await self.check_lease(value)
            digest = hashlib.sha256(json.dumps([value.command, value.timeout_seconds]).encode()).hexdigest()
            existing = await self.db.call(lambda db: db.execute("SELECT * FROM scopes WHERE id=?", (value.call_id,)).fetchone())
            if existing:
                if existing["digest"] != digest or existing["session"] != value.session_id or existing["epoch"] != value.execution_epoch:
                    raise BackendError("call_conflict")
                if existing["result"]:
                    return ToolResult.model_validate_json(str(existing["result"]))
                raise BackendError("tool_outcome_unknown")
            name = "am-" + hashlib.sha256((self.profile.config.profile_id + value.call_id).encode()).hexdigest()[:32]
            await self.db.call(lambda db: db.execute(
                "INSERT INTO scopes(id,session,epoch,name,boot,digest,state) VALUES(?,?,?,?,?,?,'creating')",
                (value.call_id, value.session_id, value.execution_epoch, name, self.boot, digest)))
            labels = {"amazme.profile": self.profile.config.profile_id, "amazme.scope": value.call_id,
                      "amazme.epoch": str(value.execution_epoch)}
            response = await self.vm.http.post("/containers/create", params={"name": name}, json={
                "Image": self.vm.image_id,
                "Cmd": ["python", "-I", "-c", Path(__file__).with_name("gate.py").read_text()],
                "OpenStdin": True, "StdinOnce": True, "AttachStdin": True, "AttachStdout": True,
                "AttachStderr": True, "Labels": labels,
                "HostConfig": {"Binds": ["/workspace:/workspace:rw"], "NetworkMode": "none",
                               "ReadonlyRootfs": True, "CapDrop": ["ALL"], "CapAdd": ["SETUID", "SETGID"],
                               "SecurityOpt": ["no-new-privileges"], "PidsLimit": 64, "Memory": 268435456,
                               "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=67108864"},
                               "RestartPolicy": {"Name": "no"}, "LogConfig": {"Type": "none"}},
            })
            if 400 <= response.status_code < 500 and response.status_code not in {408, 409, 429}:
                await self.db.call(lambda db: db.execute("UPDATE scopes SET state='not_created' WHERE id=?", (value.call_id,)))
                raise BackendError("container_create_rejected", status=503)
            response.raise_for_status()
            container = await self.vm.inspect(name)
            if container is None or container.Config.Labels != labels:
                raise BackendError("container_identity_mismatch", status=503)
            cid = container.Id
            await self.db.call(lambda db: db.execute("UPDATE scopes SET cid=?,state='registered' WHERE id=?", (cid, value.call_id)))
            await self.db.call(lambda db: db.execute("UPDATE scopes SET state='starting' WHERE id=?", (value.call_id,)))
            process = await asyncio.create_subprocess_exec(
                str(self.vm.docker), "--host", "unix://" + str(self.vm.socket), "start", "--attach", "--interactive", cid,
                env=self.vm.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                for _ in range(200):
                    container = await self.vm.inspect(cid)
                    if container and container.State.Running:
                        break
                    await asyncio.sleep(0.02)
                else:
                    raise BackendError("container_start_timeout", status=503)
                cgroup = await self.vm.cgroup(container)
                await self.db.call(lambda db: db.execute("UPDATE scopes SET cgroup=?,state='permitted' WHERE id=?",
                                                       (cgroup, value.call_id)))
                await self.check_lease(value)
                assert process.stdin is not None
                process.stdin.write((json.dumps({"command": value.command, "uid": os.getuid(), "gid": os.getgid()}) + "\n").encode())
                await process.stdin.drain()
                process.stdin.close()
            except BaseException:
                # The persisted scope remains pending for cleanup, even if create/start response was lost.
                if process.returncode is None:
                    process.kill()
                await process.wait()
                raise
        async def read(stream: asyncio.StreamReader | None) -> tuple[str, bool]:
            assert stream is not None
            chunks: list[bytes] = []
            size = 0
            while data := await stream.read(8192):
                if size < 65536:
                    chunks.append(data[:65536-size])
                size += len(data)
            return b"".join(chunks).decode(errors="replace"), size > 65536
        stdout_task = asyncio.create_task(read(process.stdout))
        stderr_task = asyncio.create_task(read(process.stderr))
        try:
            try:
                await asyncio.wait_for(process.wait(), value.timeout_seconds)
            except TimeoutError:
                await self.vm.kill_and_prove(cid, cgroup, self.boot)
                await asyncio.wait_for(process.wait(), 10)
            out, err = await asyncio.gather(stdout_task, stderr_task)
            await self.vm.kill_and_prove(cid, cgroup, self.boot)
            container = await self.vm.inspect(cid)
            if container is None:
                raise BackendError("container_identity_missing", status=503)
            result = ToolResult(call_id=value.call_id, exit_code=container.State.ExitCode,
                                stdout=out[0], stderr=err[0], truncated=out[1] or err[1], container_id=cid)
            await self.db.call(lambda db: db.execute("UPDATE scopes SET state='exited',result=? WHERE id=?",
                                                   (result.model_dump_json(), value.call_id)))
            return result
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            for task in (stdout_task, stderr_task):
                if not task.done():
                    task.cancel()

    async def cleanup(self, session: str, lease: Lease | None = None) -> Cleanup:
        async with self.serial(session):
            if lease is not None:
                await self.validate_worker(WorkerRequest(session_id=session, worker_id=lease.worker_id, build_id=lease.build_id))
            row = await self.db.call(lambda db: db.execute("SELECT * FROM epochs WHERE session=?", (session,)).fetchone())
            if not row:
                return Cleanup(session_id=session, execution_epoch=0, state="clean", containers=[])
            epoch = int(row["epoch"])
            if lease and lease.execution_epoch != epoch:
                raise BackendError("stale_execution_epoch")
            if row["state"] == "clean" and row["receipt"]:
                return Cleanup.model_validate_json(str(row["receipt"]))
            await self.db.call(lambda db: db.execute("UPDATE epochs SET state='closing' WHERE session=?", (session,)))
            scopes = await self.db.call(lambda db: db.execute("SELECT * FROM scopes WHERE session=? AND epoch=?", (session, epoch)).fetchall())
            ids: list[str] = []
            try:
                for scope in scopes:
                    container = await self.vm.inspect(str(scope["cid"] or scope["name"]))
                    if container is None:
                        if scope["state"] == "creating":
                            raise BackendError("container_create_outcome_unknown", status=503)
                        if scope["cid"]:
                            await self.vm.kill_and_prove(str(scope["cid"]), str(scope["cgroup"]), str(scope["boot"]))
                        continue
                    if container.Config.Labels.get("amazme.profile") != self.profile.config.profile_id or container.Config.Labels.get("amazme.scope") != scope["id"]:
                        raise BackendError("container_identity_mismatch")
                    cg = str(scope["cgroup"])
                    if scope["state"] == "starting" and not container.State.Running:
                        raise BackendError("container_start_outcome_unknown", status=503)
                    if container.State.Running and not cg:
                        cg = await self.vm.cgroup(container)
                    await self.vm.kill_and_prove(container.Id, cg, str(scope["boot"]))
                    ids.append(container.Id)
                result = Cleanup(session_id=session, execution_epoch=epoch, state="clean", containers=ids)
            except Exception as error:
                result = Cleanup(session_id=session, execution_epoch=epoch, state="blocked", containers=ids,
                                 reason=error.code if isinstance(error, BackendError) else type(error).__name__)
            await self.db.call(lambda db: db.execute("UPDATE epochs SET state=?,receipt=? WHERE session=?",
                                                   (result.state, result.model_dump_json(), session)))
            return result

    async def stop_worker(self, value: StopWorker) -> Cleanup:
        async with self.control:
            return await self._stop_worker(value)

    async def _stop_worker(self, value: StopWorker) -> Cleanup:
        self.check_host(value)
        worker = await self.worker_info(value.session_id)
        if not worker or worker.worker_id != value.worker_id:
            raise BackendError("stale_worker")
        self.retired.add(worker.worker_id)
        result = await self.cleanup(value.session_id)
        # A peer stop carries its exact instance and current host fence; no naked PID signaling.
        peer = Peer(Path(worker.socket), self.profile.token)
        try:
            await peer.call("POST", "/stop", Identity, value)
        except httpx.TransportError:
            pass
        finally:
            await peer.close()
        child = self.children.get(value.session_id)
        if child:
            try:
                await asyncio.wait_for(child.wait(), 10)
            except TimeoutError as error:
                raise BackendError("worker_stop_pending", status=503) from error
        return result

    async def monitor(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            for session in list(self.heartbeats):
                async with self.control:
                    last = self.heartbeats.get(session)
                    child = self.children.get(session)
                    if last is not None and ((child and child.returncode is not None) or time.monotonic() - last > 10):
                        worker = await self.worker_info(session)
                        if worker:
                            self.retired.add(worker.worker_id)
                        await self.cleanup(session)
                        self.heartbeats.pop(session, None)

    async def run_tool(self, value: RunTool) -> ToolResult:
        await self.check_lease(value)
        if value.call_id in self.job_requests and self.job_requests[value.call_id] != value:
            raise BackendError("call_conflict")
        if value.call_id not in self.jobs:
            if len(self.jobs) >= 16:
                raise BackendError("execution_capacity", status=429)
            task = asyncio.create_task(self.execute(value))
            self.job_requests[value.call_id] = value
            self.jobs[value.call_id] = task

            def finished(done: asyncio.Task[ToolResult]) -> None:
                if self.jobs.get(value.call_id) is done:
                    self.jobs.pop(value.call_id)
                    self.job_requests.pop(value.call_id)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        return await asyncio.shield(self.jobs[value.call_id])


    async def shutdown(self, value: HostFence) -> Identity:
        async with self.control:
            self.check_host(value)
            self.draining = True
        rows = await self.db.call(lambda db: [str(r[0]) for r in db.execute("SELECT session FROM workers")])
        for session in rows:
            worker = await self.worker_info(session)
            if worker:
                await self.stop_worker(StopWorker(**value.model_dump(), session_id=session, worker_id=worker.worker_id))
        self.check_host(value)
        if (self.vm.home / self.vm.name / "lima.yaml").exists():
            await self.vm.stop()
        jobs = list(self.jobs.values())
        for task in jobs:
            task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        # Lima's completed stop proves the entire owned VM incarnation exited,
        # including a runtime operation whose response had been lost.
        for session in rows:
            def seal(db: sqlite3.Connection) -> None:
                row = db.execute("SELECT epoch FROM epochs WHERE session=?", (session,)).fetchone()
                if row:
                    ids = [str(r[0]) for r in db.execute("SELECT cid FROM scopes WHERE session=? AND epoch=? AND cid!=''", (session, row[0]))]
                    receipt = Cleanup(session_id=session, execution_epoch=int(row[0]), state="clean", containers=ids,
                                      reason="owned_vm_stopped")
                    db.execute("UPDATE epochs SET state='clean',receipt=? WHERE session=?", (receipt.model_dump_json(), session))
            await self.db.call(seal)
        return self.profile.identity(self.instance, self.build)



def application(owner: Supervisor, server_stop: asyncio.Event) -> FastAPI:
    app = app_factory(owner.profile.token)

    @app.get("/identity")
    async def identity() -> Identity:
        result = owner.profile.identity(owner.instance, owner.build)
        result.host_epoch = owner.host_epoch
        return result

    app.post("/takeover")(owner.takeover)
    app.post("/workers/ensure")(owner.ensure_worker)
    app.post("/workers/heartbeat")(owner.heartbeat)
    app.post("/workers/stop")(owner.stop_worker)
    app.post("/epochs/open")(owner.open_epoch)

    @app.post("/epochs/close")
    async def close(value: Lease) -> Cleanup:
        return await owner.cleanup(value.session_id, value)

    app.post("/tools/run")(owner.run_tool)

    @app.post("/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        result = await owner.shutdown(value)
        server_stop.set()
        return result

    return app


async def serve(profile: Profile) -> None:
    with lock(profile.path / "supervisor.lock"):
        owner = Supervisor(profile)
        stop = asyncio.Event()
        try:
            await owner.initialize()
            path = profile.socket("supervisor")
            listener = unix_listener(path)
            app = application(owner, stop)
            server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False,
                                                  timeout_graceful_shutdown=5))
            async def watch() -> None:
                await stop.wait()
                server.should_exit = True
            watcher = asyncio.create_task(watch())
            try:
                await server.serve(sockets=[listener])
            finally:
                watcher.cancel()
                listener.close()
        finally:
            if owner.monitor_task:
                owner.monitor_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await owner.monitor_task
            try:
                if not stop.is_set() and owner.registered:
                    await owner.shutdown(HostFence(host_epoch=owner.host_epoch, build_id=owner.build))
            finally:
                await owner.db.close()
                await owner.vm.close()
