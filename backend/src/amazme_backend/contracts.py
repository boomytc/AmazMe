from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from fnmatch import fnmatchcase
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, SecretStr, field_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


ProviderApi = Literal["openai-completions", "openai-responses", "openai-codex-responses",
                      "anthropic-messages", "google-generative-ai"]


TOOL_NAME_PATTERN = r"^(shell|read_file|write_file|delegate_task|web_search|web_fetch|computer_observe|computer_act|mcp_tool|mcp_[a-f0-9]{20}|plugin_tool|plugin_[a-f0-9]{20})$"


class RunOptions(Model):
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


class ProviderConfig(RunOptions):
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-flash"
    api_key: SecretStr = SecretStr("")
    api: ProviderApi = "openai-completions"
    auth_type: Literal["api_key", "oauth"] = "api_key"
    max_tokens: int = Field(default=2048, ge=32, le=8192)
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)


class CatalogModel(Model):
    api: ProviderApi = "openai-completions"
    base_url: str = ""
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    model: str
    label: str
    endpoint_editable: bool


class ModelSettings(Model):
    api: ProviderApi = "openai-completions"
    auth_type: Literal["api_key", "oauth"] = "api_key"
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    model: str
    base_url: str
    max_tokens: int
    key_configured: bool
    credential_revision: int = 0
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)


class ModelCatalog(Model):
    models: list[CatalogModel]
    current: ModelSettings


class SessionModel(Model):
    """The model last selected for one session. This does not add a provider implementation."""

    session_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    model: str = Field(pattern=r"^[\w.:-]{1,128}$")


class UpdateModelSettings(Model):
    """Model selection never carries an API key. Credential changes use CredentialUpdate."""

    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    api: ProviderApi | None = None
    model: str = Field(min_length=1, max_length=128, pattern=r"^[\w./:@+-]+$")
    base_url: str = Field(default="", max_length=300)
    max_tokens: int = Field(default=2048, ge=32, le=8192)
    proxy: str = Field(default="", max_length=300)
    headers: dict[str, str] = Field(default_factory=dict)


class CredentialUpdate(Model):
    expected_revision: int = Field(ge=0, le=1_000_000_000)
    clear: bool = False
    api_key: SecretStr = SecretStr("")


class ProfileConfig(Model):
    format: Literal[2] = 2
    profile_id: str
    workspace: str
    resources: str
    provider: ProviderConfig
    approval_policy: Literal["auto", "mutations", "all"] = "mutations"
    testing: bool = False
    credential_revision: int = Field(default=0, ge=0)


class Identity(Model):
    version: str = "0.1.0"
    protocol: str = "amazme-http/1"
    build_id: str
    profile_id: str
    instance_id: str
    pid: int
    host_epoch: int = 0
    role: Literal["host", "supervisor", "worker"] = "host"
    state: str = "ready"
    fingerprint: str = ""
    storage_format: Literal[2] = 2


class HostReady(Identity):
    url: str = Field(pattern=r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}$")


IMAGE_MEDIA_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
IMAGE_MAX_BYTES = 8 * 1024 * 1024
IMAGE_MAX_COUNT = 8
_IMAGE_BASE64_MAX = (IMAGE_MAX_BYTES + 2) // 3 * 4


class ImagePart(Model):
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data_base64: str = Field(min_length=1, max_length=_IMAGE_BASE64_MAX)


def checked_images(images: list[ImagePart]) -> list[ImagePart]:
    """Reject a prompt image before it is stored or sent. The bytes stay out of ordinary events."""
    if len(images) > IMAGE_MAX_COUNT:
        raise BackendError("too_many_images")
    for image in images:
        try:
            raw = base64.b64decode(image.data_base64, validate=True)
        except (binascii.Error, ValueError):
            raise BackendError("invalid_image") from None
        if not raw:
            raise BackendError("invalid_image")
        if len(raw) > IMAGE_MAX_BYTES:
            raise BackendError("image_too_large")
    return images


