"""Private session API and one checkpoint driver. Execution belongs to Supervisor."""
import asyncio
import contextlib
import hashlib
import json
import logging
import time

import httpx
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
    ErrorBody,
    FreezeWorker,
    HostFence,
    HostReady,
    Identity,
    Lease,
    McpCall,
    McpCallEnvelope,
    McpCallRef,
    McpCallRequest,
    McpDecision,
    McpDecisionEnvelope,
    McpSession,
    McpState,
    McpToolCall,
    Message,
    PreparedFileWrite,
    PrepareFileWrite,
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
    WebCallRequest,
    WebFetch,
    WebSearch,
    WorkerActivity,
    WorkerRequest,
    WorkerState,
    WriteFile,
)
from .faults import Faults
from .mcp_session import catalog_payload, offers_from_views
from .memories import inject_memories, relevant_memories, session_workspace
from .providers import Completion, stream
from .session_domain import (
    Action,
    CloseEpoch,
    Continue,
    EffectResolved,
    EpochClosed,
    EpochOpened,
    Failed,
    McpRetrieval,
    McpReturned,
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
    WebRetrieval,
    WebReturned,
)
from .session_ops import SessionOp, SessionOpResult, run_session_op
from .storage import SessionStore, now_ms, session_database
from .transport import app_factory
from .web_tools import execute_web_call
from .workspace_map import client_path, split_client_path


def command_for(call: ToolCall) -> Command:
    if call.name == "shell":
        return Shell.model_validate_json(call.arguments)
    if call.name == "read_file":
        ReadFile.model_validate_json(call.arguments)
    elif call.name == "write_file":
        WriteFile.model_validate_json(call.arguments)
    else:
        raise BackendError("not_an_execution_tool")
    return Command(command=call.name)


