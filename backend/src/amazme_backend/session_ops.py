"""Session writes belong to the process that holds session.lock. Others send a closed operation set."""

from typing import Literal, Protocol

from pydantic import BaseModel, Field, JsonValue

from .common import Peer
from .contracts import (
    BackendError,
    Compaction,
    ComputerActionView,
    ComputerCaptureView,
    ComputerPolicy,
    HostFence,
    ImagePart,
    Message,
    Model,
    ProviderConfig,
    Receipt,
    Snapshot,
    WebCallView,
    WebPolicy,
    WorkerState,
    WorkflowView,
)
from .storage import SessionStore

SessionOpName = Literal[
    "open_workflow",
    "workflow",
    "resume_workflow",
    "record_verdict",
    "cancel",
    "host_epoch",
    "snapshot",
    "cancel_workflow_child",
    "save_web_policy",
    "web_policy",
    "begin_web_call",
    "settle_web_call",
    "save_computer_policy",
    "computer_policy",
    "computer_blocked",
    "computer_runtime",
    "find_computer_action",
    "latest_computer_capture",
    "messages",
    "note_computer_exit",
    "save_computer_capture",
    "begin_computer_action",
    "settle_computer_action",
    "finish_computer_cleanup",
    "begin_compaction",
    "release_compaction",
    "commit_compaction",
    "import_transcript",
]


class SessionOp(Model):
    name: SessionOpName
    payload: str = ""


class SessionOpResult(Model):
    payload: str = ""


class IdBody(Model):
    id: str


class EpochValue(Model):
    value: int


class TextValue(Model):
    value: str


class FlagValue(Model):
    value: bool


class MessageList(Model):
    messages: list[Message]


class FindActionBody(Model):
    action_id: str
    body: str


class FoundAction(Model):
    view: ComputerActionView | None = None


class RuntimeValue(Model):
    blocked: bool
    exit_code: int | None = None
    proof: str


class OpenWorkflowBody(Model):
    workflow_id: str
    check: str
    correction_limit: int
    accepted_config: ProviderConfig | None = None


class VerdictBody(Model):
    workflow_id: str
    verdict_id: str
    passed: bool
    allow_new_child: bool = True


class CancelBody(Model):
    request_id: str
    fence: HostFence


class SnapshotBody(Model):
    state: WorkerState | None = None


class ChildBody(Model):
    workflow_id: str
    request_id: str


class BeginWebBody(Model):
    call_id: str
    kind: Literal["search", "fetch"]
    body: str


class BeginWebResult(Model):
    view: WebCallView
    send: bool


class SettleWebBody(Model):
    call_id: str
    phase: Literal["unknown", "done", "failed"]
    error: str
    result: str


class ExitBody(Model):
    exit_code: int | None = None


class BeginComputerBody(Model):
    action_id: str
    body: str


class BeginComputerResult(Model):
    view: ComputerActionView
    send: bool


class SettleComputerBody(Model):
    result: dict[str, JsonValue] = Field(default_factory=lambda:dict[str, JsonValue]())
    images: list[ImagePart] = Field(default_factory=lambda:list[ImagePart]())
    action_id: str
    phase: Literal["unknown", "done", "failed"]
    error: str
    driver_x: int | None = None
    driver_y: int | None = None


class BeginCompactionBody(Model):
    compaction_id: str
    through_request_id: str


class CompactionClaim(Model):
    compaction: Compaction | None = None


class CompactBody(Model):
    compaction_id: str
    through_request_id: str
    summary: str
    basis: str


class TranscriptRow(Model):
    request_id: str
    role: Literal["user", "assistant", "tool"]
    content: str


class TranscriptBody(Model):
    messages: list[TranscriptRow]


def _model(value: BaseModel) -> str:
    return value.model_dump_json()


