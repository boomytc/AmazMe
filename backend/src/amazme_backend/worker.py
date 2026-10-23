"""Private session API and one checkpoint driver. Execution belongs to Supervisor."""
import asyncio
import base64
import contextlib
import json
import logging
import shlex
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from .common import Peer, Profile, build_id, lock, unix_listener
from .contracts import (
    ApprovalEnvelope,
    BackendError,
    Cancel,
    Cleanup,
    Command,
    EffectHold,
    FreezeWorker,
    HostFence,
    Identity,
    Lease,
    Preview,
    ReadFile,
    Receipt,
    Replay,
    ResolutionEnvelope,
    ResolveEffect,
    RunTool,
    Shell,
    Snapshot,
    StopWorker,
    Submission,
    ToolCall,
    ToolLookup,
    ToolObservation,
    ToolResult,
    WorkerActivity,
    WorkerRequest,
    WorkerState,
    WriteFile,
)
from .faults import Faults
from .providers import Completion, stream
from .session_domain import (
    Action,
    CloseEpoch,
    Continue,
    EffectResolved,
    EpochClosed,
    EpochOpened,
    Failed,
    ModelInvocation,
    ModelReturned,
    Observation,
    OpenEpoch,
    Park,
    Previewed,
    QueryTool,
    ReconcileEffect,
    ToolInvocation,
    ToolObserved,
    ToolReturned,
)
from .storage import SessionStore, now_ms
from .transport import app_factory


def command_for(call: ToolCall) -> Command:
    if call.name == "shell":
        return Shell.model_validate_json(call.arguments)
    if call.name == "read_file":
        value = ReadFile.model_validate_json(call.arguments)
        action = "print(p.read_text()[:65536])"
        data = value.model_dump()
    elif call.name == "write_file":
        value = WriteFile.model_validate_json(call.arguments)
        action = "p.parent.mkdir(parents=True,exist_ok=True); p.write_text(v['content']); print('written')"
        data = value.model_dump()
    else:
        raise BackendError("not_an_execution_tool")
    if Path(value.path).is_absolute() or ".." in Path(value.path).parts:
        raise BackendError("invalid_workspace_path")
    script = ("import base64,json,pathlib,sys; v=json.loads(base64.b64decode(sys.argv[1])); p=pathlib.Path('/workspace',v['path']).resolve(); "
              "assert p.is_relative_to('/workspace'), 'path escapes workspace'; " + action)
    payload = base64.b64encode(json.dumps(data, ensure_ascii=False).encode()).decode()
    return Command(command="python -I -c " + shlex.quote(script) + " " + payload)