class Submit(RunOptions):
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    text: str = Field(min_length=1, max_length=16000)
    mode: Literal["queue", "steer", "reject_busy"] = "queue"
    target_run_id: str = ""
    not_before_ms: int = Field(default=0, ge=0, le=253402300799000)
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart](), max_length=IMAGE_MAX_COUNT)


TerminalStatus = Literal["succeeded", "cancelled", "interrupted", "failed", "unknown"]
Status = Literal["queued", "running", "waiting_approval", "waiting_children", "waiting_time", "waiting_host",
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
    generation: int = 0
    cancel_requested: bool = False
    decision: Decision | None = None
    children: list[str] = Field(default_factory=lambda: list[str]())
    not_before_ms: int = 0
    image_count: int = Field(default=0, ge=0)


class ToolCall(Model):
    id: str
    # mcp_tool is the session's canonical call. mcp_<20 hex> is only the name offered to a provider.
    name: str = Field(pattern=TOOL_NAME_PATTERN)
    arguments: str


class Message(Model):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=lambda: list[ToolCall]())
    tool_call_id: str = ""
    provider_response_id: str = ""
    # Opaque provider replay data. Ordinary usage and logs do not include this text.
    reasoning_signature: str = ""
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart](), max_length=IMAGE_MAX_COUNT)


class SearchHit(Model):
    request_id: str
    ordinal: int = Field(ge=0)
    role: Literal["user", "assistant", "tool"]
    excerpt: str


class SearchResults(Model):
    query: str
    hits: list[SearchHit]


class UsageReport(Model):
    """Token totals and catalog cost already stored with finished model calls.

    ``priced`` is true only when every finished call had a catalog rate. A partial sum is not returned
    as ``cost_micro_usd``. One micro-USD is one millionth of a US dollar; the stored product truncates.
    """

    session_id: str
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


class SessionDiagnostic(Model):
    """Persisted session state. Error text that is not a short code is replaced before it leaves."""

    session_id: str
    present: bool
    state: Literal["absent", "ready", "blocked", "stopping", "frozen"]
    blocked_code: str = ""
    failed: int = Field(default=0, ge=0)
    unknown: int = Field(default=0, ge=0)
    error_codes: list[str] = Field(default_factory=list)


class Command(Model):
    command: str = Field(min_length=1, max_length=196608)
    timeout_seconds: int = Field(default=30, ge=1, le=120)


class Shell(Command):
    command: str = Field(min_length=1, max_length=16000)


class ReadFile(Model):
    path: str = Field(min_length=1, max_length=1024)


class WriteFile(ReadFile):
    content: str = Field(max_length=32000)


class DelegateTasks(Model):
    tasks: list[str] = Field(min_length=1, max_length=8)


class WebSearch(Model):
    query: str = Field(min_length=1, max_length=512)
    count: int | None = Field(default=None, ge=1, le=50)


class WebFetch(Model):
    url: str = Field(min_length=1, max_length=8192)


class ToolResult(Model):
    call_id: str
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool = False
    stop_reason: str = ""


class Event(Model):
    seq: str
    kind: Literal["accepted", "status", "preview", "message", "tool", "cleanup", "approval", "children", "effect",
                  "freeze", "compaction"]
    request_id: str
    text: str
    receipt: Receipt | None = None
    approval: Approval | None = None
    preview: Preview | None = None


WorkerState = Literal["recovering", "ready", "blocked", "stopping", "frozen"]


class Snapshot(Model):
    session_id: str
    stream_id: str
    seq: str
    state: WorkerState
    requests: list[Receipt]
    events: list[Event]
    approvals: list[Approval] = Field(default_factory=lambda: list[Approval]())
    effects: list[EffectHold] = Field(default_factory=lambda: list[EffectHold]())
    previews: list[Preview] = Field(default_factory=lambda: list[Preview]())
    next_wake_ms: int = 0
    pending: int = 0
    compaction: str = ""


class Session(Model):
    session_id: str
    title: str
    parent_id: str = ""
    fork_request_id: str = ""
    archived: bool = False
    workspace: str = "primary"
    project_id: str = ""


