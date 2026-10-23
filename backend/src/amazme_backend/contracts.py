from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProviderConfig(Model):
    provider: Literal["deepseek", "faux"]
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-flash"
    api_key: SecretStr = SecretStr("")
    max_tokens: int = Field(default=2048, ge=32, le=8192)
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)


class CatalogModel(Model):
    provider: Literal["deepseek", "faux"]
    model: str
    label: str
    endpoint_editable: bool


class ModelSettings(Model):
    provider: Literal["deepseek", "faux"]
    model: str
    base_url: str
    max_tokens: int
    key_configured: bool
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)


class ModelCatalog(Model):
    models: list[CatalogModel]
    current: ModelSettings


class UpdateModelSettings(Model):
    provider: Literal["deepseek", "faux"]
    model: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    base_url: str = Field(default="", max_length=300)
    max_tokens: int = Field(default=2048, ge=32, le=8192)
    proxy: str = Field(default="", max_length=300)
    headers: dict[str, str] = Field(default_factory=dict)


class ProfileConfig(Model):
    format: Literal[2] = 2
    profile_id: str
    workspace: str
    resources: str
    provider: ProviderConfig
    approval_policy: Literal["auto", "mutations", "all"] = "mutations"
    testing: bool = False


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


class Submit(Model):
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    text: str = Field(min_length=1, max_length=16000)
    mode: Literal["queue", "steer", "reject_busy"] = "queue"
    target_run_id: str = ""
    not_before_ms: int = Field(default=0, ge=0, le=253402300799000)


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


class ToolCall(Model):
    id: str
    name: Literal["shell", "read_file", "write_file", "delegate_task", "web_search", "web_fetch"]
    arguments: str


class Message(Model):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=lambda: list[ToolCall]())
    tool_call_id: str = ""
    provider_response_id: str = ""
    # Opaque provider replay data. Ordinary usage and logs do not include this text.
    reasoning_signature: str = ""


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
    container_id: str = ""


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
    guest_path: str
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
    max_age_ms: int = Field(default=55000, ge=1, le=55000)


class ComputerCaptureView(Model):
    capture_id: str
    width: int
    height: int
    raw_width: int
    raw_height: int
    orientation: int
    scale: int
    observed_ms: int


class ComputerObserve(Model):
    permitted: bool
    accessibility: bool = False
    screen: bool = False
    identity: str = ""
    error: str = ""
    capture: ComputerCaptureView | None = None


class ComputerActionRequest(Model):
    action_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    capture_id: str = Field(min_length=1, max_length=128)
    x: int = Field(ge=0, le=100000)
    y: int = Field(ge=0, le=100000)


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
    guest_path: str
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


class OpenMcp(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class McpTool(Model):
    name: str
    description: str = ""


class McpView(Model):
    server_id: str
    phase: Literal["ready", "exited", "unknown"]
    exit_code: int | None = None
    tools: list[McpTool]
    clean: bool


class McpCallRequest(Model):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=64)
    arguments: dict[str, str] = Field(default_factory=dict)


class McpCall(Model):
    call_id: str
    server_id: str
    name: str
    phase: Literal["waiting_approval", "done", "denied", "unknown", "conflict"]
    result: str = ""
    digest: str


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


class RemoteOpen(Model):
    remote_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    host: str = Field(min_length=1, max_length=200)
    host_key: str = Field(min_length=16, max_length=128)
    generation: int = Field(default=1, ge=1, le=1_000_000)
    endpoint: str = Field(pattern=r"^127\.0\.0\.1:[0-9]{1,5}$")


class OpenRemote(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    remote_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    host: str = Field(min_length=1, max_length=200)
    host_key: str = Field(min_length=16, max_length=128)
    daemon_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    generation: int = Field(ge=1, le=1_000_000)
    endpoint: str = Field(pattern=r"^127\.0\.0\.1:[0-9]{1,5}$")


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
    cols: int
    rows: int
    queued: int
    written: int
    exit_code: int | None = None
    output: str
    phase: Literal["running", "exited", "unknown"]


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


class RunTool(Lease, Command):
    call_id: str
    request_id: str = ""
    effect: Literal["read", "write"] = "write"


class Cleanup(Model):
    session_id: str
    execution_epoch: int
    state: Literal["clean", "blocked"]
    containers: list[str]
    reason: str = ""
    proof_id: str = ""
    vm_id: str = ""


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


class PluginDraft(Model):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    config: dict[str, str] = Field(default_factory=dict)


class PluginReload(Model):
    config: dict[str, str] = Field(default_factory=dict)


class PluginView(Model):
    plugin_id: str
    name: str
    capabilities: list[str]
    config: dict[str, str]
    fingerprint: str
    entry: str


class PluginList(Model):
    plugins: list[PluginView]


class PluginCallRequest(Model):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    text: str = Field(min_length=1, max_length=200)


class OpenPlugin(HostFence):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    config: dict[str, str] = Field(default_factory=dict)


class ReloadPlugin(HostFence):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    config: dict[str, str] = Field(default_factory=dict)


class PluginCallEnvelope(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    text: str = Field(min_length=1, max_length=200)


class PluginCallView(Model):
    call_id: str
    phase: Literal["done", "failed", "unknown", "conflict"]
    result: str = ""


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
    role: Literal["host", "worker", "supervisor"]
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


class SupervisorHealth(Model):
    identity: Identity
    registry_revision: str
    freeze_id: str = ""
    workers: list[WorkerInfo]
    epochs: list[EpochHealth]
    effects: list[EffectHold] = Field(default_factory=lambda: list[EffectHold]())
    vm_id: str
    boot_id: str
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