class Worker:
    def __init__(self, profile: Profile, session: str, instance: str, *, frozen: bool = False,
                 require_existing: bool = False, validation: bool = False):
        self.profile, self.session, self.instance = profile, session, instance
        self.build = build_id()
        self.frozen_on_start = frozen
        self.validation = validation
        self.faults = Faults(profile.path, "worker", instance, enabled=profile.config.testing)
        self.store = SessionStore(session_database(profile.path, session), session,
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
        self.web_client: httpx.AsyncClient | None = None

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

    def _use_current_provider(self) -> None:
        self.profile.reload_provider()
        self.store.config = self.profile.config.provider

    async def submit(self, value: Submission) -> Receipt:
        self._business()
        self._use_current_provider()
        self.last_demand = time.monotonic()
        receipt = await self.store.accept(value.value, value)
        self.quiescent.clear()
        self.wake.set()
        return receipt

    def _interrupt(self) -> None:
        # Open/close/reconciliation boundaries are never cancelled with business work.
        if self.run_task and isinstance(self.current, (ModelInvocation, ToolInvocation, WebRetrieval, McpRetrieval)):
            self.run_task.cancel()

    async def cancel(self, value: Cancel) -> Receipt:
        self._business()
        self.last_demand = time.monotonic()
        async with self.dispatch_lock:
            receipt = await self.store.cancel(value.request_id, value)
            if isinstance(self.current, (ModelInvocation, ToolInvocation, WebRetrieval, McpRetrieval)):
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

    async def model_input(self, messages: list[Message]) -> list[Message]:
        query = next((item.content for item in reversed(messages) if item.role == "user"), "")
        workspace = session_workspace(self.profile.path, self.session)
        return inject_memories(messages, relevant_memories(self.profile.path, workspace, query))

    async def _retrieve_web(self, action: WebRetrieval) -> WebReturned:
        self._use_current_provider()
        live = self.store.config
        key = live.api_key.get_secret_value() if live.provider == "deepseek" else ""
        if action.call.name == "web_search":
            args = WebSearch.model_validate_json(action.call.arguments)
            value = WebCallRequest(call_id=action.step_id, kind="search", query=args.query, count=args.count)
        elif action.call.name == "web_fetch":
            fetched = WebFetch.model_validate_json(action.call.arguments)
            value = WebCallRequest(call_id=action.step_id, kind="fetch", url=fetched.url)
        else:
            raise BackendError("not_an_execution_tool")
        messages = await self.store.messages(action.request_id)
        question = next((item.content for item in reversed(messages)
                         if item.role == "user" and item.content.strip()), "")
        try:
            view = await execute_web_call(
                self.store, value, key=key, question=question, client=self.web_client)
        except BackendError as exc:
            if exc.code in {"web_disabled", "web_credential_missing"}:
                return WebReturned(action, "refused", exc.code)
            raise
        if view.call_id != action.step_id:
            raise BackendError("tool_result_identity_mismatch")
        return WebReturned(action, view.phase, view.error, view.result)

    async def _mcp_fence(self) -> HostFence:
        return HostFence(host_epoch=await self.store.host_epoch(), build_id=self.build)

    async def _mcp_offers(self):
        fence = await self._mcp_fence()
        state = await self.supervisor.call("POST", "/mcp/state", McpState, McpSession(
            host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session))
        return offers_from_views(state.servers)

    @staticmethod
    def _mcp_decision_id(step_id: str) -> str:
        return hashlib.sha256(f"mcp-decision:{step_id}".encode()).hexdigest()[:32]

    def _mcp_observation(self, action: McpRetrieval, call: McpCall) -> McpReturned:
        if call.phase == "done":
            payload = json.dumps({"text": call.result, "is_error": call.is_error, "data": call.result_data},
                                 ensure_ascii=False)
            return McpReturned(action, "done", result=payload)
        if call.phase == "denied":
            return McpReturned(action, "denied", "mcp_call_denied")
        if call.phase == "conflict":
            return McpReturned(action, "conflict", "mcp_tool_identity")
        if call.phase == "unknown":
            return McpReturned(action, "unknown", "mcp_outcome_unknown")
        if call.phase == "waiting_approval":
            return McpReturned(action, "cancelled")
        return McpReturned(action, "unknown", "mcp_outcome_unknown")

    async def _retrieve_mcp(self, action: McpRetrieval) -> McpReturned:
        args = McpToolCall.model_validate_json(action.call.arguments)
        fence = await self._mcp_fence()
        ref = McpCallRef(host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session,
                         server_id=args.server_id, call_id=args.call_id)
        if action.stop:
            try:
                current = await self.supervisor.call("POST", "/mcp/lookup", McpCall, ref)
            except BackendError as exc:
                if exc.code == "mcp_call_not_found":
                    return McpReturned(action, "cancelled")
                raise
            if current.phase not in {"done", "denied", "unknown", "conflict"}:
                current = await self.supervisor.call("POST", "/mcp/calls/cancel", McpCall, ref)
            return self._mcp_observation(action, current)
        request = McpCallRequest(call_id=args.call_id, name=args.tool, arguments=args.arguments,
                                 schema_digest=args.schema_digest, origin="model")
        current = await self.supervisor.call("POST", "/mcp/calls", McpCall, McpCallEnvelope(
            host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session,
            server_id=args.server_id, call=request))
        if current.phase == "waiting_approval":
            decision = McpDecision(decision_id=self._mcp_decision_id(action.step_id), approve=True, digest=current.digest)
            try:
                current = await self.supervisor.call("POST", "/mcp/decision", McpCall, McpDecisionEnvelope(
                    host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session,
                    server_id=args.server_id, call_id=args.call_id, decision=decision))
            except BackendError as exc:
                if exc.code != "mcp_decision_conflict":
                    raise
                current = await self.supervisor.call("POST", "/mcp/lookup", McpCall, ref)
                if current.phase == "waiting_approval":
                    return McpReturned(action, "unknown", "mcp_outcome_unknown")
        while current.phase == "running":
            await asyncio.sleep(0.05)
            current = await self.supervisor.call("POST", "/mcp/lookup", McpCall, ref)
        return self._mcp_observation(action, current)

    async def prepare_file_write(self, action: ToolInvocation) -> PreparedFileWrite:
        ready = HostReady.model_validate_json((self.profile.path / "ready.json").read_bytes())
        epoch = await self.store.host_epoch()
        if (ready.profile_id != self.profile.config.profile_id or ready.build_id != self.build
                or ready.fingerprint != self.build or ready.role != "host" or ready.host_epoch != epoch):
            raise BackendError("stale_host_epoch")
        write = WriteFile.model_validate_json(action.call.arguments)
        request = PrepareFileWrite(**action.lease.model_dump(), host_epoch=epoch,
                                   call_id=action.step_id, write=write)
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            response = await client.post(ready.url + "/control/file-writes/prepare", json=request.model_dump(),
                                         headers={"Authorization": "Bearer " + self.profile.token})
        if response.is_error:
            error = ErrorBody.model_validate_json(response.content)
            raise BackendError(error.code, status=response.status_code)
        prepared = PreparedFileWrite.model_validate_json(response.content)
        name, inner = split_client_path(write.path)
        if prepared.call_id != action.step_id or prepared.path != client_path(name, inner):
            raise BackendError("file_preparation_mismatch")
        return prepared

    async def perform(self, action: Action) -> Observation:
        if self.validation:
            raise BackendError("validation_worker")
        if isinstance(action, ModelInvocation):
            self.profile.reload_provider()
            live = self.profile.config.provider
            config = action.config.model_copy(update={
                "api_key": live.api_key, "proxy": live.proxy, "headers": dict(live.headers),
            })
            answer = ""
            completion: Completion | None = None
            preview_seq = 0
            last_preview = 0.0
            messages = await self.model_input(action.messages)
            # A direct model probe has no session database. A live turn binds the catalog before any token.
            offers = await self._mcp_offers() if self.storage_ready else []
            if self.storage_ready:
                await self.store.bind_mcp_catalog(action.step_id, action.generation, catalog_payload(offers))
            async for item in stream(config, messages, offers):
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
        if isinstance(action, WebRetrieval):
            return await self._retrieve_web(action)
        if isinstance(action, McpRetrieval):
            return await self._retrieve_mcp(action)
        if isinstance(action, ToolInvocation):
            prepared = await self.prepare_file_write(action) if action.call.name == "write_file" else None
            command = command_for(action.call)
            file = (WriteFile.model_validate_json(action.call.arguments) if action.call.name == "write_file" else
                    ReadFile.model_validate_json(action.call.arguments) if action.call.name == "read_file" else None)
            result = await self.supervisor.call("POST", "/tools/run", ToolResult, RunTool(
                **action.lease.model_dump(), call_id=action.step_id, request_id=action.request_id,
                command=command.command, timeout_seconds=command.timeout_seconds, file=file,
                expected_digest=prepared.expected_digest if prepared else None,
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

    @app.post("/session-ops")
    async def session_ops(value: SessionOp) -> SessionOpResult:
        return SessionOpResult(payload=await run_session_op(owner.store, value.name, value.payload))

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
