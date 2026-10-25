"""Session-owned checkpoints and driver actions; no execution or database handles escape."""
import json
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Literal

from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from .contracts import (
    BackendError,
    Cleanup,
    CodeStatus,
    ImagePart,
    ComputerGround,
    ComputerInspect,
    ComputerLocate,
    ComputerMutation,
    ComputerToolResult,
    DelegateTasks,
    EffectHold,
    EffectResolution,
    ImagePart,
    Lease,
    McpToolCall,
    Message,
    Model,
    PluginCallView,
    PluginOffer,
    PluginToolCall,
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
from .tool_search import ToolSearchInput
from .web_tools import validate_fetch_url


class CodemodeInput(Model):
    code: str = Field(min_length=1, max_length=8000)


def normalized_call(call: ToolCall) -> ToolCall:
    if call.name == "shell":
        value: Shell | ReadFile | DelegateTasks | WebSearch | WebFetch | McpToolCall | PluginToolCall | ComputerInspect | ComputerMutation | ComputerLocate | ComputerGround = Shell.model_validate_json(call.arguments)
    elif call.name == "read_file":
        value = ReadFile.model_validate_json(call.arguments)
    elif call.name == "tool_search":
        search = ToolSearchInput.model_validate_json(call.arguments)
        if not search.query.strip():
            raise BackendError("tool_search_query")
        return call.model_copy(update={"arguments": search.model_copy(update={"query": search.query.strip()}).model_dump_json()})
    elif call.name == "codemode":
        return call.model_copy(update={"arguments": CodemodeInput.model_validate_json(call.arguments).model_dump_json()})
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
    elif call.name == "plugin_tool":
        value = PluginToolCall.model_validate_json(call.arguments)
    elif call.name == "mcp_tool":
        value = McpToolCall.model_validate_json(call.arguments)
    elif call.name == "computer_observe":
        value = ComputerInspect.model_validate_json(call.arguments)
    elif call.name == "computer_act":
        value = ComputerMutation.model_validate_json(call.arguments)
    elif call.name == "computer_locate":
        value = ComputerLocate.model_validate_json(call.arguments)
    elif call.name == "computer_ground":
        value = ComputerGround.model_validate_json(call.arguments)
    else:
        raise BackendError("not_an_execution_tool")
    if isinstance(value, ReadFile):
        path = PurePosixPath(value.path)
        if path.is_absolute() or ".." in path.parts:
            raise BackendError("invalid_workspace_path")
    return call.model_copy(update={"arguments": value.model_dump_json()})


def resolve_model_call(catalog_json: str, call: ToolCall, call_id: str, plugin_catalog_json: str = "") -> ToolCall:
    """Rewrite a provider alias using the catalog saved before that model call. Live catalogs are ignored."""
    if call.name.startswith("plugin_"):
        if call.name == "plugin_tool" or not plugin_catalog_json:
            raise BackendError("plugin_tool_unknown")
        try:
            plugins = TypeAdapter(list[PluginOffer]).validate_json(plugin_catalog_json)
            plugin = next((item for item in plugins if item.alias == call.name), None)
            if plugin is None:
                raise BackendError("plugin_tool_unknown")
            arguments = TypeAdapter(dict[str, JsonValue]).validate_json(call.arguments or "{}")
        except (json.JSONDecodeError, ValidationError):
            raise BackendError("plugin_catalog_conflict") from None
        payload = PluginToolCall(plugin_id=plugin.plugin_id, call_id=call_id, workspace=plugin.workspace,
            fingerprint=plugin.fingerprint, load_id=plugin.load_id, name=plugin.name,
            schema_digest=plugin.schema_digest, arguments=arguments)
        return normalized_call(ToolCall(id=call.id, name="plugin_tool", arguments=payload.model_dump_json()))
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
    step_id: str
    request_id: str
    ordinal: int
    kind: Literal["model", "tool"]
    phase: Literal["proposed", "intent", "result", "applied", "unknown", "children", "code"]
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
class ComputerRetrieval:
    step_id: str
    request_id: str
    generation: int
    call: ToolCall


@dataclass(frozen=True)
class PluginRetrieval:
    step_id: str
    request_id: str
    generation: int
    call: ToolCall
    stop: bool = False


type Action = (
    Continue | Park | ModelInvocation | OpenEpoch | ToolInvocation | QueryTool | CloseEpoch | ReconcileEffect
    | WebRetrieval | McpRetrieval | ComputerRetrieval | PluginRetrieval | CodeRetrieval
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
    images: list[ImagePart] = field(default_factory=list)


@dataclass(frozen=True)
class ComputerReturned:
    invocation: ComputerRetrieval
    result: ComputerToolResult


@dataclass(frozen=True)
class PluginReturned:
    invocation: PluginRetrieval
    view: PluginCallView
    text: str = ""
    images: list[ImagePart] = field(default_factory=lambda: list[ImagePart]())


type Observation = (
    ModelReturned | ToolReturned | ToolObserved | EpochOpened | EpochClosed | EffectResolved | Failed | Previewed
    | WebReturned | McpReturned | ComputerReturned | PluginReturned | CodeReturned
)
