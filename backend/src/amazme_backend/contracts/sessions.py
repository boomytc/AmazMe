from __future__ import annotations

import re
from fnmatch import fnmatchcase
from typing import Literal

from pydantic import Field, field_validator, model_validator

from amazme_backend.contracts.models import (
    IMAGE_MAX_COUNT,
    ImagePart,
    ModelCallUsage,
    ModelSelection,
    ThinkingLevel,
    ToolCall,
)
from amazme_backend.contracts.resources import ResourceOptions
from amazme_backend.shared.model import Model

ApprovalPolicy = Literal["auto", "mutations", "all"]


class RunOptions(Model):
    time_zone: str = Field(default="", max_length=64, pattern=r"^(?:UTC|[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)+)?$")
    model_selection: ModelSelection | None = None
    approval_policy: ApprovalPolicy | None = None
    thinking: ThinkingLevel | None = None
    resource_options: ResourceOptions = Field(default_factory=ResourceOptions)
    system_prompt: str | None = Field(default=None, max_length=32000)
    append_system_prompt: str = Field(default="", max_length=32000)
    allowed_tools: list[str] | None = Field(default=None, max_length=128)

    excluded_tools: list[str] = Field(default_factory=list, max_length=128)

    def tool_allowed(self, name: str) -> bool:
        return ((self.allowed_tools is None or any(fnmatchcase(name, pattern) for pattern in self.allowed_tools))
                and not any(fnmatchcase(name, pattern) for pattern in self.excluded_tools))

    @field_validator("allowed_tools", "excluded_tools")
    @classmethod
    def tool_names(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and (len(set(value)) != len(value) or any(not re.fullmatch(r"[A-Za-z_*?][A-Za-z0-9_*?]{0,127}", name) for name in value)):
            raise ValueError("tool selection must contain unique names or patterns")
        return value


class SessionModel(ModelSelection):
    """The model last selected for one session. This does not add a provider implementation."""

    session_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


class Submit(RunOptions):
    tool_call: ToolCall | None = None
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    text: str = Field(max_length=16000)
    mode: Literal["queue", "steer", "reject_busy"] = "queue"
    target_run_id: str = ""
    not_before_ms: int = Field(default=0, ge=0, le=253402300799000)
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart](), max_length=IMAGE_MAX_COUNT)


    @model_validator(mode="after")
    def user_context(self) -> Submit:
        if not self.text and not self.images:
            raise ValueError("missing_user_context")
        return self


TerminalStatus = Literal["succeeded", "cancelled", "interrupted", "failed", "unknown"]


Status = Literal["queued", "running", "waiting_approval", "waiting_input", "waiting_children", "waiting_time", "waiting_host",
                 "cancelling", "cleaning", "blocked", "succeeded", "cancelled", "interrupted", "failed", "unknown"]


class Decision(Model):
    status: TerminalStatus
    answer: str = ""
    error: str = ""


class Receipt(Model):
    request_id: str
    text: str
    status: Status
    answer: str = ""
    error: str = ""
    accepted_revision: str = "0"
    revision: str = "0"
    run_id: str = ""
    parent_id: str = ""
    kind: Literal["root", "child", "steer"] = "root"
    input_origin: Literal["user", "job"] = "user"
    generation: int = 0
    cancel_requested: bool = False
    decision: Decision | None = None
    children: list[str] = Field(default_factory=lambda: list[str]())
    not_before_ms: int = 0
    image_count: int = Field(default=0, ge=0)


class SearchHit(Model):
    request_id: str
    ordinal: int = Field(ge=0)
    role: Literal["user", "assistant", "tool"]
    excerpt: str


class SearchResults(Model):
    query: str
    hits: list[SearchHit]


