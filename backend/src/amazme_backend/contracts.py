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


class ProfileConfig(Model):
    format: Literal[1] = 1
    profile_id: str
    workspace: str
    resources: str
    provider: ProviderConfig


class Identity(Model):
    version: str = "0.1.0"
    protocol: str = "amazme-http/1"
    build_id: str
    profile_id: str
    instance_id: str
    pid: int
    host_epoch: int = 0


class Submit(Model):
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    text: str = Field(min_length=1, max_length=16000)


Status = Literal["queued", "running", "cancelling", "succeeded", "cancelled", "interrupted", "failed", "unknown"]


class Receipt(Model):
    request_id: str
    text: str
    status: Status
    answer: str = ""
    error: str = ""
    accepted_revision: str = "0"


class ToolCall(Model):
    id: str
    name: Literal["shell", "read_file", "write_file"]
    arguments: str


class Message(Model):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=lambda: list[ToolCall]())
    tool_call_id: str = ""
    provider_response_id: str = ""


class Command(Model):
    command: str = Field(min_length=1, max_length=196608)
    timeout_seconds: int = Field(default=30, ge=1, le=120)


class Shell(Command):
    command: str = Field(min_length=1, max_length=16000)


class ReadFile(Model):
    path: str = Field(min_length=1, max_length=1024)


class WriteFile(ReadFile):
    content: str = Field(max_length=32000)


class ToolResult(Model):
    call_id: str
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool = False
    container_id: str = ""


class Event(Model):
    seq: str
    kind: Literal["accepted", "status", "preview", "message", "tool", "cleanup"]
    request_id: str
    text: str


WorkerState = Literal["recovering", "ready", "blocked", "stopping"]


class Snapshot(Model):
    session_id: str
    stream_id: str
    seq: str
    state: WorkerState
    requests: list[Receipt]
    events: list[Event]


class Session(Model):
    session_id: str
    title: str


class SessionList(Model):
    sessions: list[Session]


class EventList(Model):
    events: list[Event]


class CreateSession(Model):
    title: str = Field(default="新会话", min_length=1, max_length=100)


class HostFence(Model):
    host_epoch: int
    build_id: str


class WorkerSpec(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class Lease(Model):
    session_id: str
    worker_id: str
    execution_epoch: int
    build_id: str


class RunTool(Lease, Command):
    call_id: str


class Cleanup(Model):
    session_id: str
    execution_epoch: int
    state: Literal["clean", "blocked"]
    containers: list[str]
    reason: str = ""


class WorkerInfo(Model):
    session_id: str
    worker_id: str
    pid: int
    socket: str
    build_id: str


class WorkerRequest(Model):
    session_id: str
    worker_id: str
    build_id: str


class StopWorker(WorkerSpec):
    worker_id: str


class Stream(Model):
    snapshot: Snapshot | None = None
    events: list[Event] = Field(default_factory=lambda: list[Event]())


class ErrorBody(Model):
    code: str
    message: str


class BackendError(Exception):
    def __init__(self, code: str, message: str = "", status: int = 409):
        self.code, self.message, self.status = code, message or code, status
        super().__init__(self.message)