async def run_session_op(store: SessionStore, name: SessionOpName, payload: str) -> str:
    """Run one session-library operation on the store that already holds the lock."""
    if name == "host_epoch":
        return _model(EpochValue(value=await store.host_epoch()))
    if name == "snapshot":
        body = SnapshotBody.model_validate_json(payload or "{}")
        return _model(await store.snapshot(body.state))
    if name == "workflow":
        return _model(await store.workflow(IdBody.model_validate_json(payload).id))
    if name == "resume_workflow":
        return _model(await store.resume_workflow(IdBody.model_validate_json(payload).id))
    if name == "open_workflow":
        body = OpenWorkflowBody.model_validate_json(payload)
        return _model(await store.open_workflow(body.workflow_id, body.check, body.correction_limit,
                                                accepted_config=body.accepted_config))
    if name == "record_verdict":
        body = VerdictBody.model_validate_json(payload)
        return _model(await store.record_verdict(
            body.workflow_id, body.verdict_id, body.passed, allow_new_child=body.allow_new_child))
    if name == "cancel":
        body = CancelBody.model_validate_json(payload)
        return _model(await store.cancel(body.request_id, body.fence))
    if name == "cancel_workflow_child":
        body = ChildBody.model_validate_json(payload)
        return _model(await store.cancel_workflow_child(body.workflow_id, body.request_id))
    if name == "save_web_policy":
        return _model(await store.save_web_policy(WebPolicy.model_validate_json(payload)))
    if name == "web_policy":
        return _model(await store.web_policy())
    if name == "begin_web_call":
        body = BeginWebBody.model_validate_json(payload)
        view, send = await store.begin_web_call(body.call_id, body.kind, body.body)
        return _model(BeginWebResult(view=view, send=send))
    if name == "settle_web_call":
        body = SettleWebBody.model_validate_json(payload)
        return _model(await store.settle_web_call(body.call_id, body.phase, body.error, body.result))
    if name == "save_computer_policy":
        return _model(await store.save_computer_policy(ComputerPolicy.model_validate_json(payload)))
    if name == "computer_policy":
        return _model(await store.computer_policy())
    if name == "computer_blocked":
        return _model(FlagValue(value=await store.computer_blocked()))
    if name == "computer_runtime":
        blocked, exit_code, proof = await store.computer_runtime()
        return _model(RuntimeValue(blocked=blocked, exit_code=exit_code, proof=proof))
    if name == "find_computer_action":
        body = FindActionBody.model_validate_json(payload)
        return _model(FoundAction(view=await store.find_computer_action(body.action_id, body.body)))
    if name == "latest_computer_capture":
        found = await store.latest_computer_capture()
        return "" if found is None else _model(found)
    if name == "messages":
        return _model(MessageList(messages=await store.messages(IdBody.model_validate_json(payload).id)))
    if name == "note_computer_exit":
        await store.note_computer_exit(ExitBody.model_validate_json(payload or "{}").exit_code)
        return ""
    if name == "save_computer_capture":
        return _model(await store.save_computer_capture(ComputerCaptureView.model_validate_json(payload)))
    if name == "begin_computer_action":
        body = BeginComputerBody.model_validate_json(payload)
        view, send = await store.begin_computer_action(body.action_id, body.body)
        return _model(BeginComputerResult(view=view, send=send))
    if name == "settle_computer_action":
        body = SettleComputerBody.model_validate_json(payload)
        return _model(await store.settle_computer_action(
            body.action_id, body.phase, body.error, body.driver_x, body.driver_y, body.result, body.images))
    if name == "finish_computer_cleanup":
        return _model(TextValue(value=await store.finish_computer_cleanup(TextValue.model_validate_json(payload).value)))
    if name == "begin_compaction":
        body = BeginCompactionBody.model_validate_json(payload)
        return _model(CompactionClaim(compaction=await store.begin_compaction(
            body.compaction_id, body.through_request_id)))
    if name == "release_compaction":
        await store.release_compaction(BeginCompactionBody.model_validate_json(payload).compaction_id)
        return ""
    if name == "commit_compaction":
        body = CompactBody.model_validate_json(payload)
        return _model(await store.commit_compaction(
            body.compaction_id, body.through_request_id, body.summary, body.basis))
    if name == "import_transcript":
        body = TranscriptBody.model_validate_json(payload)
        await store.import_transcript([(item.request_id, item.role, item.content) for item in body.messages])
        return ""
    raise BackendError("session_op_unknown")