class UsageTotals(Model):
    """Token totals and catalog cost already stored with finished model calls.

    ``priced`` is true only when every finished call had a catalog rate. A partial sum is not returned
    as ``cost_micro_usd``. One micro-USD is one millionth of a US dollar; the stored product truncates.
    """

    model_calls: int = Field(default=0, ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_write_tokens: int = Field(default=0, ge=0)
    reasoning_signatures: int = Field(default=0, ge=0)
    priced_calls: int = Field(default=0, ge=0)
    unpriced_calls: int = Field(default=0, ge=0)
    priced: bool = False
    cost_micro_usd: int | None = None
    attempted_model_calls: int = Field(default=0, ge=0)
    steps: int = Field(default=0, ge=0)
    unknown_steps: int = Field(default=0, ge=0)
    failed_tool_calls: int = Field(default=0, ge=0)
    model_ms: int = Field(default=0, ge=0)
    timed_model_calls: int = Field(default=0, ge=0)
    tool_ms: int = Field(default=0, ge=0)
    timed_tool_calls: int = Field(default=0, ge=0)
    first_text_ms: int = Field(default=0, ge=0)
    first_text_calls: int = Field(default=0, ge=0)


class ModelUsage(UsageTotals):
    provider: str
    model: str


class RequestUsage(UsageTotals):
    request_id: str
    text: str
    status: Status


class UsageReport(UsageTotals):
    session_id: str
    request_count: int = Field(default=0, ge=0)
    failed_requests: int = Field(default=0, ge=0)
    cancelled_requests: int = Field(default=0, ge=0)
    compaction_calls: int = Field(default=0, ge=0)
    unmeasured_compactions: int = Field(default=0, ge=0)
    latest_context_tokens: int | None = None
    models: list[ModelUsage] = Field(default_factory=lambda: list[ModelUsage]())
    recent: list[RequestUsage] = Field(default_factory=lambda: list[RequestUsage](), max_length=100)


class SessionDiagnostic(Model):
    """Persisted session state. Error text that is not a short code is replaced before it leaves."""

    session_id: str
    present: bool
    state: Literal["absent", "ready", "blocked", "stopping", "frozen"]
    blocked_code: str = ""
    failed: int = Field(default=0, ge=0)
    unknown: int = Field(default=0, ge=0)
    error_codes: list[str] = Field(default_factory=list)


class DelegateTasks(Model):
    tasks: list[str] = Field(min_length=1, max_length=8)


class TranscriptMessage(Model):
    key: str
    ordinal: int = Field(ge=1)
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_calls: list[str] = Field(default_factory=list)


WorkerState = Literal["recovering", "ready", "blocked", "stopping", "frozen"]


class Session(Model):
    updated_ms: int = Field(default=0, ge=0)
    session_id: str
    title: str
    parent_id: str = ""
    fork_request_id: str = ""
    archived: bool = False
    workspace: str = "primary"
    project_id: str = ""
    prepared: bool = True


class SessionList(Model):
    sessions: list[Session]


class BranchSession(Model):
    branch_id: str = Field(default="", pattern=r"^(?:[a-f0-9]{32})?$")
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    title: str = Field(default="", max_length=100)


class ArchiveSession(Model):
    archived: bool


class SessionApprovalPolicy(Model):
    policy: ApprovalPolicy


class RenameSession(Model):
    title: str = Field(min_length=1, max_length=100)
    expected_title: str


class CompactSession(Model):
    compaction_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    through_request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    instructions: str = Field(default="", max_length=4000)


class Compaction(Model):
    compaction_id: str
    through_request_id: str
    basis: str
    message_count: int = Field(ge=1)
    summary: str = Field(min_length=1, max_length=16000)
    instructions: str = ""
    usage: ModelCallUsage | None = None


class CreateSession(Model):
    title: str = Field(default="新会话", min_length=1, max_length=100)
    workspace: str = "primary"
    project_id: str = ""
    session_id: str = ""
    reuse_empty: bool = False


class WorkflowChild(Model):
    request_id: str
    role: Literal["check", "correction"]
    text: str
    status: Status = "queued"


class WorkflowOpen(Model):
    workflow_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    check: str = Field(min_length=1, max_length=16000)
    correction_limit: int = Field(default=1, ge=0, le=8)


class WorkflowVerdict(Model):
    verdict_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    passed: bool


class WorkflowView(Model):
    workflow_id: str
    session_id: str
    stage: Literal["check", "correction", "passed", "exhausted", "cancelled"]
    correction_limit: int = Field(ge=0, le=8)
    attempts: int = Field(ge=0)
    parent_id: str
    parent_status: Status = "waiting_children"
    check: str
    children: list[WorkflowChild] = Field(default_factory=lambda: list[WorkflowChild]())


class Preview(Model):
    request_id: str
    run_id: str
    generation: int
    preview_seq: str
    text: str


class Approval(Model):
    approval_id: str
    request_id: str
    run_id: str
    call_id: str
    call: ToolCall
    build_id: str
    proposal_digest: str
    revision: str
    state: Literal["pending", "approved", "denied", "consumed", "expired"]


class ApprovalDecision(Model):
    decision_id: str = Field(min_length=1, max_length=128)
    approval_id: str
    expected_revision: str
    proposal_digest: str
    approve: bool


class Attachment(Model):
    attachment_id: str
    session_id: str
    host_epoch: int
    build_id: str
