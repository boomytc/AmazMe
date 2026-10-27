"""Client for the worker that owns the session writer."""
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, JsonValue

from amazme_backend.contracts.computer import ComputerActionView, ComputerCaptureView, ComputerPolicy
from amazme_backend.contracts.events import Snapshot
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.worker import (
    BeginCompactionBody,
    BeginComputerBody,
    BeginComputerResult,
    BeginWebBody,
    BeginWebResult,
    CancelBody,
    ChildBody,
    CodeChild,
    CompactBody,
    CompactionClaim,
    EpochValue,
    ExitBody,
    FindActionBody,
    FlagValue,
    FoundAction,
    IdBody,
    MessageList,
    OpenWorkflowBody,
    PrepareBranchBody,
    RuntimeValue,
    SessionOp,
    SessionOpName,
    SessionOpResult,
    SettleComputerBody,
    SettleWebBody,
    SnapshotBody,
    StoppingBody,
    TextValue,
    TranscriptBody,
    TranscriptRow,
    VerdictBody,
)
from amazme_backend.contracts.models import ImagePart, Message
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import (
    Compaction,
    Receipt,
    SessionApprovalPolicy,
    WorkerState,
    WorkflowView,
)
from amazme_backend.contracts.web import WebCallView, WebPolicy
from amazme_backend.platform.ipc import Peer


class SessionRelay:
    """Forward session writes to the worker that already owns the database."""

    def __init__(self, peer: Peer):
        self.peer = peer

    async def set_approval_policy(self, value: SessionApprovalPolicy) -> SessionApprovalPolicy:
        return SessionApprovalPolicy.model_validate_json(await self._call("set_approval_policy", value))

    async def prepare_branch(self, parent: Path, request_id: str, web: WebPolicy,
                             computer: ComputerPolicy) -> Receipt:
        return Receipt.model_validate_json(await self._call("prepare_branch", PrepareBranchBody(
            parent_path=str(parent), request_id=request_id, web=web, computer=computer)))

    async def stopping(self, fence: HostFence, execution_epoch: int | None = None, *,
                       cancel_work: bool = True) -> None:
        await self._call("stopping", StoppingBody(fence=fence, execution_epoch=execution_epoch,
                                                 cancel_work=cancel_work))

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

    async def begin_compaction(self, compaction_id: str, through_request_id: str, instructions: str = "") -> Compaction | None:
        claim = CompactionClaim.model_validate_json(await self._call("begin_compaction", BeginCompactionBody(
            compaction_id=compaction_id, through_request_id=through_request_id, instructions=instructions)))
        return claim.compaction

    async def accept_code_tool(self, value: CodeChild) -> Receipt:
        return Receipt.model_validate_json(await self._call("accept_code_tool", value))

    async def release_compaction(self, compaction_id: str) -> None:
        await self._call("release_compaction", BeginCompactionBody(
            compaction_id=compaction_id, through_request_id=""))

    async def commit_compaction(self, compaction_id: str, through_request_id: str, summary: str, basis: str, instructions: str = "") -> Compaction:
        return Compaction.model_validate_json(await self._call("commit_compaction", CompactBody(
            compaction_id=compaction_id, through_request_id=through_request_id, summary=summary, basis=basis, instructions=instructions)))

    async def import_transcript(self, messages: list[tuple[str, str, str]]) -> None:
        await self._call("import_transcript", TranscriptBody(messages=[
            TranscriptRow.model_validate({"request_id": request_id, "role": role, "content": content})
            for request_id, role, content in messages]))
