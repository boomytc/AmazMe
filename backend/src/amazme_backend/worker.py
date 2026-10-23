import asyncio
import base64
import contextlib
import hashlib
import json
import shlex
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from .common import Peer, Profile, build_id, lock, unix_listener
from .contracts import (
    BackendError,
    Cleanup,
    Command,
    EventList,
    Identity,
    Lease,
    Message,
    ReadFile,
    Receipt,
    RunTool,
    Shell,
    Snapshot,
    Status,
    StopWorker,
    Submit,
    ToolCall,
    ToolResult,
    WorkerRequest,
    WorkerState,
    WriteFile,
)
from .providers import Completion, stream
from .storage import SessionStore
from .transport import app_factory


def command_for(call: ToolCall) -> Command:
    if call.name == "shell":
        return Shell.model_validate_json(call.arguments)
    if call.name == "read_file":
        value = ReadFile.model_validate_json(call.arguments)
        action = "print(p.read_text()[:65536])"
        data = value.model_dump()
    else:
        value = WriteFile.model_validate_json(call.arguments)
        action = "p.parent.mkdir(parents=True,exist_ok=True); p.write_text(v['content']); print('written')"
        data = value.model_dump()
    if Path(value.path).is_absolute() or ".." in Path(value.path).parts:
        raise BackendError("invalid_workspace_path")
    script = ("import base64,json,pathlib,sys; v=json.loads(base64.b64decode(sys.argv[1])); p=pathlib.Path('/workspace',v['path']).resolve(); "
              "assert p.is_relative_to('/workspace'), 'path escapes workspace'; " + action)
    payload = base64.b64encode(json.dumps(data, ensure_ascii=False).encode()).decode()
    return Command(command="python -I -c " + shlex.quote(script) + " " + payload)


class Worker:
    def __init__(self, profile: Profile, session: str, instance: str):
        self.profile, self.session, self.instance = profile, session, instance
        self.build = build_id()
        self.store = SessionStore(profile.path / "sessions" / session / "session.sqlite", session)
        self.supervisor = Peer(profile.socket("supervisor"), profile.token)
        self.owner = WorkerRequest(session_id=session, worker_id=instance, build_id=self.build)
        self.state: WorkerState = "recovering"
        self.current: str | None = None
        self.lease: Lease | None = None
        self.run_task: asyncio.Task[None] | None = None
        self.loop_task: asyncio.Task[None] | None = None
        self.heartbeat_task: asyncio.Task[None] | None = None
        self.stop = asyncio.Event()
        self.wake = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.last_demand = time.monotonic()

    async def initialize(self) -> None:
        await self.store.initialize()
        await self.supervisor.call("POST", "/workers/heartbeat", Identity, self.owner)
        # Supervisor's ensure_worker cleans old resources before creating this worker.
        # Explicitly acquire/close an empty epoch to verify that the admission barrier agrees.
        initial = await self.supervisor.call("POST", "/epochs/open", Lease, self.owner)
        receipt = await self.supervisor.call("POST", "/epochs/close", Cleanup, initial)
        if receipt.state != "clean":
            raise BackendError("execution_cleanup_pending", status=503)
        await self.store.recover()
        self.state = "ready"
        self.loop_task = asyncio.create_task(self.loop())
        def loop_finished(task: asyncio.Task[None]) -> None:
            if not task.cancelled() and task.exception() is not None:
                self.state = "blocked"
                self.stop.set()
        self.loop_task.add_done_callback(loop_finished)
        self.heartbeat_task = asyncio.create_task(self.heartbeat())

    async def heartbeat(self) -> None:
        misses = 0
        while not self.stop.is_set():
            try:
                await asyncio.wait_for(self.supervisor.call("POST", "/workers/heartbeat", Identity, self.owner), 2)
                misses = 0
            except Exception:
                misses += 1
                if misses >= 3:
                    self.state = "blocked"
                    self.cancelled.set()
                    self.stop.set()
                    return
            await asyncio.sleep(1)

    async def submit(self, value: Submit) -> Receipt:
        self.last_demand = time.monotonic()
        if self.state != "ready" or self.stop.is_set():
            raise BackendError("execution_cleanup_pending", status=503)
        result = await self.store.accept(value)
        self.wake.set()
        return result

    async def cancel(self, request_id: str) -> Receipt:
        receipt = await self.store.cancel(request_id)
        if receipt.status == "cancelling" and request_id == self.current and self.run_task:
            self.cancelled.set()
        return receipt

    async def loop(self) -> None:
        while not self.stop.is_set():
            self.wake.clear()
            if self.state != "ready":
                return
            request = await self.store.claim()
            if request is None:
                if time.monotonic() - self.last_demand > 120:
                    self.stop.set()
                    return
                try:
                    await asyncio.wait_for(self.wake.wait(), 1)
                except TimeoutError:
                    pass
                continue
            self.current = request.request_id
            self.cancelled.clear()
            self.run_task = asyncio.create_task(self.run(request))
            await self.run_task
            self.current = None
            self.run_task = None

    async def run(self, request: Receipt) -> None:
        status: Status = "failed"
        error = ""
        lease: Lease | None = None
        try:
            if (await self.store.get(request.request_id)).status == "cancelling" or self.stop.is_set():
                status = "cancelled"
                return
            # Acquiring the lease and closing it belong to this uncancelled owner.
            # Cancellation affects only the model/tool task, never these boundaries.
            lease = await self.supervisor.call("POST", "/epochs/open", Lease, self.owner)
            self.lease = lease
            work = asyncio.create_task(self.perform(request, lease))
            cancellation = asyncio.create_task(self.cancelled.wait())
            try:
                await asyncio.wait((work, cancellation), return_when=asyncio.FIRST_COMPLETED)
                if self.cancelled.is_set():
                    work.cancel()
                status = await work
            finally:
                cancellation.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await cancellation
        except asyncio.CancelledError:
            status = "cancelled"
        except Exception as exc:
            error = exc.code if isinstance(exc, BackendError) else type(exc).__name__
            if lease is None:
                self.state = "blocked"
        finally:
            if lease:
                try:
                    receipt = await self.supervisor.call("POST", "/epochs/close", Cleanup, lease)
                    if receipt.state != "clean":
                        self.state, error = "blocked", "execution_cleanup_pending"
                except Exception as exc:
                    reason = exc.code if isinstance(exc, BackendError) else type(exc).__name__
                    self.state, error = "blocked", "execution_cleanup_pending:" + reason
            if self.state == "blocked":
                await self.store.blocked(request.request_id, error)
            else:
                await self.store.finish(request.request_id, status=status, error=error)
            self.lease = None

    async def perform(self, request: Receipt, lease: Lease) -> Status:
        if self.cancelled.is_set() or self.stop.is_set():
            raise asyncio.CancelledError
        for round_number in range(8):
            answer = ""
            completion: Completion | None = None
            async for item in stream(self.profile.config.provider, await self.store.messages()):
                if isinstance(item, str):
                    answer += item
                    await self.store.update(request.request_id, answer=answer)
                else:
                    completion = item
            if completion is None:
                raise BackendError("missing_model_completion")
            completion.message.provider_response_id = completion.response_id
            await self.store.message(request.request_id, completion.message)
            await self.store.update(request.request_id, answer=completion.message.content)
            if not completion.message.tool_calls:
                return "succeeded"
            for call in completion.message.tool_calls:
                if (await self.store.get(request.request_id)).status == "cancelling":
                    raise asyncio.CancelledError
                shell = command_for(call)
                call_id = hashlib.sha256(f"{self.session}:{request.request_id}:{round_number}:{call.id}".encode()).hexdigest()
                await self.store.tool(request.request_id, call_id, call.model_dump_json())
                tool_result = await self.supervisor.call("POST", "/tools/run", ToolResult, RunTool(
                    **lease.model_dump(), call_id=call_id, command=shell.command,
                    timeout_seconds=shell.timeout_seconds))
                await self.store.tool(request.request_id, call_id, call.arguments, tool_result.model_dump_json())
                await self.store.message(request.request_id, Message(role="tool", content=tool_result.model_dump_json(),
                                                                   tool_call_id=call.id))
        raise BackendError("model_round_limit")

    async def shutdown(self) -> None:
        self.stop.set()
        self.cancelled.set()
        self.wake.set()
        try:
            if self.loop_task:
                await self.loop_task
        finally:
            self.state = "stopping"
            if self.heartbeat_task:
                self.heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self.heartbeat_task
            try:
                await self.store.db.close()
            finally:
                await self.supervisor.close()


