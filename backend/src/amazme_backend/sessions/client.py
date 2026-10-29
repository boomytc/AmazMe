"""Client for the worker that owns the session writer."""
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from amazme_backend.contracts.events import Snapshot
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.worker import (
    BeginCompactionBody,
    BeginWebBody,
    BeginWebResult,
    CancelBody,
    ChildBody,
    CodeChild,
    CompactBody,
    CompactionClaim,
    EpochValue,
    IdBody,
    MessageList,
    OpenWorkflowBody,
    PrepareBranchBody,
    SessionOp,
    SessionOpName,
    SessionOpResult,
    SettleWebBody,
    SnapshotBody,
    StoppingBody,
    TranscriptBody,
    TranscriptRow,
    VerdictBody,
)
from amazme_backend.contracts.models import Message
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

    async def prepare_branch(self, parent: Path, request_id: str, web: WebPolicy) -> Receipt:
        return Receipt.model_validate_json(await self._call("prepare_branch", PrepareBranchBody(
            parent_path=str(parent), request_id=request_id, web=web)))

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

    async def messages(self, request_id: str) -> list[Message]:
        return MessageList.model_validate_json(await self._call("messages", IdBody(id=request_id))).messages

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