class SessionOps(Protocol):
    async def open_workflow(self, workflow_id: str, check: str, correction_limit: int, *,
                            accepted_config: ProviderConfig | None = None) -> WorkflowView: ...
    async def workflow(self, workflow_id: str) -> WorkflowView: ...
    async def resume_workflow(self, workflow_id: str) -> WorkflowView: ...
    async def record_verdict(self, workflow_id: str, verdict_id: str, passed: bool, *,
                             allow_new_child: bool = True) -> WorkflowView: ...
    async def cancel(self, request_id: str, fence: HostFence) -> Receipt: ...
    async def host_epoch(self) -> int: ...
    async def snapshot(self, state: WorkerState | None = None) -> Snapshot: ...
    async def cancel_workflow_child(self, workflow_id: str, request_id: str) -> WorkflowView: ...
    async def save_web_policy(self, value: WebPolicy) -> WebPolicy: ...
    async def web_policy(self) -> WebPolicy: ...
    async def begin_web_call(self, call_id: str, kind: Literal["search", "fetch"], body: str) -> tuple[WebCallView, bool]: ...
    async def settle_web_call(self, call_id: str, phase: Literal["unknown", "done", "failed"], error: str, result: str) -> WebCallView: ...
    async def save_computer_policy(self, value: ComputerPolicy) -> ComputerPolicy: ...
    async def computer_policy(self) -> ComputerPolicy: ...
    async def computer_blocked(self) -> bool: ...
    async def computer_runtime(self) -> tuple[bool, int | None, str]: ...
    async def find_computer_action(self, action_id: str, body: str) -> ComputerActionView | None: ...
    async def latest_computer_capture(self) -> ComputerCaptureView | None: ...
    async def messages(self, request_id: str) -> list[Message]: ...
    async def note_computer_exit(self, exit_code: int | None) -> None: ...
    async def save_computer_capture(self, value: ComputerCaptureView) -> ComputerCaptureView: ...
    async def begin_computer_action(self, action_id: str, body: str) -> tuple[ComputerActionView, bool]: ...
    async def settle_computer_action(self, action_id: str, phase: Literal["unknown", "done", "failed"], error: str, driver_x: int | None, driver_y: int | None, result: dict[str, JsonValue] | None = None,
                                     images: list[ImagePart] | None = None) -> ComputerActionView: ...
    async def finish_computer_cleanup(self, proof: str) -> str: ...
    async def begin_compaction(self, compaction_id: str, through_request_id: str) -> Compaction | None: ...
    async def release_compaction(self, compaction_id: str) -> None: ...
    async def commit_compaction(self, compaction_id: str, through_request_id: str, summary: str, basis: str) -> Compaction: ...
    async def import_transcript(self, messages: list[tuple[str, str, str]]) -> None: ...