def application(owner: Worker) -> FastAPI:
    app = app_factory(owner.profile.token)

    @app.get("/identity")
    async def identity() -> Identity:
        if owner.stop.is_set():
            raise BackendError("worker_stopping", status=503)
        return owner.profile.identity(owner.instance, owner.build)

    @app.get("/snapshot")
    async def snapshot() -> Snapshot:
        owner.last_demand = time.monotonic()
        return await owner.store.snapshot(owner.state)

    @app.get("/events")
    async def events(after: int = 0) -> EventList:
        owner.last_demand = time.monotonic()
        return EventList(events=await owner.store.events(after))

    @app.post("/submissions", status_code=202)
    async def submit(value: Submit) -> Receipt:
        return await owner.submit(value)

    @app.get("/requests/{request_id}")
    async def lookup(request_id: str) -> Receipt:
        return await owner.store.get(request_id)

    @app.post("/requests/{request_id}/cancel", status_code=202)
    async def cancel(request_id: str) -> Receipt:
        return await owner.cancel(request_id)

    @app.post("/stop")
    async def stop(value: StopWorker) -> Identity:
        current = await owner.supervisor.call("GET", "/identity", Identity)
        if value.worker_id != owner.instance or value.host_epoch != current.host_epoch:
            raise BackendError("stale_host_epoch")
        if value.build_id != owner.build:
            raise BackendError("build_mismatch")
        owner.stop.set()
        return owner.profile.identity(owner.instance, owner.build)

    return app


async def serve(profile: Profile, session: str, instance: str) -> None:
    directory = profile.path / "sessions" / session
    with lock(directory / "writer.lock"):
        owner = Worker(profile, session, instance)
        try:
            await owner.initialize()
            path = profile.worker_socket(session)
            listener = unix_listener(path)
            server = uvicorn.Server(uvicorn.Config(application(owner), log_level="error", access_log=False,
                                                  timeout_graceful_shutdown=5))
            async def watch() -> None:
                await owner.stop.wait()
                server.should_exit = True
            watcher = asyncio.create_task(watch())
            try:
                await server.serve(sockets=[listener])
            finally:
                watcher.cancel()
                listener.close()
        finally:
            await owner.shutdown()