class SessionList(Model):
    sessions: list[Session]


class BranchSession(Model):
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    title: str = Field(default="", max_length=100)


class ArchiveSession(Model):
    archived: bool


class CompactSession(Model):
    compaction_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    through_request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")


class Compaction(Model):
    compaction_id: str
    through_request_id: str
    basis: str
    message_count: int = Field(ge=1)
    summary: str = Field(min_length=1, max_length=16000)


class EventList(Model):
    events: list[Event]


class CreateSession(Model):
    title: str = Field(default="新会话", min_length=1, max_length=100)
    workspace: str = "primary"
    project_id: str = ""
    session_id: str = ""


class ProjectWrite(Model):
    project_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=80)


class ProjectView(Model):
    project_id: str
    name: str


class ProjectList(Model):
    projects: list[ProjectView] = Field(default_factory=lambda: list[ProjectView]())


class ProductSettings(Model):
    display_name: str = ""
    revision: int = 0


class SettingsUpdate(Model):
    display_name: str = Field(min_length=1, max_length=80)
    expected_revision: int = Field(ge=0)


class FeedbackWrite(Model):
    feedback_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = ""
    text: str = Field(min_length=1, max_length=4000)


class FeedbackView(Model):
    feedback_id: str
    session_id: str
    text: str


class ShareWrite(Model):
    share_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ShareMessage(Model):
    request_id: str
    role: Literal["user", "assistant", "tool"]
    content: str


class ShareView(Model):
    share_id: str
    session_id: str
    digest: str
    messages: list[ShareMessage] = Field(default_factory=lambda: list[ShareMessage]())


class ExportMessage(Model):
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    role: Literal["user", "assistant", "tool"]
    content: str = Field(min_length=1, max_length=16000)


class ExportSession(Model):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    title: str = Field(min_length=1, max_length=100)
    project_id: str = ""
    workspace: str = "primary"
    messages: list[ExportMessage] = Field(default_factory=lambda: list[ExportMessage]())


class ExportBundle(Model):
    format: str = Field(min_length=1, max_length=64)
    digest: str = ""
    projects: list[ProjectView] = Field(default_factory=lambda: list[ProjectView]())
    sessions: list[ExportSession] = Field(default_factory=lambda: list[ExportSession]())
    feedback: list[FeedbackView] = Field(default_factory=lambda: list[FeedbackView]())
    settings: ProductSettings = Field(default_factory=ProductSettings)


class ImportResult(Model):
    format: Literal["amazme-export/1"]
    sessions: int
    created: int


class MemoryWrite(Model):
    memory_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = "primary"
    text: str = Field(min_length=1, max_length=500)


class MemoryView(Model):
    memory_id: str
    workspace: str
    text: str


class MemoryList(Model):
    workspace: str
    memories: list[MemoryView]


class CheckpointCreate(Model):
    checkpoint_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = "primary"
    path: str = Field(min_length=1, max_length=1024)


class CheckpointView(Model):
    checkpoint_id: str
    workspace: str
    path: str
    digest: str


class CheckpointList(Model):
    checkpoints: list[CheckpointView]


class CheckpointPreview(Model):
    checkpoint_id: str
    workspace: str
    path: str
    absolute_path: str
    digest: str
    content: str
    current_digest: str
    diff: str


class CheckpointRestore(Model):
    expected_digest: str = Field(default="", max_length=64)


class AutomationCreate(Model):
    automation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    text: str = Field(min_length=1, max_length=4000)
    zone: str = Field(min_length=1, max_length=64)
    local: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
    fold: int | None = None


class AutomationView(Model):
    automation_id: str
    session_id: str
    workspace: str
    text: str
    zone: str
    local: str
    fold: int
    due_ms: int
    phase: Literal["scheduled", "done", "unknown"]
    delivery_id: str = ""


class AutomationTick(Model):
    fired: AutomationView | None = None


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