class SessionRelay:
    """Forward session writes to the worker that already owns the database."""

    def __init__(self, peer: Peer):
        self.peer = peer

    async def _call(self, name: SessionOpName, payload: BaseModel | None = None) -> str:
        result = await self.peer.call("POST", "/session-ops", SessionOpResult, SessionOp(
            name=name, payload="" if payload is None else payload.model_dump_json()))
        return result.payload

    async def host_epoch(self) -> int:
        return EpochValue.model_validate_json(await self._call("host_epoch")).value

    async def snapshot(self, state: WorkerState | None = None) -> Snapshot:
        return Snapshot.model_validate_json(await self._call("snapshot", SnapshotBody(state=state)))

    async def workflow(self, workflow_id: str) -> WorkflowView:
        return WorkflowView.model_validate_json(await self._call("workflow", IdBody(id=workflow_id)))

    async def resume_workflow(self, workflow_id: str) -> WorkflowView:
        return WorkflowView.model_validate_json(await self._call("resume_workflow", IdBody(id=workflow_id)))

    async def open_workflow(self, workflow_id: str, check: str, correction_limit: int, *,
                            accepted_config: ProviderConfig | None = None) -> WorkflowView:
        return WorkflowView.model_validate_json(await self._call("open_workflow", OpenWorkflowBody(
            workflow_id=workflow_id, check=check, correction_limit=correction_limit, accepted_config=accepted_config)))

    async def record_verdict(self, workflow_id: str, verdict_id: str, passed: bool, *,
                             allow_new_child: bool = True) -> WorkflowView:
        return WorkflowView.model_validate_json(await self._call("record_verdict", VerdictBody(
            workflow_id=workflow_id, verdict_id=verdict_id, passed=passed, allow_new_child=allow_new_child)))

    async def cancel(self, request_id: str, fence: HostFence) -> Receipt:
        return Receipt.model_validate_json(await self._call("cancel", CancelBody(request_id=request_id, fence=fence)))

    async def cancel_workflow_child(self, workflow_id: str, request_id: str) -> WorkflowView:
        return WorkflowView.model_validate_json(await self._call(
            "cancel_workflow_child", ChildBody(workflow_id=workflow_id, request_id=request_id)))

    async def save_web_policy(self, value: WebPolicy) -> WebPolicy:
        return WebPolicy.model_validate_json(await self._call("save_web_policy", value))

    async def web_policy(self) -> WebPolicy:
        return WebPolicy.model_validate_json(await self._call("web_policy"))

    async def begin_web_call(self, call_id: str, kind: Literal["search", "fetch"], body: str) -> tuple[WebCallView, bool]:
        result = BeginWebResult.model_validate_json(await self._call(
            "begin_web_call", BeginWebBody(call_id=call_id, kind=kind, body=body)))
        return result.view, result.send

    async def settle_web_call(self, call_id: str, phase: Literal["unknown", "done", "failed"],
                              error: str, result: str) -> WebCallView:
        return WebCallView.model_validate_json(await self._call("settle_web_call", SettleWebBody(
            call_id=call_id, phase=phase, error=error, result=result)))

    async def save_computer_policy(self, value: ComputerPolicy) -> ComputerPolicy:
        return ComputerPolicy.model_validate_json(await self._call("save_computer_policy", value))

    async def computer_policy(self) -> ComputerPolicy:
        return ComputerPolicy.model_validate_json(await self._call("computer_policy"))

    async def computer_blocked(self) -> bool:
        return FlagValue.model_validate_json(await self._call("computer_blocked")).value

    async def computer_runtime(self) -> tuple[bool, int | None, str]:
        value = RuntimeValue.model_validate_json(await self._call("computer_runtime"))
        return value.blocked, value.exit_code, value.proof

    async def find_computer_action(self, action_id: str, body: str) -> ComputerActionView | None:
        return FoundAction.model_validate_json(await self._call(
            "find_computer_action", FindActionBody(action_id=action_id, body=body))).view

    async def latest_computer_capture(self) -> ComputerCaptureView | None:
        payload = await self._call("latest_computer_capture")
        if not payload:
            return None
        return ComputerCaptureView.model_validate_json(payload)

    async def messages(self, request_id: str) -> list[Message]:
        return MessageList.model_validate_json(await self._call("messages", IdBody(id=request_id))).messages

    async def note_computer_exit(self, exit_code: int | None) -> None:
        await self._call("note_computer_exit", ExitBody(exit_code=exit_code))

    async def save_computer_capture(self, value: ComputerCaptureView) -> ComputerCaptureView:
        return ComputerCaptureView.model_validate_json(await self._call("save_computer_capture", value))

    async def begin_computer_action(self, action_id: str, body: str) -> tuple[ComputerActionView, bool]:
        result = BeginComputerResult.model_validate_json(await self._call(
            "begin_computer_action", BeginComputerBody(action_id=action_id, body=body)))
        return result.view, result.send

    async def settle_computer_action(self, action_id: str, phase: Literal["unknown", "done", "failed"],
                                     error: str, driver_x: int | None, driver_y: int | None, result: dict[str, JsonValue] | None = None,
                                     images: list[ImagePart] | None = None) -> ComputerActionView:
        return ComputerActionView.model_validate_json(await self._call("settle_computer_action", SettleComputerBody(
            action_id=action_id, phase=phase, error=error, driver_x=driver_x, driver_y=driver_y, result=result or {}, images=images or [])))

    async def finish_computer_cleanup(self, proof: str) -> str:
        return TextValue.model_validate_json(await self._call("finish_computer_cleanup", TextValue(value=proof))).value

    async def begin_compaction(self, compaction_id: str, through_request_id: str) -> Compaction | None:
        claim = CompactionClaim.model_validate_json(await self._call("begin_compaction", BeginCompactionBody(
            compaction_id=compaction_id, through_request_id=through_request_id)))
        return claim.compaction

    async def release_compaction(self, compaction_id: str) -> None:
        await self._call("release_compaction", BeginCompactionBody(
            compaction_id=compaction_id, through_request_id=""))

    async def commit_compaction(self, compaction_id: str, through_request_id: str, summary: str, basis: str) -> Compaction:
        return Compaction.model_validate_json(await self._call("commit_compaction", CompactBody(
            compaction_id=compaction_id, through_request_id=through_request_id, summary=summary, basis=basis)))

    async def import_transcript(self, messages: list[tuple[str, str, str]]) -> None:
        await self._call("import_transcript", TranscriptBody(messages=[
            TranscriptRow.model_validate({"request_id": request_id, "role": role, "content": content})
            for request_id, role, content in messages]))