class Worker:
    def __init__(self, profile: Profile, session: str, instance: str, *, frozen: bool = False,
                 require_existing: bool = False, validation: bool = False):
        self.profile, self.session, self.instance = profile, session, instance
        self.build = build_id()
        self.frozen_on_start = frozen
        self.validation = validation
        self.faults = Faults(profile.path, "worker", instance, enabled=profile.config.testing)
        self.store = SessionStore(profile.path / "sessions" / session / "session.sqlite", session,
                                  build=self.build, config=profile.config.provider,
                                  approval_policy=profile.config.approval_policy, faults=self.faults,
                                  require_existing=require_existing, instance=instance)
        self.supervisor = Peer(profile.socket("supervisor"), profile.token)
        self.owner = WorkerRequest(session_id=session, worker_id=instance, build_id=self.build)
        self.state: WorkerState = "recovering"
        self.current: Action = Park("startup")
        self.run_task: asyncio.Task[Observation] | None = None
        self.loop_task: asyncio.Task[None] | None = None
        self.heartbeat_task: asyncio.Task[None] | None = None
        self.stop = asyncio.Event()
        self.wake = asyncio.Event()
        self.quiescent = asyncio.Event()
        self.last_demand = time.monotonic()
        self.initialized = False
        self.storage_ready = False
        self.stop_requested = False
        self.dispatch_lock = asyncio.Lock()

    async def identity(self) -> Identity:
        return self.profile.identity(self.instance, self.build, role="worker", state=self.state,
                                     host_epoch=await self.store.host_epoch())

    async def initialize(self) -> None:
        await self.store.initialize()
        self.storage_ready = True
        # The registry must remember this database before any fallible execution probe.
        self.owner.storage_ready = True
        heartbeat = await self.supervisor.call("POST", "/workers/heartbeat", Identity, self.owner)
        self._validate_supervisor(heartbeat)
        await self.store.fence(HostFence(host_epoch=heartbeat.host_epoch, build_id=self.build))
        # Even a metadata validation owner must obtain a real cleanup proof before
        # retiring old decisions or clearing a stored cleanup failure.
        initial = await self.supervisor.call("POST", "/epochs/open", Lease, self.owner)
        self._validate_lease(initial)
        cleanup = await self.supervisor.call("POST", "/epochs/close", Cleanup, initial)
        if (cleanup.state != "clean" or not cleanup.proof_id or cleanup.session_id != self.session
                or cleanup.execution_epoch != initial.execution_epoch):
            raise BackendError("execution_cleanup_pending", status=503)
        if self.validation:
            await self.store.recover(frozen=self.frozen_on_start, validation=True, initial_cleanup=cleanup)
            snapshot = await self.store.snapshot()
            if snapshot.state == "blocked":
                raise BackendError("worker_blocked", status=503)
            self.quiescent.set()
        else:
            await self.store.recover(frozen=self.frozen_on_start, initial_cleanup=cleanup)
        self.state = (await self.store.activity()).state
        self.initialized = True
        if not self.validation:
            self.loop_task = asyncio.create_task(self.loop())
        self.heartbeat_task = asyncio.create_task(self.heartbeat())

    def _validate_supervisor(self, value: Identity) -> None:
        if (value.build_id != self.build or value.profile_id != self.profile.config.profile_id
                or value.role != "supervisor" or value.fingerprint != self.build):
            raise BackendError("supervisor_identity_mismatch")

    def _business(self) -> None:
        if self.validation:
            raise BackendError("validation_worker")
        if not self.initialized or self.stop.is_set() or self.state == "blocked":
            raise BackendError("worker_unavailable", status=503)

    def _validate_lease(self, lease: Lease) -> None:
        if (lease.session_id != self.session or lease.worker_id != self.instance or lease.build_id != self.build
                or not lease.supervisor_id or lease.execution_epoch <= 0):
            raise BackendError("execution_lease_mismatch")

    async def heartbeat(self) -> None:
        misses = 0
        while not self.stop.is_set():
            try:
                current = await asyncio.wait_for(self.supervisor.call("POST", "/workers/heartbeat", Identity, self.owner), 2)
                self._validate_supervisor(current)
                await self.store.fence(HostFence(host_epoch=current.host_epoch, build_id=self.build))
                misses = 0
            except Exception as exc:
                misses += 1
                if misses >= 3:
                    self.state = "blocked"
                    self._interrupt()
                    self.stop.set()
                    self.wake.set()
                    self.quiescent.set()
                    try:
                        await self.store.block(exc.code if isinstance(exc, BackendError) else type(exc).__name__)
                    except Exception:
                        logging.exception("Worker heartbeat failure could not be persisted")
                    return
            await asyncio.sleep(1)

    async def fence(self, value: HostFence) -> Identity:
        await self.store.fence(value)
        return await self.identity()

    async def submit(self, value: Submission) -> Receipt:
        self._business()
        self.last_demand = time.monotonic()
        receipt = await self.store.accept(value.value, value)
        self.quiescent.clear()
        self.wake.set()
        return receipt

    def _interrupt(self) -> None:
        # Open/close/reconciliation boundaries are never cancelled with business work.
        if self.run_task and isinstance(self.current, (ModelInvocation, ToolInvocation)):
            self.run_task.cancel()

    async def cancel(self, value: Cancel) -> Receipt:
        self._business()
        self.last_demand = time.monotonic()
        async with self.dispatch_lock:
            receipt = await self.store.cancel(value.request_id, value)
            if isinstance(self.current, (ModelInvocation, ToolInvocation)):
                current = await self.store.get(self.current.request_id)
                if current.cancel_requested:
                    self._interrupt()
        self.quiescent.clear()
        self.wake.set()
        return receipt

    async def approve(self, value: ApprovalEnvelope) -> Receipt:
        self._business()
        self.last_demand = time.monotonic()
        receipt = await self.store.approve(value.value, value)
        self.quiescent.clear()
        self.wake.set()
        return receipt

    async def resolve(self, value: ResolutionEnvelope) -> Receipt:
        self._business()
        self.last_demand = time.monotonic()
        await self.store.resolve(value.value, value)
        self.quiescent.clear()
        self.wake.set()
        await self.quiescent.wait()
        if self.state == "blocked":
            raise BackendError("effect_resolution_blocked", status=503)
        return await self.store.get((await self.store.resolve(value.value, value)).request_id)

    async def freeze(self, value: FreezeWorker) -> Snapshot:
        async with self.dispatch_lock:
            await self.store.freeze(value, value.freeze_id, cancel_work=value.cancel_work)
            if self.validation and value.cancel_work:
                await self.settle_validation_cancellations()
            self.state = "frozen"
            self.quiescent.clear()
            self._interrupt()
            self.wake.set()
            if self.validation:
                self.quiescent.set()
        await self.quiescent.wait()
        if (await self.store.activity()).state == "blocked":
            raise BackendError("execution_cleanup_pending", status=503)
        return await self.store.snapshot()

    async def settle_validation_cancellations(self) -> None:
        """Settle persisted decisions using historical queries and cleanup only."""
        await self.store.recover(frozen=True)
        for _ in range(4096):
            action = await self.store.advance()
            if isinstance(action, Continue):
                continue
            if isinstance(action, Park):
                return
            if isinstance(action, CloseEpoch):
                proof = await self.supervisor.call("POST", "/epochs/close", Cleanup, action.lease)
                await self.store.advance(EpochClosed(action.request_id, action.lease, proof))
            elif isinstance(action, QueryTool):
                result = await self.supervisor.call("POST", "/tools/lookup", ToolObservation,
                    ToolLookup(**self.owner.model_dump(), call_id=action.step_id))
                await self.store.advance(ToolObserved(action, result))
            else:
                raise BackendError("validation_recovery_pending", status=503)
        raise BackendError("validation_recovery_limit", status=503)

    async def thaw(self, value: FreezeWorker) -> Snapshot:
        await self.store.thaw(value, value.freeze_id)
        self.state = (await self.store.activity()).state
        if not self.validation:
            self.quiescent.clear()
            self.wake.set()
        return await self.store.snapshot()

    async def request_stop(self, value: StopWorker) -> Identity:
        if value.worker_id != self.instance or value.session_id != self.session:
            raise BackendError("worker_identity_mismatch")
        # Local durable fence is authoritative. No Supervisor callback: it may be recovering.
        async with self.dispatch_lock:
            await self.store.stopping(value, value.execution_epoch,
                                      cancel_work=not self.validation and value.reason == "shutdown")
            self.stop_requested = True
            self.state = "stopping"
            self._interrupt()
            self.quiescent.clear()
            self.wake.set()
        # Reply first so Supervisor can close execution scopes while the driver drains.
        self.stop.set()
        return await self.identity()

    async def perform(self, action: Action) -> Observation:
        if self.validation:
            raise BackendError("validation_worker")
        if isinstance(action, ModelInvocation):
            config = action.config.model_copy(update={"api_key": self.profile.config.provider.api_key})
            answer = ""
            completion: Completion | None = None
            preview_seq = 0
            last_preview = 0.0
            async for item in stream(config, action.messages):
                if isinstance(item, Completion):
                    completion = item
                else:
                    answer += item
                    if len(answer) > 64000:
                        raise BackendError("model_output_limit")
                    if time.monotonic() - last_preview >= 0.05:
                        preview_seq += 1
                        await self.store.advance(Previewed(action, Preview(
                            request_id=action.request_id, run_id=action.request_id, generation=action.generation,
                            preview_seq=str(preview_seq), text=answer)))
                        last_preview = time.monotonic()
            if completion is None:
                raise BackendError("missing_model_completion")
            return ModelReturned(action, completion)
        if isinstance(action, OpenEpoch):
            lease = await self.supervisor.call("POST", "/epochs/open", Lease, self.owner)
            self._validate_lease(lease)
            return EpochOpened(action.request_id, lease)
        if isinstance(action, CloseEpoch):
            cleanup = await self.supervisor.call("POST", "/epochs/close", Cleanup, action.lease)
            return EpochClosed(action.request_id, action.lease, cleanup)
        if isinstance(action, ToolInvocation):
            command = command_for(action.call)
            result = await self.supervisor.call("POST", "/tools/run", ToolResult, RunTool(
                **action.lease.model_dump(), call_id=action.step_id, request_id=action.request_id,
                command=command.command, timeout_seconds=command.timeout_seconds,
                effect="read" if action.call.name == "read_file" else "write"))
            return ToolReturned(action, result)
        if isinstance(action, QueryTool):
            observed = await self.supervisor.call("POST", "/tools/lookup", ToolObservation,
                                                  ToolLookup(**self.owner.model_dump(), call_id=action.step_id))
            return ToolObserved(action, observed)
        if isinstance(action, ReconcileEffect):
            hold = await self.supervisor.call("POST", "/effects/resolve", EffectHold,
                                              ResolveEffect(**self.owner.model_dump(), resolution=action.resolution))
            return EffectResolved(action.resolution, hold)
        raise BackendError("invalid_driver_action")

    async def loop(self) -> None:
        if self.validation:
            raise BackendError("validation_worker")
        try:
            while True:
                self.wake.clear()
                async with self.dispatch_lock:
                    action = await self.store.advance()
                    self.current = action
                    if not isinstance(action, (Continue, Park)):
                        self.quiescent.clear()
                        self.run_task = asyncio.create_task(self.perform(action))
                if isinstance(action, Continue):
                    continue
                if isinstance(action, Park):
                    activity = await self.store.activity()
                    self.state = activity.state
                    self.quiescent.set()
                    if self.state == "blocked":
                        self.stop.set()
                    if self.stop.is_set():
                        return
                    # Host activity polling never counts as interactive demand. Pending work stays
                    # resident; Host may explicitly retire it after recording the durable wake.
                    if activity.pending == 0 and self.state == "ready" and time.monotonic() - self.last_demand > 120:
                        self.stop.set()
                        return
                    timeout = min(1.0, max(0.01, (action.next_wake_ms - now_ms()) / 1000)) if action.next_wake_ms else 1.0
                    try:
                        await asyncio.wait_for(self.wake.wait(), timeout)
                    except TimeoutError:
                        pass
                    continue
                try:
                    assert self.run_task is not None
                    observation = await self.run_task
                except asyncio.CancelledError:
                    task = asyncio.current_task()
                    if task is not None and task.cancelling():
                        raise
                    observation = Failed(action, "execution_interrupted")
                except Exception as exc:
                    observation = Failed(action, exc.code if isinstance(exc, BackendError) else type(exc).__name__)
                finally:
                    self.run_task = None
                await self.store.advance(observation)
        except BaseException as exc:
            self.state = "blocked"
            self.quiescent.set()
            self.stop.set()
            try:
                await self.store.block(exc.code if isinstance(exc, BackendError) else type(exc).__name__)
            except Exception:
                logging.exception("Worker driver failure could not be persisted")
            raise

    async def shutdown(self) -> None:
        self.stop.set()
        self._interrupt()
        self.wake.set()
        try:
            if self.storage_ready and not self.stop_requested:
                fence = HostFence(build_id=self.build, host_epoch=await self.store.host_epoch())
                await self.store.stopping(fence, cancel_work=False)
            if self.loop_task:
                await self.loop_task
        finally:
            try:
                if self.loop_task and not self.loop_task.done():
                    self.loop_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self.loop_task
            finally:
                try:
                    self.state = "stopping"
                    if self.heartbeat_task:
                        self.heartbeat_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await self.heartbeat_task
                finally:
                    try:
                        await self.store.db.close()
                    finally:
                        await self.supervisor.close()