class WebPolicy(Model):
    enabled: bool = False
    base_url: str = "https://api.deepseek.com/v1/tools"
    count: int = Field(default=10, ge=1, le=50)
    send_original_question: bool = True
    timeout_ms: int = Field(default=30000, ge=1, le=300000)
    max_response_bytes: int = Field(default=2097152, ge=1, le=16777216)
    max_content_chars: int = Field(default=20000, ge=1, le=200000)


class WebCallRequest(Model):
    call_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    kind: Literal["search", "fetch"]
    query: str = ""
    url: str = ""
    count: int | None = Field(default=None, ge=1, le=50)


class WebCallView(Model):
    call_id: str
    session_id: str
    kind: Literal["search", "fetch"]
    phase: Literal["unknown", "done", "failed"]
    error: str = ""
    result: str = ""


class ComputerPolicy(Model):
    enabled: bool = False
    allow_foreground: bool = False
    max_age_ms: int = Field(default=55000, ge=1, le=55000)


class ComputerWindow(Model):
    pid: int = Field(ge=1)
    window_id: int = Field(ge=1)


class ComputerCaptureView(Model):
    capture_id: str
    width: int
    height: int
    raw_width: int
    raw_height: int
    orientation: int
    scale: int
    observed_ms: int
    target: ComputerWindow | None = None
    snapshot_id: str = ""
    tree: str = Field(default="", max_length=20000)
    elements: list[dict[str, JsonValue]] = Field(default_factory=lambda: list[dict[str, JsonValue]](), max_length=500)


class ComputerObserve(Model):
    permitted: bool
    accessibility: bool = False
    screen: bool = False
    identity: str = ""
    error: str = ""
    capture: ComputerCaptureView | None = None
    image_base64: str = Field(default="", max_length=48 * 1024 * 1024)
    data: dict[str, JsonValue] = Field(default_factory=lambda: dict[str, JsonValue]())


class ComputerPixel(Model):
    x: int = Field(ge=0, le=100000)
    y: int = Field(ge=0, le=100000)


class ComputerElement(Model):
    element_token: str = Field(min_length=1, max_length=256)


class ComputerClick(Model):
    action: Literal["click", "double_click", "right_click"]
    point: ComputerPixel | ComputerElement


class ComputerText(ComputerElement):
    action: Literal["type_text", "set_value"]
    text: str = Field(max_length=16000)


class ComputerKey(Model):
    action: Literal["press_key"]
    key: str = Field(min_length=1, max_length=80)


class ComputerHotkey(Model):
    action: Literal["hotkey"]
    keys: list[str] = Field(min_length=2, max_length=8)

    @field_validator("keys")
    @classmethod
    def bounded_keys(cls, value: list[str]) -> list[str]:
        if any(not key or len(key) > 80 for key in value):
            raise ValueError("keys must contain 1 to 80 characters")
        return value


class ComputerScroll(ComputerPixel):
    action: Literal["scroll"]
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(default=3, ge=1, le=100)


class ComputerDrag(ComputerPixel):
    action: Literal["drag"]
    to_x: int = Field(ge=0, le=100000)
    to_y: int = Field(ge=0, le=100000)


ComputerAction = Annotated[ComputerClick | ComputerText | ComputerKey | ComputerHotkey | ComputerScroll | ComputerDrag,
                           Field(discriminator="action")]


class ComputerMutation(Model):
    capture_id: str = Field(min_length=1, max_length=128)
    target: ComputerWindow | None = None
    delivery_mode: Literal["background", "foreground"] = "background"
    action: ComputerAction


class ComputerInspect(Model):
    action: Literal["desktop", "window", "apps", "windows", "permissions"] = "desktop"
    target: ComputerWindow | None = None
    pid: int | None = Field(default=None, ge=1)


class ComputerActionRequest(ComputerMutation):
    action_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")


class ComputerActionView(Model):
    action_id: str
    session_id: str
    phase: Literal["unknown", "done", "failed"]
    error: str = ""
    driver_x: int | None = None
    driver_y: int | None = None


class ComputerCleanup(Model):
    cleared: bool
    proof: str = ""


class HostFence(Model):
    host_epoch: int
    build_id: str


