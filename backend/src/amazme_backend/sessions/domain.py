"""Pure normalization and binding decisions for session tool intents."""
import json
from pathlib import PurePosixPath

from pydantic import JsonValue, TypeAdapter, ValidationError

from amazme_backend.contracts.execution import (
    ApplyPatch,
    EditFile,
    FileGlob,
    FileGrep,
    GitDiff,
    JobListInput,
    JobOutputWait,
    JobQuery,
    OutputRead,
    ReadFile,
    Shell,
    WriteFile,
)
from amazme_backend.contracts.mcp import McpOffer, McpToolCall
from amazme_backend.contracts.models import ToolCall
from amazme_backend.contracts.plugins import PluginOffer, PluginToolCall
from amazme_backend.contracts.questions import AskUser
from amazme_backend.contracts.sessions import DelegateTasks
from amazme_backend.contracts.tools import ToolSearchInput
from amazme_backend.contracts.web import WebFetch, WebSearch, validate_fetch_url
from amazme_backend.sessions.types import CodemodeInput
from amazme_backend.shared.errors import BackendError


def normalized_call(call: ToolCall) -> ToolCall:
    if call.name == "shell":
        value: Shell | ReadFile | FileGlob | FileGrep | GitDiff | WriteFile | EditFile | ApplyPatch | OutputRead | JobListInput | JobOutputWait | JobQuery | DelegateTasks | AskUser | WebSearch | WebFetch | McpToolCall | PluginToolCall = Shell.model_validate_json(call.arguments)
    elif call.name == "job_list":
        value = JobListInput.model_validate_json(call.arguments)
    elif call.name == "job_output":
        value = JobOutputWait.model_validate_json(call.arguments)
    elif call.name == "job_kill":
        value = JobQuery.model_validate_json(call.arguments)
    elif call.name == "read_file":
        value = ReadFile.model_validate_json(call.arguments)
    elif call.name == "glob":
        value = FileGlob.model_validate_json(call.arguments)
    elif call.name == "grep":
        value = FileGrep.model_validate_json(call.arguments)
    elif call.name == "git_diff":
        value = GitDiff.model_validate_json(call.arguments)
    elif call.name == "tool_output":
        value = OutputRead.model_validate_json(call.arguments)
    elif call.name == "tool_search":
        search = ToolSearchInput.model_validate_json(call.arguments)
        if not search.query.strip():
            raise BackendError("tool_search_query")
        return call.model_copy(update={"arguments": search.model_copy(update={"query": search.query.strip()}).model_dump_json()})
    elif call.name == "codemode":
        return call.model_copy(update={"arguments": CodemodeInput.model_validate_json(call.arguments).model_dump_json()})
    elif call.name == "write_file":
        value = WriteFile.model_validate_json(call.arguments)
    elif call.name == "edit_file":
        value = EditFile.model_validate_json(call.arguments)
    elif call.name == "apply_patch":
        value = ApplyPatch.model_validate_json(call.arguments)
    elif call.name == "ask_user_question":
        value = AskUser.model_validate_json(call.arguments)
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
    else:
        raise BackendError("not_an_execution_tool")
    if isinstance(value, (ReadFile, FileGlob, FileGrep, GitDiff, WriteFile, EditFile)):
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
