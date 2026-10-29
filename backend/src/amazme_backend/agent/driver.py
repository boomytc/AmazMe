"""Drive the existing durable session actions through injected capabilities."""
import asyncio
import contextlib
import hashlib
import json
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

import httpx
from pydantic import JsonValue

from amazme_backend.agent.model import stream
from amazme_backend.agent.prompting import clock_context, job_completion_text
from amazme_backend.ai.types import Auth
from amazme_backend.contracts.events import Snapshot
from amazme_backend.contracts.execution import (
    Command,
    EditFile,
    FileObservation,
    JobOutputWait,
    JobQuery,
    Lease,
    OutputRead,
    ReadFile,
    Shell,
    ToolResult,
    WriteFile,
)
from amazme_backend.contracts.identity import HostFence, HostReady, Identity
from amazme_backend.contracts.ipc.host import (
    PreparedFileWrite,
    PrepareFileWrite,
)
from amazme_backend.contracts.ipc.supervisor import (
    CancelCode,
    CancelPlugin,
    CodeStatus,
    JobOutputQuery,
    JobReference,
    JobSession,
    McpCallEnvelope,
    McpCallRef,
    McpDecisionEnvelope,
    McpSession,
    OpenCode,
    PluginCallEnvelope,
    ResolveEffect,
    RunTool,
    StopWorker,
    ToolLookup,
    WorkerRequest,
)
from amazme_backend.contracts.ipc.worker import (
    ApprovalEnvelope,
    Cancel,
    FreezeWorker,
    JobNoticeEnvelope,
    ResolutionEnvelope,
    Submission,
)
from amazme_backend.contracts.mcp import (
    McpCall,
    McpCallRequest,
    McpDecision,
    McpOffer,
    McpToolCall,
    McpView,
)
from amazme_backend.contracts.models import ImagePart, Message, ToolCall, checked_images
from amazme_backend.contracts.plugins import PluginCallView, PluginOffer, PluginToolCall
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import Preview, Receipt, WorkerState
from amazme_backend.contracts.web import WebCallRequest, WebCallView, WebFetch, WebSearch
from amazme_backend.diagnostics.faults import Faults
from amazme_backend.execution.client import SupervisorClient
from amazme_backend.sessions.service import SessionOps, SessionStore
from amazme_backend.sessions.types import (
    Action,
    CloseEpoch,
    CodemodeInput,
    CodeRetrieval,
    CodeReturned,
    Completion,
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
    PluginRetrieval,
    PluginReturned,
    Previewed,
    QueryTool,
    ReconcileEffect,
    ToolInvocation,
    ToolObserved,
    ToolReturned,
    WebRetrieval,
    WebReturned,
)
from amazme_backend.shared.errors import BackendError, ErrorBody
from amazme_backend.workspaces.paths import client_path, tool_path


class WebExecutor(Protocol):
    async def __call__(self, store: SessionOps, value: WebCallRequest, *, key: str, question: str,
                       client: httpx.AsyncClient | None, secrets: tuple[str, ...]) -> WebCallView: ...


@dataclass(frozen=True)
class WorkerContext:
    build: str
    profile_id: str
    token: str
    faults: Faults
    identity: Callable[[WorkerState, int], Identity]
    current_provider: Callable[[], ProviderConfig]
    configured_model: Callable[[ProviderConfig], Awaitable[tuple[ProviderConfig, Auth]]]
    secrets: Callable[[], Sequence[str]]
    contains_secret: Callable[[str], bool]
    prepare_messages: Callable[[list[Message]], list[Message]]
    workspace: Callable[[], str]
    host_ready: Callable[[], HostReady]
    web_key: Callable[[ProviderConfig], str]
    execute_web: WebExecutor
    mcp_catalog: Callable[[list[McpView]], list[McpOffer]]
    catalog_payload: Callable[[list[McpOffer]], str]


