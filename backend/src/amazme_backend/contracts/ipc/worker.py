from __future__ import annotations

from typing import Literal

from pydantic import Field, JsonValue

from amazme_backend.contracts.computer import ComputerActionView, ComputerPolicy
from amazme_backend.contracts.execution import EffectResolution
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.models import ImagePart, Message, ToolCall
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import ApprovalDecision, Compaction, Submit, WorkerState
from amazme_backend.contracts.web import WebCallView, WebPolicy
from amazme_backend.shared.model import Model


class CodeChild(Model):
    parent_request_id: str
    parent_step_id: str
    request_id: str
    call: ToolCall


class Submission(HostFence):
    value: Submit
    provider: ProviderConfig | None = None


class Cancel(HostFence):
    request_id: str


class ApprovalEnvelope(HostFence):
    value: ApprovalDecision


class ResolutionEnvelope(HostFence):
    value: EffectResolution


class FreezeWorker(HostFence):
    freeze_id: str
    cancel_work: bool = False


class WorkerActivity(Model):
    pending: int
    runnable: bool
    next_wake_ms: int
    state: WorkerState


SessionOpName = Literal[
    "prepare_branch",
    "stopping",
    "accept_code_tool",
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
    instructions: str = ""


class CompactionClaim(Model):
    compaction: Compaction | None = None


class CompactBody(BeginCompactionBody):
    summary: str
    basis: str


class TranscriptRow(Model):
    request_id: str
    role: Literal["user", "assistant", "tool"]
    content: str


class TranscriptBody(Model):
    messages: list[TranscriptRow]


class PrepareBranchBody(Model):
    parent_path: str
    request_id: str
    web: WebPolicy
    computer: ComputerPolicy


class StoppingBody(Model):
    fence: HostFence
    execution_epoch: int | None = None
    cancel_work: bool = True