class ComputerToolRequest(HostFence):
    session_id: str
    worker_id: str
    step_id: str
    request_id: str
    generation: int
    call: ToolCall


class ComputerToolResult(Model):
    phase: Literal["unknown", "done", "failed"]
    result: str = ""
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart]())


class OpenTerminal(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    terminal_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)
    cols: int = Field(default=80, ge=1, le=200)
    rows: int = Field(default=24, ge=1, le=80)
    workspace: str = ""


class TerminalInput(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    terminal_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    input_id: str = Field(min_length=1, max_length=64)
    data: str = Field(max_length=4000)


class TerminalResize(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    terminal_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    cols: int = Field(ge=1, le=200)
    rows: int = Field(ge=1, le=80)


class TerminalQuery(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    terminal_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class TerminalSession(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class TerminalOpen(Model):
    terminal_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)
    cols: int = Field(default=80, ge=1, le=200)
    rows: int = Field(default=24, ge=1, le=80)
    workspace: str = ""


class WorkspaceGrantRequest(Model):
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{0,31}$")
    host_path: str = Field(min_length=1, max_length=1024)


class WorkspaceGrantView(Model):
    name: str
    host_path: str
    primary: bool = False


class WorkspaceList(Model):
    workspaces: list[WorkspaceGrantView]


class TerminalType(Model):
    input_id: str = Field(min_length=1, max_length=64)
    data: str = Field(max_length=4000)


class TerminalSize(Model):
    cols: int = Field(ge=1, le=200)
    rows: int = Field(ge=1, le=80)


class McpOpen(Model):
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)
    workspace: str = ""


class OpenMcp(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)
    workspace: str = ""


class McpQuery(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class McpSession(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class McpTool(Model):
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    description: str = ""
    input_schema: dict[str, JsonValue] = Field(default_factory=lambda: {"type": "object"})


class McpView(Model):
    server_id: str
    session_id: str = ""
    workspace: str = "primary"
    command: str = ""
    protocol_version: str = ""
    phase: Literal["ready", "exited", "unknown"]
    exit_code: int | None = None
    tools: list[McpTool]
    clean: bool


class McpCallRequest(Model):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    schema_digest: str = ""
    origin: Literal["manual", "model"] = "manual"

    @field_validator("arguments")
    @classmethod
    def bounded_arguments(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if len(json.dumps(value, ensure_ascii=False).encode()) > 16000:
            raise ValueError("MCP arguments exceed 16000 bytes")
        return value

    @field_validator("schema_digest")
    @classmethod
    def schema_pin(cls, value: str) -> str:
        if value and (len(value) != 64 or any(character not in "0123456789abcdef" for character in value)):
            raise ValueError("MCP schema digest invalid")
        return value


class McpToolCall(Model):
    """Identity captured when the model proposes a call. The provider never chooses these fields."""

    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    tool: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    workspace: str = Field(min_length=1, max_length=64)
    command: str = Field(min_length=1, max_length=16000)
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("arguments")
    @classmethod
    def bounded_arguments(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if len(json.dumps(value, ensure_ascii=False).encode()) > 16000:
            raise ValueError("MCP arguments exceed 16000 bytes")
        return value


class McpCall(Model):
    call_id: str
    server_id: str
    name: str
    phase: Literal["waiting_approval", "running", "done", "denied", "unknown", "conflict"]
    result: str = ""
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    result_data: dict[str, JsonValue] | None = None
    is_error: bool = False
    digest: str
    origin: Literal["manual", "model"] = "manual"


class McpState(Model):
    servers: list[McpView]
    calls: list[McpCall]


class McpDecision(Model):
    decision_id: str = Field(min_length=1, max_length=64)
    approve: bool
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class McpCallEnvelope(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    call: McpCallRequest


class McpDecisionEnvelope(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    decision: McpDecision


class McpCallRef(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class CodeRun(Model):
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=8000)


class OpenCode(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=8000)


class CancelCode(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class CodeView(Model):
    run_id: str
    phase: Literal["success", "failed", "cancelled", "unknown", "conflict"]
    value: str = ""
    state: str = ""


class SshTarget(Model):
    host: str = Field(min_length=1, max_length=200, pattern=r"^[^-\s\x00-\x1f\x7f][^\s\x00-\x1f\x7f]*$")
    user: str = Field(default="", max_length=100)
    port: int | None = Field(default=None, ge=1, le=65535)
    identity_file: str = Field(default="", max_length=1024)
    config_file: str = Field(default="", max_length=1024)


class RemoteKeyScan(SshTarget):
    remote_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class RemoteHostKey(Model):
    line: str
    fingerprint: str


class RemoteHostKeys(Model):
    keys: list[RemoteHostKey]


class RemoteOpen(RemoteKeyScan):
    host_key: str = Field(min_length=16, max_length=2048)
    generation: int = Field(default=1, ge=1, le=1_000_000)


class OpenRemote(RemoteOpen, HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    daemon_id: str = Field(pattern=r"^[a-f0-9]{64}$")


class RemoteView(Model):
    remote_id: str
    host: str
    phase: Literal["connected", "disconnected", "blocked"]
    generation: int


class SubmitRemote(OpenRemote):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class RemoteRun(RemoteOpen):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class RemoteCallRequest(Model):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class RemoteCallView(Model):
    call_id: str
    phase: Literal["unknown", "done", "conflict"]
    result: str = ""


class TerminalView(Model):
    terminal_id: str
    session_id: str = ""
    cols: int
    rows: int
    queued: int
    written: int
    exit_code: int | None = None
    output: str
    output_seq: int = 0
    phase: Literal["running", "exited", "unknown"]
    clean: bool = False
    workspace: str = "primary"
    input_id: str = ""
    input_status: Literal["", "accepted", "unknown"] = ""


class TerminalList(Model):
    terminals: list[TerminalView]


class WorkerSpec(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    purpose: Literal["business", "validation"] = "business"
    frozen: bool = False


class Lease(Model):
    session_id: str
    worker_id: str
    execution_epoch: int
    build_id: str
    supervisor_id: str = ""


class PrepareFileWrite(Lease):
    host_epoch: int
    call_id: str = Field(min_length=1, max_length=128)
    write: WriteFile


class PreparedFileWrite(Model):
    call_id: str
    path: str
    expected_digest: str = Field(pattern=r"^(?:[a-f0-9]{64})?$")
    checkpoint_id: str = ""


class RunTool(Lease, Command):
    call_id: str
    request_id: str = ""
    effect: Literal["read", "write"] = "write"
    file: WriteFile | ReadFile | None = None
    expected_digest: str | None = None


class Cleanup(Model):
    session_id: str
    execution_epoch: int
    state: Literal["clean", "blocked"]
    resources: list[str]
    reason: str = ""
    proof_id: str = ""
    observation: Literal["registered_processes"] = "registered_processes"


class WorkerInfo(Model):
    session_id: str
    worker_id: str
    pid: int
    socket: str
    build_id: str
    process_lease: ProcessLease | None = None
    state: Literal["starting", "ready", "frozen", "stopping", "stopped", "blocked", "unknown"] = "starting"
    execution_epoch: int = 0
    fingerprint: str = ""
    plugin_fingerprint: str = ""
    purpose: Literal["business", "validation"] = "business"
    host_epoch: int = 0
    storage_ready: bool = False


class PluginTool(Model):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
    label: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=4000)
    parameters: dict[str, JsonValue]
    kind: Literal["tool", "command"] = "tool"


    def schema_digest(self) -> str:
        payload = json.dumps(self.parameters, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


class PluginDraft(Model):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    entry: str = Field(min_length=1, max_length=4096)
    config: dict[str, str] = Field(default_factory=dict)


class PluginReload(Model):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    reload_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    entry: str = Field(default="", max_length=4096)
    config: dict[str, str] = Field(default_factory=dict)


class PluginView(Model):
    session_id: str
    plugin_id: str
    name: str
    capabilities: list[str]
    config: dict[str, str]
    fingerprint: str
    entry: str
    tools: list[PluginTool] = Field(default_factory=lambda: list[PluginTool]())
    phase: Literal["loading", "ready", "disconnected", "failed", "unknown"] = "disconnected"
    load_id: str = ""
    error: str = ""


class PluginList(Model):
    plugins: list[PluginView]


class PluginOffer(Model):
    alias: str = Field(pattern=r"^plugin_[a-f0-9]{20}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = Field(min_length=1, max_length=64)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    load_id: str
    name: str
    description: str
    parameters: dict[str, JsonValue]
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")

    @classmethod
    def from_view(cls, view: PluginView, workspace: str) -> list[PluginOffer]:
        if view.phase != "ready":
            return []
        return [cls(alias="plugin_" + hashlib.sha256(f"{view.plugin_id}\n{tool.name}".encode()).hexdigest()[:20],
                    plugin_id=view.plugin_id, session_id=view.session_id, workspace=workspace,
                    fingerprint=view.fingerprint, load_id=view.load_id, name=tool.name, description=tool.description,
                    parameters=tool.parameters, schema_digest=tool.schema_digest())
                for tool in view.tools if tool.kind == "tool"]


class PluginToolCall(Model):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = Field(min_length=1, max_length=64)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    load_id: str
    name: str
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)


class PluginCallRequest(Model):
    kind: Literal["tool", "command"] = "tool"
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)


class OpenPlugin(PluginDraft, HostFence):
    pass


class ReloadPlugin(PluginReload, HostFence):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class PluginCallEnvelope(PluginCallRequest, HostFence):
    origin: Literal["manual", "model"] = "manual"
    worker_id: str = ""
    step_id: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")
    request_id: str = ""
    expected_fingerprint: str = ""
    expected_load_id: str = ""
    expected_schema_digest: str = ""
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = "primary"


    def intent_payload(self) -> str:
        return json.dumps(self.model_dump(mode="json", exclude={"host_epoch", "build_id", "worker_id"}),
                          sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class ClosePlugin(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class CancelPlugin(ClosePlugin):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class PluginResult(Model):
    content: list[dict[str, JsonValue]] = Field(default_factory=lambda: list[dict[str, JsonValue]](), max_length=16)
    details: JsonValue = None
    is_error: bool = False


class PluginCallView(Model):
    call_id: str
    phase: Literal["done", "failed", "unknown", "conflict", "cancelled"]
    cancel_requested: bool = False
    clean: bool = False
    result: PluginResult | None = None
    error: str = ""


class PluginReply(Model):
    phase: Literal["ready", "done", "failed"]
    call_id: str = ""
    tools: list[PluginTool] = Field(default_factory=lambda: list[PluginTool](), max_length=64)
    result: PluginResult | None = None
    error: str = ""


class WorkerRequest(Model):
    session_id: str
    worker_id: str
    build_id: str
    storage_ready: bool = False


class StopWorker(WorkerSpec):
    worker_id: str
    execution_epoch: int = 0
    reason: Literal["shutdown", "recovery", "update"] = "shutdown"


class Stream(Model):
    snapshot: Snapshot | None = None
    batches: list[CommitBatch] = Field(default_factory=lambda: list[CommitBatch]())
    stream_id: str = ""
    binding_id: str = ""
    build_id: str = ""
    resync: str = ""


class ErrorBody(Model):
    code: str
    message: str
    request_id: str = ""
    retryable: bool = False


class ProcessLease(Model):
    instance_id: str
    role: Literal["host", "worker", "supervisor", "execution"]
    profile_path: str
    path: str
    device: int
    inode: int


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


class EffectHold(Model):
    call_id: str
    session_id: str
    request_id: str = ""
    reason: str
    resource_clean: bool
    reconciled: bool = False


class EffectResolution(Model):
    resolution_id: str = Field(min_length=1, max_length=128)
    call_id: str
    outcome: Literal["applied", "not_applied"]
    evidence: str = Field(min_length=1, max_length=4000)


class ResolveEffect(WorkerRequest):
    resolution: EffectResolution


class ToolLookup(WorkerRequest):
    call_id: str


class ToolObservation(Model):
    call_id: str
    state: Literal["not_found", "pending", "completed", "unknown"]
    result: ToolResult | None = None
    resource_clean: bool = False


class CommitBatch(Model):
    stream_id: str
    seq: str
    base_revision: str
    revision: str
    events: list[Event]


class Replay(Model):
    stream_id: str
    seq: str
    batches: list[CommitBatch]
    resync: bool = False


class StreamHello(Model):
    kind: Literal["hello"] = "hello"
    binding_id: str = Field(min_length=1, max_length=128)
    stream_id: str = ""
    after: str = Field(default="0", pattern=r"^(0|[1-9][0-9]{0,17})$")
    build_id: str


class StreamAck(Model):
    kind: Literal["ack"] = "ack"
    binding_id: str
    stream_id: str
    seq: str = Field(pattern=r"^(0|[1-9][0-9]{0,17})$")


class Submission(HostFence):
    value: Submit


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


class FreezeSupervisor(HostFence):
    freeze_id: str
    expected_revision: str = ""


class RetireSupervisor(HostFence):
    freeze_id: str


class EpochHealth(Model):
    session_id: str
    worker_id: str
    execution_epoch: int
    state: str
    cleanup: Cleanup | None = None


class ExecutionResource(Model):
    call_id: str
    session_id: str
    request_id: str
    state: Literal["registered", "running", "stopping", "exited", "stop_unconfirmed"]
    outcome: Literal["pending", "completed", "unknown"]
    observation: Literal["registered_processes"] = "registered_processes"


class SupervisorHealth(Model):
    mcp_servers: list[McpView] = Field(default_factory=lambda: list[McpView]())
    terminals: list[TerminalView] = Field(default_factory=lambda: list[TerminalView]())
    identity: Identity
    registry_revision: str
    freeze_id: str = ""
    workers: list[WorkerInfo]
    epochs: list[EpochHealth]
    effects: list[EffectHold] = Field(default_factory=lambda: list[EffectHold]())
    execution: Literal["native"] = "native"
    resources: list[ExecutionResource] = Field(default_factory=lambda: list[ExecutionResource]())
    session_errors: dict[str, list[str]] = Field(default_factory=lambda: dict[str, list[str]]())
    blocked: list[str] = Field(default_factory=lambda: list[str]())


class Recovery(HostFence):
    recovery_id: str = Field(min_length=1, max_length=128)
    session_id: str = ""


class PrepareUpdate(Model):
    update_id: str = Field(min_length=1, max_length=128)
    target_build: str = Field(pattern=r"^[a-f0-9]{64}$")
    cancel_work: bool = False


class UpdateRecord(Model):
    update_id: str
    source_build: str
    target_build: str
    phase: Literal["freezing", "retiring", "prepared", "validating", "completed"]
    revision: str
    cancel_work: bool
    error: str = ""
    roster: list[WorkerInfo] = Field(default_factory=lambda: list[WorkerInfo]())
    validation: WorkerInfo | None = None
    activated: bool = False


class CompleteUpdate(Model):
    update_id: str
    expected_revision: str


class Health(Model):
    identity: Identity
    state: Literal["ready", "recovering", "frozen", "blocked"]
    supervisor: SupervisorHealth | None = None
    update: UpdateRecord | None = None
    pending_deliveries: int = 0
    errors: list[str] = Field(default_factory=lambda: list[str]())
    supervisors: list[ServiceInfo] = Field(default_factory=lambda: list[ServiceInfo]())


class ServiceInfo(Model):
    instance_id: str
    build_id: str
    process_lease: ProcessLease
    state: Literal["starting", "running", "stopping", "stopped", "unknown"]
    pid: int = 0


class Attachment(Model):
    attachment_id: str
    session_id: str
    host_epoch: int
    build_id: str


class BackendError(Exception):
    def __init__(self, code: str, message: str = "", status: int = 409):
        self.code, self.message, self.status = code, message or code, status
        super().__init__(self.message)