def application(owner: Worker) -> FastAPI:
    app = app_factory(owner.profile.token)

    @app.get("/identity")
    async def identity() -> Identity:
        return await owner.identity()

    @app.post("/fence")
    async def fence(value: HostFence) -> Identity:
        return await owner.fence(value)

    @app.get("/snapshot")
    async def snapshot() -> Snapshot:
        return await owner.store.snapshot(owner.state)

    @app.get("/events")
    async def events(after: int = 0, stream_id: str = "") -> Replay:
        return await owner.store.events(after, stream_id)

    @app.get("/activity")
    async def activity() -> WorkerActivity:
        return await owner.store.activity()

    @app.post("/submissions", status_code=202)
    async def submit(value: Submission) -> Receipt:
        return await owner.submit(value)

    @app.get("/requests/{request_id}")
    async def lookup(request_id: str) -> Receipt:
        return await owner.store.get(request_id)

    @app.post("/requests/{request_id}/cancel", status_code=202)
    async def cancel(request_id: str, value: Cancel) -> Receipt:
        if request_id != value.request_id:
            raise BackendError("request_identity_mismatch")
        return await owner.cancel(value)

    @app.post("/approvals", status_code=202)
    async def approve(value: ApprovalEnvelope) -> Receipt:
        return await owner.approve(value)

    @app.post("/effects/resolve", status_code=202)
    async def resolve(value: ResolutionEnvelope) -> Receipt:
        return await owner.resolve(value)

    @app.post("/freeze")
    async def freeze(value: FreezeWorker) -> Snapshot:
        return await owner.freeze(value)

    @app.post("/thaw")
    async def thaw(value: FreezeWorker) -> Snapshot:
        return await owner.thaw(value)

    @app.post("/stop")
    async def stop(value: StopWorker) -> Identity:
        return await owner.request_stop(value)

    return app


async def serve(profile: Profile, session: str, instance: str, *, frozen: bool = False,
                require_existing: bool = False, validation: bool = False) -> None:
    directory = profile.path / "sessions" / session
    with lock(directory / "writer.lock"):
        owner = Worker(profile, session, instance, frozen=frozen, require_existing=require_existing,
                       validation=validation)
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
                with contextlib.suppress(asyncio.CancelledError):
                    await watcher
                listener.close()
        finally:
            await owner.shutdown()
