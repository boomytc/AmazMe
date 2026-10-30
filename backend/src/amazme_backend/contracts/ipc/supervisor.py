from __future__ import annotations

import json
from typing import Literal

from pydantic import Field, model_validator

from amazme_backend.contracts.code import CodeView
from amazme_backend.contracts.execution import (
    Command,
    EditFile,
    EffectResolution,
    JobOutput,
    JobQuery,
    Lease,
    OutputRead,
    PreparedPatch,
    ReadFile,
    WriteFile,
)
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.mcp import McpCallRequest, McpDecision, McpLaunch
from amazme_backend.contracts.plugins import PluginCallRequest, PluginDraft, PluginReload
from amazme_backend.contracts.remote import RemoteOpen
from amazme_backend.shared.model import Model


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


class OpenMcp(McpLaunch, HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class McpQuery(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class McpSession(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")


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


class OpenCode(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=8000)
    worker_id: str = ""
    parent_request_id: str = ""
    parent_step_id: str = ""
    allowed_tools: list[str] | None = None
    excluded_tools: list[str] = Field(default_factory=lambda: list[str]())
    state_scope: str = ""
    initial_state: str | None = Field(default=None, max_length=1_000_000)


class CancelCode(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class CodeStatus(Model):
    view: CodeView
    running: bool


class OpenRemote(RemoteOpen, HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    daemon_id: str = Field(pattern=r"^[a-f0-9]{64}$")


class SubmitRemote(OpenRemote):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    command: str = Field(min_length=1, max_length=16000)


class WorkerSpec(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    purpose: Literal["business", "validation"] = "business"
    frozen: bool = False


class RunTool(Lease, Command):
    call_id: str
    request_id: str = ""
    effect: Literal["read", "write"] = "write"
    file: WriteFile | EditFile | ReadFile | None = None
    expected_digest: str | None = None
    expected_root: str = ""
    output_read: OutputRead | None = None
    patch: PreparedPatch | None = None

    @model_validator(mode="after")
    def patch_identity(self) -> RunTool:
        if self.patch is not None and (self.patch.call_id != self.call_id or self.command != "apply_patch"
                                       or self.file is not None or self.output_read is not None
                                       or self.run_in_background or self.effect != "write"):
            raise ValueError("a patch requires its own synchronous write invocation")
        return self


class JobSession(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class JobReference(JobSession, JobQuery):
    pass


class JobOutputQuery(JobSession, JobOutput):
    pass


class OpenPlugin(PluginDraft, HostFence):
    pass


class ReloadPlugin(PluginReload, HostFence):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class PluginCallEnvelope(PluginCallRequest, HostFence):
    origin: Literal["manual", "model"] = "manual"
    worker_id: str = ""
    step_id: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")
    request_id: str = ""
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


class WorkerRequest(Model):
    session_id: str
    worker_id: str
    build_id: str
    storage_ready: bool = False


class StopWorker(WorkerSpec):
    worker_id: str
    execution_epoch: int = 0
    reason: Literal["shutdown", "recovery", "update"] = "shutdown"
    require_idle: bool = False


class ResolveEffect(WorkerRequest):
    resolution: EffectResolution


class ToolLookup(WorkerRequest):
    call_id: str


class TaskActivity(Model):
    active: bool
    tasks: int = 0


class FreezeSupervisor(HostFence):
    freeze_id: str
    expected_revision: str = ""


class RetireSupervisor(HostFence):
    freeze_id: str


class Recovery(HostFence):
    recovery_id: str = Field(min_length=1, max_length=128)
    session_id: str = ""
