"""Session-owned run records, durable actions and observations."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import Field

from amazme_backend.ai.types import Completion as ModelCompletion
from amazme_backend.contracts.execution import (
    Cleanup,
    EffectHold,
    EffectResolution,
    Lease,
    ToolObservation,
    ToolResult,
)
from amazme_backend.contracts.ipc.supervisor import CodeStatus
from amazme_backend.contracts.models import ImagePart, Message, ToolCall
from amazme_backend.contracts.plugins import PluginCallView
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import Preview
from amazme_backend.shared.model import Model

Completion = ModelCompletion[Message]


class CodemodeInput(Model):
    code: str = Field(min_length=1, max_length=8000)


class Run(Model):
    input_origin: Literal["user", "job"] = "user"
    background_anchor: str = ""
    started_at_ms: int | None = None
    loaded_mcp_tools: list[str] = Field(default_factory=lambda: list[str]())
    codemode_state: str = "{}"
    input_text: str | None = None
    direct_call: ToolCall | None = None
    request_id: str
    depth: int = 0
    config: ProviderConfig
    lease: Lease | None = None
    opening: bool = False
    cleanup_required: bool = False
    cleanup: Cleanup | None = None


class Step(Model):
    background_anchor: str = ""
    step_id: str
    request_id: str
    ordinal: int
    kind: Literal["model", "tool"]
    phase: Literal["proposed", "question", "intent", "result", "applied", "unknown", "children", "code"]
    generation: int
    call: ToolCall | None = None
    result: str = ""
    mcp_catalog: str = ""
    plugin_catalog: str = ""
    search_catalog: str = ""
    code_poll_ms: int = 0
    code_input_state: str = ""
    code_state: str = ""
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
    started_at_ms: int | None = None


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
class CodeRetrieval:
    step_id: str
    request_id: str
    generation: int
    call: ToolCall
    config: ProviderConfig
    state_scope: str = ""
    initial_state: str | None = None
    start: bool = False
    stop: bool = False


@dataclass(frozen=True)
class CodeReturned:
    invocation: CodeRetrieval
    status: CodeStatus


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


@dataclass(frozen=True)
class WebRetrieval:
    """A paid web call owned by the session worker. It never opens an execution epoch."""

    step_id: str
    request_id: str
    generation: int
    call: ToolCall


@dataclass(frozen=True)
class McpRetrieval:
    """One model-proposed MCP call. stop cancels that call and leaves every service process running."""

    step_id: str
    request_id: str
    generation: int
    call: ToolCall
    stop: bool = False


@dataclass(frozen=True)
class PluginRetrieval:
    step_id: str
    request_id: str
    generation: int
    call: ToolCall
    stop: bool = False


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


@dataclass(frozen=True)
class WebReturned:
    invocation: WebRetrieval
    phase: Literal["unknown", "done", "failed", "refused"]
    error: str = ""
    result: str = ""


@dataclass(frozen=True)
class McpReturned:
    invocation: McpRetrieval
    phase: Literal["done", "denied", "unknown", "conflict", "cancelled"]
    error: str = ""
    result: str = ""
    images: list[ImagePart] = field(default_factory=lambda: list[ImagePart]())


@dataclass(frozen=True)
class PluginReturned:
    invocation: PluginRetrieval
    view: PluginCallView
    text: str = ""
    images: list[ImagePart] = field(default_factory=lambda: list[ImagePart]())


type Action = (
    Continue | Park | ModelInvocation | OpenEpoch | ToolInvocation | QueryTool | CloseEpoch | ReconcileEffect
    | WebRetrieval | McpRetrieval | PluginRetrieval | CodeRetrieval
)

type Observation = (
    ModelReturned | ToolReturned | ToolObserved | EpochOpened | EpochClosed | EffectResolved | Failed | Previewed
    | WebReturned | McpReturned | PluginReturned | CodeReturned
)
