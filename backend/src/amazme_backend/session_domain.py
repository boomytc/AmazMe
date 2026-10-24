"""Session-owned checkpoints and driver actions; no execution or database handles escape."""
import json
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from .contracts import (
    BackendError,
    Cleanup,
    DelegateTasks,
    EffectHold,
    EffectResolution,
    Lease,
    McpToolCall,
    Message,
    Model,
    Preview,
    ProviderConfig,
    ReadFile,
    Shell,
    ToolCall,
    ToolObservation,
    ToolResult,
    WebFetch,
    WebSearch,
    WriteFile,
)
from .mcp_session import McpOffer
from .providers import Completion
from .web_tools import validate_fetch_url


def normalized_call(call: ToolCall) -> ToolCall:
    if call.name == "shell":
        value: Shell | ReadFile | DelegateTasks | WebSearch | WebFetch | McpToolCall = Shell.model_validate_json(call.arguments)
    elif call.name == "read_file":
        value = ReadFile.model_validate_json(call.arguments)
    elif call.name == "write_file":
        value = WriteFile.model_validate_json(call.arguments)
    elif call.name == "delegate_task":
        value = DelegateTasks.model_validate_json(call.arguments)
        if any(not task or len(task) > 16000 for task in value.tasks):
            raise BackendError("invalid_child_input")
    elif call.name == "web_search":
        parsed = WebSearch.model_validate_json(call.arguments)
        query = parsed.query.strip()
        if not query or len(list(query)) > 128:
            raise BackendError("web_query")
        value = parsed.model_copy(update={"query": query})
    elif call.name == "web_fetch":
        parsed_fetch = WebFetch.model_validate_json(call.arguments)
        value = parsed_fetch.model_copy(update={"url": validate_fetch_url(parsed_fetch.url)})
    elif call.name == "mcp_tool":
        value = McpToolCall.model_validate_json(call.arguments)
    else:
        raise BackendError("not_an_execution_tool")
    if isinstance(value, ReadFile):
        path = PurePosixPath(value.path)
        if path.is_absolute() or ".." in path.parts:
            raise BackendError("invalid_workspace_path")
    return call.model_copy(update={"arguments": value.model_dump_json()})


def resolve_model_call(catalog_json: str, call: ToolCall, call_id: str) -> ToolCall:
    """Rewrite a provider alias using the catalog saved before that model call. Live catalogs are ignored."""
    if call.name == "mcp_tool" or (call.name.startswith("mcp_") and not catalog_json):
        raise BackendError("mcp_tool_unknown")
    if not call.name.startswith("mcp_"):
        return normalized_call(call)
    try:
        offers = TypeAdapter(list[McpOffer]).validate_json(catalog_json)
    except (json.JSONDecodeError, ValidationError):
        raise BackendError("mcp_catalog_conflict") from None
    offer = next((item for item in offers if item.alias == call.name), None)
    if offer is None:
        raise BackendError("mcp_tool_unknown")
    try:
        arguments = TypeAdapter(dict[str, JsonValue]).validate_json(call.arguments or "{}")
    except (json.JSONDecodeError, ValidationError):
        raise BackendError("invalid_tool_arguments") from None
    payload = McpToolCall(server_id=offer.server_id, tool=offer.name, workspace=offer.workspace,
                          command=offer.command, schema_digest=offer.schema_digest, call_id=call_id,
                          arguments=arguments)
    return normalized_call(ToolCall(id=call.id, name="mcp_tool", arguments=payload.model_dump_json()))


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
    mcp_catalog: str = ""
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


type Action = (
    Continue | Park | ModelInvocation | OpenEpoch | ToolInvocation | QueryTool | CloseEpoch | ReconcileEffect
    | WebRetrieval | McpRetrieval
)


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


type Observation = (
    ModelReturned | ToolReturned | ToolObserved | EpochOpened | EpochClosed | EffectResolved | Failed | Previewed
    | WebReturned | McpReturned
)
