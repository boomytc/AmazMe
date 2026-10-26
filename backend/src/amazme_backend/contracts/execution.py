from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from amazme_backend.contracts.identity import Identity
from amazme_backend.contracts.mcp import McpView
from amazme_backend.contracts.workspaces import EditFile as EditFile
from amazme_backend.shared.model import Model


class Command(Model):
    command: str = Field(min_length=1, max_length=196608)
    timeout_seconds: int = Field(default=30, ge=1, le=86400)
    run_in_background: bool = False

    @model_validator(mode="after")
    def deadline_policy(self) -> Command:
        if not self.run_in_background and self.timeout_seconds > 120:
            raise ValueError("foreground execution timeout is at most 120 seconds; use explicit background execution")
        return self


class Shell(Command):
    command: str = Field(min_length=1, max_length=16000)


class FileTarget(Model):
    path: str = Field(min_length=1, max_length=1024)


class ReadFile(FileTarget):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=16000, ge=4, le=32000)


class WriteFile(FileTarget):
    content: str = Field(max_length=32000)


class FilePresent(Model):
    kind: Literal["present"] = "present"
    path: str
    root: str
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class FileAbsent(Model):
    kind: Literal["absent"] = "absent"
    path: str
    root: str


FileObservation = Annotated[FilePresent | FileAbsent, Field(discriminator="kind")]


class OutputRead(Model):
    locator: str = Field(min_length=1, max_length=128, pattern=r"^[\w.:-]+$")
    stream: Literal["stdout", "stderr"] = "stdout"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=16000, ge=4, le=32000)


class StreamRetention(Model):
    observed_bytes: int = 0
    retained_bytes: int = 0
    error: str = ""


class OutputArchive(Model):
    locator: str
    expires_at: int
    stdout: StreamRetention
    stderr: StreamRetention
    settled: bool = False


class OutputPage(Model):
    archive: OutputArchive
    stream: Literal["stdout", "stderr"]
    offset: int
    next_offset: int
    content: str
    has_more: bool


class ToolResult(Model):
    call_id: str
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool = False
    stop_reason: str = ""
    output: OutputArchive | None = None
    file_observation: FileObservation | None = None


JobId = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")]


class JobQuery(Model):
    job_id: JobId


class JobOutput(JobQuery):
    stream: Literal["stdout", "stderr"] = "stdout"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=16000, ge=4, le=32000)

    def read_request(self) -> OutputRead:
        return OutputRead(locator=self.job_id, stream=self.stream, offset=self.offset, limit=self.limit)


class JobOutputWait(JobOutput):
    wait_seconds: float = Field(default=0, ge=0, le=30)


class JobListInput(Model):
    pass


JobState = Literal["starting", "running", "stopping", "succeeded", "failed", "cancelled", "unknown", "cleanup_pending"]


class JobView(Model):
    job_id: JobId
    session_id: str
    request_id: str
    state: JobState
    outcome: Literal["pending", "completed", "unknown"]
    resource_clean: bool
    cancel_requested: bool
    started_at_ms: int
    finished_at_ms: int
    exit_code: int | None = None
    stop_reason: str = ""
    output: OutputArchive | None = None


class JobList(Model):
    jobs: list[JobView]
    truncated: bool = False


class JobOutputView(Model):
    job: JobView
    output: OutputPage | None = None
    error: str = ""
    wait_reason: Literal["", "completed", "deadline", "user_input"] = ""


class TerminalOpen(Model):
    terminal_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)
    cols: int = Field(default=80, ge=1, le=200)
    rows: int = Field(default=24, ge=1, le=80)
    workspace: str = ""


class TerminalType(Model):
    input_id: str = Field(min_length=1, max_length=64)
    data: str = Field(max_length=4000)


class TerminalSize(Model):
    cols: int = Field(ge=1, le=200)
    rows: int = Field(ge=1, le=80)


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


class Lease(Model):
    session_id: str
    worker_id: str
    execution_epoch: int
    build_id: str
    supervisor_id: str = ""


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


class ProcessLease(Model):
    instance_id: str
    role: Literal["host", "worker", "supervisor", "execution"]
    profile_path: str
    path: str
    device: int
    inode: int


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


class ToolObservation(Model):
    call_id: str
    state: Literal["not_found", "pending", "completed", "unknown"]
    result: ToolResult | None = None
    resource_clean: bool = False


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


class ServiceInfo(Model):
    instance_id: str
    build_id: str
    process_lease: ProcessLease
    state: Literal["starting", "running", "stopping", "stopped", "unknown"]
    pid: int = 0
