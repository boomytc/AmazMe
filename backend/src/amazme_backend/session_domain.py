"""Session-owned checkpoints and driver actions; no execution or database handles escape."""
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

from pydantic import Field

from .contracts import (
    BackendError,
    Cleanup,
    DelegateTasks,
    EffectHold,
    EffectResolution,
    Lease,
    Message,
    Model,
    Preview,
    ProviderConfig,
    ReadFile,
    Shell,
    ToolCall,
    ToolObservation,
    ToolResult,
    WriteFile,
)
from .providers import Completion


def normalized_call(call: ToolCall) -> ToolCall:
    if call.name == "shell":
        value = Shell.model_validate_json(call.arguments)
    elif call.name == "read_file":
        value = ReadFile.model_validate_json(call.arguments)
    elif call.name == "write_file":
        value = WriteFile.model_validate_json(call.arguments)
    else:
        value = DelegateTasks.model_validate_json(call.arguments)
        if any(not task or len(task) > 16000 for task in value.tasks):
            raise BackendError("invalid_child_input")
    if isinstance(value, ReadFile):
        path = PurePosixPath(value.path)
        if path.is_absolute() or ".." in path.parts:
            raise BackendError("invalid_workspace_path")
    return call.model_copy(update={"arguments": value.model_dump_json()})


class Run(Model):
    request_id: str
    depth: int = 0
    config: ProviderConfig
    lease: Lease | None = None
    opening: bool = False
    cleanup_required: bool = False
    cleanup: Cleanup | None = None


class Step(Model):
    step_id: str
    request_id: str
    ordinal: int
    kind: Literal["model", "tool"]
    phase: Literal["proposed", "intent", "result", "applied", "unknown", "children"]
    generation: int
    call: ToolCall | None = None
    result: str = ""
    approval_id: str = ""
    proposal_digest: str = ""
    children: list[str] = Field(default_factory=list)
    query_after_cleanup: bool = False


@dataclass(frozen=True)
class Continue:
    pass


@dataclass(frozen=True)
class Park:
    reason: str
    next_wake_ms: int = 0


@dataclass(frozen=True)
class ModelInvocation:
    step_id: str
    request_id: str
    generation: int
    messages: list[Message]
    config: ProviderConfig


@dataclass(frozen=True)
class OpenEpoch:
    request_id: str


@dataclass(frozen=True)
class ToolInvocation:
    step_id: str
    request_id: str
    generation: int
    lease: Lease
    call: ToolCall


@dataclass(frozen=True)
class QueryTool:
    step_id: str
    request_id: str
    generation: int


@dataclass(frozen=True)
class CloseEpoch:
    request_id: str
    lease: Lease


@dataclass(frozen=True)
class ReconcileEffect:
    request_id: str
    resolution: EffectResolution


type Action = Continue | Park | ModelInvocation | OpenEpoch | ToolInvocation | QueryTool | CloseEpoch | ReconcileEffect


@dataclass(frozen=True)
class ModelReturned:
    invocation: ModelInvocation
    completion: Completion


@dataclass(frozen=True)
class ToolReturned:
    invocation: ToolInvocation
    result: ToolResult


@dataclass(frozen=True)
class ToolObserved:
    query: QueryTool
    observation: ToolObservation


@dataclass(frozen=True)
class EpochOpened:
    request_id: str
    lease: Lease


@dataclass(frozen=True)
class EpochClosed:
    request_id: str
    lease: Lease
    cleanup: Cleanup


@dataclass(frozen=True)
class EffectResolved:
    resolution: EffectResolution
    hold: EffectHold


@dataclass(frozen=True)
class Failed:
    action: Action
    error: str


@dataclass(frozen=True)
class Previewed:
    invocation: ModelInvocation
    preview: Preview


type Observation = ModelReturned | ToolReturned | ToolObserved | EpochOpened | EpochClosed | EffectResolved | Failed | Previewed