def command_for(call: ToolCall) -> Command:
    if call.name == "shell":
        return Shell.model_validate_json(call.arguments)
    if call.name == "read_file":
        ReadFile.model_validate_json(call.arguments)
    elif call.name == "write_file":
        WriteFile.model_validate_json(call.arguments)
    elif call.name == "edit_file":
        EditFile.model_validate_json(call.arguments)
    elif call.name == "tool_output":
        OutputRead.model_validate_json(call.arguments)
    else:
        raise BackendError("not_an_execution_tool")
    return Command(command=call.name)


class Worker:
    def __init__(self, session: str, instance: str, *, store: SessionStore,
                 supervisor: SupervisorClient, context: WorkerContext, frozen: bool = False,
                 validation: bool = False):
        self.context, self.session, self.instance = context, session, instance
        self.build = context.build
        self.frozen_on_start = frozen
        self.validation = validation
        self.faults = context.faults
        self.store = store
        self.supervisor = supervisor
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
        return self.context.identity(self.state, await self.store.host_epoch())

    async def initialize(self) -> None:
        await self.store.initialize()
        self.storage_ready = True
        # The registry must remember this database before any fallible execution probe.
        self.owner.storage_ready = True
        heartbeat = await self.supervisor.heartbeat(self.owner)
        self._validate_supervisor(heartbeat)
        await self.store.fence(HostFence(host_epoch=heartbeat.host_epoch, build_id=self.build))
        # Even a metadata validation owner must obtain a real cleanup proof before
        # retiring old decisions or clearing a stored cleanup failure.
        initial = await self.supervisor.open_epoch(self.owner)
        self._validate_lease(initial)
        cleanup = await self.supervisor.cleanup(initial)
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
        if (value.build_id != self.build or value.profile_id != self.context.profile_id
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
                current = await asyncio.wait_for(self.supervisor.heartbeat(self.owner), 2)
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
        self.store.config = self.context.current_provider()

    async def submit(self, value: Submission) -> Receipt:
        self._business()
        self._use_current_provider()
        self.last_demand = time.monotonic()
        receipt = await self.store.accept(value.value, value, accepted_config=value.provider)
        self.quiescent.clear()
        self.wake.set()
        return receipt

    async def receive_job_notice(self, value: JobNoticeEnvelope) -> Receipt:
        self._business()
        receipt = await self.store.accept_job_notice(value.value, job_completion_text(value.value), value)
        self.last_demand = time.monotonic()
        self.quiescent.clear()
        self.wake.set()
        return receipt

    def _interrupt(self) -> None:
        # Open/close/reconciliation boundaries are never cancelled with business work.
        if self.run_task and isinstance(self.current, (ModelInvocation, ToolInvocation, WebRetrieval, McpRetrieval, PluginRetrieval)):
            self.run_task.cancel()

    async def cancel(self, value: Cancel) -> Receipt:
        self._business()
        self.last_demand = time.monotonic()
        async with self.dispatch_lock:
            receipt = await self.store.cancel(value.request_id, value)
            if isinstance(self.current, (ModelInvocation, ToolInvocation, WebRetrieval, McpRetrieval, PluginRetrieval)):
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
                proof = await self.supervisor.cleanup(action.lease)
                await self.store.advance(EpochClosed(action.request_id, action.lease, proof))
            elif isinstance(action, QueryTool):
                result = await self.supervisor.lookup_tool(ToolLookup(**self.owner.model_dump(), call_id=action.step_id))
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
                                      cancel_work=not self.validation and value.reason == "shutdown",
                                      require_idle=value.require_idle)
            self.stop_requested = True
            self.state = "stopping"
            self._interrupt()
            self.quiescent.clear()
            self.wake.set()
        # Reply first so Supervisor can close execution scopes while the driver drains.
        self.stop.set()
        return await self.identity()

    async def model_input(self, messages: list[Message]) -> list[Message]:
        prepared = self.context.prepare_messages(messages)
        if self.storage_ready:
            summary = await self.store.active_summary()
            if self.context.contains_secret(summary):
                prepared = [item for item in prepared if item.content != summary]
        return prepared

    async def _retrieve_web(self, action: WebRetrieval) -> WebReturned:
        self._use_current_provider()
        live = self.store.config
        key = self.context.web_key(live)
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
            view = await self.context.execute_web(
                self.store, value, key=key, question=question, client=self.web_client,
                secrets=tuple(self.context.secrets()))
        except BackendError as exc:
            if exc.code in {"web_disabled", "web_credential_missing"}:
                return WebReturned(action, "refused", exc.code)
            raise
        if view.call_id != action.step_id:
            raise BackendError("tool_result_identity_mismatch")
        return WebReturned(action, view.phase, view.error, view.result)

    async def _mcp_fence(self) -> HostFence:
        return HostFence(host_epoch=await self.store.host_epoch(), build_id=self.build)

    async def _mcp_offers(self, request_id: str = ""):
        fence = await self._mcp_fence()
        state = await self.supervisor.mcp_state(McpSession(
            host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session))
        loaded = set(await self.store.active_mcp_tools(request_id)) if request_id else set[str]()
        return [offer.model_copy(update={"active": offer.exposure == "direct" or offer.activation_key() in loaded})
                for offer in self.context.mcp_catalog(state.servers)]

    @staticmethod
    def _mcp_decision_id(step_id: str) -> str:
        return hashlib.sha256(f"mcp-decision:{step_id}".encode()).hexdigest()[:32]

    def _mcp_observation(self, action: McpRetrieval, call: McpCall) -> McpReturned:
        if call.phase == "done":
            data = dict(call.result_data or {})
            content = data.get("content")
            images: list[ImagePart] = []
            parts: list[JsonValue] = []
            for part in content if isinstance(content, list) else []:
                resource = part.get("resource") if isinstance(part, dict) else None
                image = {"media_type": part.get("mimeType"), "data_base64": part.get("data")} if isinstance(part, dict) and part.get("type") == "image" else (
                    {"media_type": resource.get("mimeType"), "data_base64": resource.get("blob")} if isinstance(resource, dict) and str(resource.get("mimeType", "")).startswith("image/") else None)
                if image is None:
                    parts.append(part)
                else:
                    try:
                        images.append(ImagePart.model_validate(image))
                    except ValueError:
                        parts.append({"type": "text", "text": "MCP completed; invalid image omitted. Do not repeat the call."})
            try:
                checked_images(images)
            except BackendError:
                images = []
                parts.append({"type": "text", "text": "MCP completed; invalid media omitted. Do not repeat the call."})
            if isinstance(content, list):
                data["content"] = parts
            summary = "\n".join(str(part["text"]) for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)) if isinstance(content, list) else call.result
            payload = json.dumps({"text": summary or "MCP result", "is_error": call.is_error, "data": data},
                                 ensure_ascii=False)
            return McpReturned(action, "done", result=payload[:64000], images=images)
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
                current = await self.supervisor.lookup_mcp_call(ref)
            except BackendError as exc:
                if exc.code == "mcp_call_not_found":
                    return McpReturned(action, "cancelled")
                raise
            if current.phase not in {"done", "denied", "unknown", "conflict"}:
                current = await self.supervisor.cancel_mcp_call(ref)
            return self._mcp_observation(action, current)
        request = McpCallRequest(call_id=args.call_id, name=args.tool, arguments=args.arguments,
                                 schema_digest=args.schema_digest, origin="model")
        current = await self.supervisor.request_mcp_call(McpCallEnvelope(
            host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session,
            server_id=args.server_id, call=request))
        if current.phase == "waiting_approval":
            decision = McpDecision(decision_id=self._mcp_decision_id(action.step_id), approve=True, digest=current.digest)
            try:
                current = await self.supervisor.decide_mcp_call(McpDecisionEnvelope(
                    host_epoch=fence.host_epoch, build_id=fence.build_id, session_id=self.session,
                    server_id=args.server_id, call_id=args.call_id, decision=decision))
            except BackendError as exc:
                if exc.code != "mcp_decision_conflict":
                    raise
                current = await self.supervisor.lookup_mcp_call(ref)
                if current.phase == "waiting_approval":
                    return McpReturned(action, "unknown", "mcp_outcome_unknown")
        while current.phase == "running":
            await asyncio.sleep(0.05)
            current = await self.supervisor.lookup_mcp_call(ref)
        return self._mcp_observation(action, current)

    async def prepare_file_write(self, action: ToolInvocation) -> PreparedFileWrite:
        ready = self.context.host_ready()
        epoch = await self.store.host_epoch()
        if (ready.profile_id != self.context.profile_id or ready.build_id != self.build
                or ready.fingerprint != self.build or ready.role != "host" or ready.host_epoch != epoch):
            raise BackendError("stale_host_epoch")
        write = (EditFile.model_validate_json(action.call.arguments) if action.call.name == "edit_file"
                 else WriteFile.model_validate_json(action.call.arguments))
        name, inner = tool_path(self.context.workspace(), write.path)
        path = client_path(name, inner)
        observation: FileObservation | None = None
        for message in reversed(await self.store.messages(action.request_id)):
            if message.role != "tool":
                continue
            try:
                result = ToolResult.model_validate_json(message.content)
            except ValueError:
                continue
            if result.file_observation is not None and result.file_observation.path == path:
                observation = result.file_observation
                break
        request = PrepareFileWrite(**action.lease.model_dump(), host_epoch=epoch,
                                   call_id=action.step_id, write=write, observation=observation)
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            response = await client.post(ready.url + "/control/file-writes/prepare", json=request.model_dump(),
                                         headers={"Authorization": "Bearer " + self.context.token})
        if response.is_error:
            error = ErrorBody.model_validate_json(response.content)
            raise BackendError(error.code, status=response.status_code)
        prepared = PreparedFileWrite.model_validate_json(response.content)
        if not prepared.root or prepared.call_id != action.step_id or prepared.path != client_path(name, inner):
            raise BackendError("file_preparation_mismatch")
        return prepared

    async def refresh_effect_proofs(self) -> None:
        if self.validation or not self.storage_ready:
            return
        snapshot = await self.store.snapshot()
        if not any(not hold.resource_clean for hold in snapshot.effects):
            return
        try:
            health = await asyncio.wait_for(self.supervisor.health(), 2)
        except (OSError, BackendError, TimeoutError, ValueError):
            return
        if (health.identity.profile_id != self.context.profile_id or health.identity.build_id != self.build
                or health.identity.host_epoch != await self.store.host_epoch()
                or not any(worker.worker_id == self.instance and worker.session_id == self.session for worker in health.workers)):
            return
        await self.store.refresh_effect_proofs([hold for hold in health.effects if hold.session_id == self.session])

    async def _plugin_offers(self) -> list[PluginOffer]:
        workspace = self.context.workspace()
        loaded = await self.supervisor.list_plugins(self.session)
        if any(view.session_id != self.session for view in loaded.plugins):
            raise BackendError("plugin_session_mismatch")
        return [offer for view in loaded.plugins for offer in PluginOffer.from_view(view, workspace)]

    async def _retrieve_plugin(self, action: PluginRetrieval) -> PluginReturned:
        args = PluginToolCall.model_validate_json(action.call.arguments)
        fence = await self._mcp_fence()
        try:
            if action.stop:
                view = await self.supervisor.cancel_plugin(CancelPlugin(
                    **fence.model_dump(), session_id=self.session, plugin_id=args.plugin_id, call_id=args.call_id))
            else:
                view = await self.supervisor.call_plugin(PluginCallEnvelope(
                    **fence.model_dump(), origin="model", session_id=self.session, worker_id=self.instance,
                    plugin_id=args.plugin_id, call_id=args.call_id, name=args.name, arguments=args.arguments,
                    workspace=args.workspace, step_id=action.step_id, request_id=action.request_id,
                    expected_fingerprint=args.fingerprint, expected_load_id=args.load_id, expected_schema_digest=args.schema_digest))
        except BackendError as error:
            if error.code not in {"plugin_catalog_conflict", "plugin_session_mismatch", "plugin_disconnected", "plugin_busy",
                                  "plugin_tool_not_found", "workspace_mismatch", "plugin_model_identity", "unknown_effect_conflict"}:
                raise
            return PluginReturned(action, PluginCallView(call_id=args.call_id, phase="conflict", error=error.code))
        images: list[ImagePart] = []
        text = view.error or view.phase
        if view.result is not None:
            parts = [part for part in view.result.content if part.get("type") != "image"]
            for part in view.result.content:
                if part.get("type") == "image":
                    try:
                        images.append(ImagePart.model_validate({"media_type":part.get("mimeType"), "data_base64":part.get("data")}))
                    except ValueError:
                        parts.append({"type":"text", "text":"Plugin execution completed; an invalid image was omitted. Do not repeat the call."})
            try:
                checked_images(images)
            except BackendError:
                images = []
                parts.append({"type":"text", "text":"Plugin execution completed; invalid media was omitted. Do not repeat the call."})
            text = json.dumps({"content":parts, "details":view.result.details, "is_error":view.result.is_error}, ensure_ascii=False)[:64000]
        return PluginReturned(action, view, text, images)

    async def _job_tool(self, action: ToolInvocation) -> ToolReturned:
        fence = await self._mcp_fence()
        context = JobSession(**fence.model_dump(), session_id=self.session)
        try:
            if action.call.name == "job_list":
                result = await self.supervisor.list_jobs(context)
                return ToolReturned(action, ToolResult(call_id=action.step_id, exit_code=0,
                                                       stdout=result.model_dump_json(), stderr=""))
            if action.call.name == "job_kill":
                query = JobQuery.model_validate_json(action.call.arguments)
                killed = await self.supervisor.kill_job(JobReference(**context.model_dump(), **query.model_dump()))
                return ToolReturned(action, ToolResult(call_id=action.step_id, exit_code=0,
                                                       stdout=killed.model_dump_json(), stderr=""))
            arguments = JobOutputWait.model_validate_json(action.call.arguments)
            query_output = JobOutputQuery(**context.model_dump(), **arguments.model_dump(exclude={"wait_seconds"}))
            deadline = time.monotonic() + arguments.wait_seconds
            while True:
                # Clear before checking durable input: a simultaneous submission either appears in
                # the query or wakes the wait. Completion events do not count as user input.
                self.wake.clear()
                interrupted = await self.store.waiting_user_input(action.request_id)
                frozen = (await self.store.activity()).state in {"frozen", "stopping", "blocked"}
                output = await self.supervisor.job_output(query_output)
                if interrupted:
                    output.wait_reason = "user_input"
                elif output.job.outcome != "pending":
                    output.wait_reason = "completed"
                elif frozen or time.monotonic() >= deadline:
                    output.wait_reason = "deadline"
                else:
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(self.wake.wait(), min(0.2, max(0.001, deadline - time.monotonic())))
                    continue
                return ToolReturned(action, ToolResult(call_id=action.step_id, exit_code=1 if output.error else 0,
                                                       stdout=output.model_dump_json(), stderr=output.error))
        except BackendError as error:
            return ToolReturned(action, ToolResult(call_id=action.step_id, exit_code=1, stdout="", stderr=error.code))

    async def perform(self, action: Action) -> Observation:
        if self.validation:
            raise BackendError("validation_worker")
        if isinstance(action, CodeRetrieval):
            fence = await self._mcp_fence()
            reference = CancelCode(**fence.model_dump(), session_id=self.session, run_id=action.step_id[:32])
            if action.stop:
                view = await self.supervisor.cancel_code(reference)
                try:
                    status = await self.supervisor.code_status(reference)
                except BackendError as error:
                    if error.code != "codemode_not_found":
                        raise
                    status = CodeStatus(view=view, running=False)
            elif action.start:
                source = CodemodeInput.model_validate_json(action.call.arguments)
                status = await self.supervisor.start_code(OpenCode(
                    **fence.model_dump(), session_id=self.session, run_id=action.step_id[:32], source=source.code,
                    worker_id=self.instance, parent_request_id=action.request_id, parent_step_id=action.step_id,
                    allowed_tools=action.config.allowed_tools, excluded_tools=action.config.excluded_tools,
                    state_scope=action.state_scope, initial_state=action.initial_state))
            else:
                status = await self.supervisor.code_status(reference)
            return CodeReturned(action, status)
        if isinstance(action, ModelInvocation):
            answer = ""
            completion: Completion | None = None
            preview_seq = 0
            last_preview = 0.0
            messages = await self.model_input(action.messages)
            # A direct model probe has no session database. A live turn binds the catalog before any token.
            offers = await self._mcp_offers(action.request_id) if self.storage_ready else []
            plugins = await self._plugin_offers() if self.storage_ready else []
            if self.storage_ready:
                await self.store.bind_model_tools(action.step_id, action.generation, self.context.catalog_payload([offer for offer in offers if offer.active]),
                    json.dumps([offer.model_dump() for offer in plugins], ensure_ascii=False, sort_keys=True), self.context.catalog_payload(offers))
            # Read the key after the awaits. A logout that landed first must not be sent.
            # A queued workflow check is not this turn's typed prompt. Leave that prompt intact.
            check = await self.store.workflow_check_text(action.request_id) if self.storage_ready else ""
            if self.context.contains_secret(check):
                raise BackendError("workflow_secret")
            context = clock_context(action.config.time_zone, action.started_at_ms)
            config, auth = await self.context.configured_model(action.config)
            async for item in stream(config, messages, offers, plugins, auth=auth, context=context):
                if not isinstance(item, str):
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
            lease = await self.supervisor.open_epoch(self.owner)
            self._validate_lease(lease)
            return EpochOpened(action.request_id, lease)
        if isinstance(action, CloseEpoch):
            cleanup = await self.supervisor.cleanup(action.lease)
            return EpochClosed(action.request_id, action.lease, cleanup)
        if isinstance(action, WebRetrieval):
            return await self._retrieve_web(action)
        if isinstance(action, McpRetrieval):
            return await self._retrieve_mcp(action)
        if isinstance(action, PluginRetrieval):
            return await self._retrieve_plugin(action)
        if isinstance(action, ToolInvocation):
            if action.call.name in {"job_list", "job_output", "job_kill"}:
                return await self._job_tool(action)
            try:
                prepared = await self.prepare_file_write(action) if action.call.name in {"write_file", "edit_file"} else None
            except BackendError as error:
                if error.code not in {"file_not_observed", "file_conflict", "file_observation_mismatch",
                                       "workspace_missing", "file_not_text", "file_too_large", "checkpoint_unavailable"}:
                    raise
                return ToolReturned(action, ToolResult(call_id=action.step_id, exit_code=1, stdout="", stderr=error.code))
            command = command_for(action.call)
            file = (WriteFile.model_validate_json(action.call.arguments) if action.call.name == "write_file" else
                    EditFile.model_validate_json(action.call.arguments) if action.call.name == "edit_file" else
                    ReadFile.model_validate_json(action.call.arguments) if action.call.name == "read_file" else None)
            try:
                result = await self.supervisor.run_tool(RunTool(
                    **action.lease.model_dump(), call_id=action.step_id, request_id=action.request_id,
                    command=command.command, timeout_seconds=command.timeout_seconds,
                    run_in_background=command.run_in_background, file=file,
                    expected_digest=prepared.expected_digest if prepared else None,
                    expected_root=prepared.root if prepared else "",
                    output_read=OutputRead.model_validate_json(action.call.arguments) if action.call.name == "tool_output" else None,
                    effect="read" if action.call.name in {"read_file", "tool_output"} else "write"))
            except BackendError as error:
                if error.code != "background_capacity":
                    raise
                result = ToolResult(call_id=action.step_id, exit_code=1, stdout="", stderr=error.code)
            return ToolReturned(action, result)
        if isinstance(action, QueryTool):
            observed = await self.supervisor.lookup_tool(ToolLookup(**self.owner.model_dump(), call_id=action.step_id))
            return ToolObserved(action, observed)
        if isinstance(action, ReconcileEffect):
            hold = await self.supervisor.resolve_effect(ResolveEffect(**self.owner.model_dump(), resolution=action.resolution))
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
                    timeout = min(1.0, max(0.01, (action.next_wake_ms - (time.time_ns() // 1_000_000)) / 1000)) if action.next_wake_ms else 1.0
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
                        await self.store.close()
                    finally:
                        await self.supervisor.close()
