from __future__ import annotations

import hashlib
from typing import Literal

from pydantic import Field

from amazme_backend.contracts.execution import EffectResolution, JobId
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.models import Message, ToolCall
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


class JobNotice(Model):
    job_id: JobId
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    parent_request_id: str = Field(min_length=1, max_length=128)
    state: Literal["succeeded", "failed", "cancelled", "unknown"]
    exit_code: int | None = None
    stop_reason: str = ""

    @property
    def request_id(self) -> str:
        return "job-" + hashlib.sha256(self.job_id.encode()).hexdigest()


class JobNoticeEnvelope(HostFence):
    value: JobNotice


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
    "messages",
    "begin_compaction",
    "release_compaction",
    "commit_compaction",
    "import_transcript",
    "set_approval_policy",
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


class MessageList(Model):
    messages: list[Message]


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


class StoppingBody(Model):
    fence: HostFence
    execution_epoch: int | None = None
    cancel_work: bool = True
