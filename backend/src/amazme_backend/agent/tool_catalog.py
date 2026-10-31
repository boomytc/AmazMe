"""AmazMe tool exposure and caller-owned provider naming policy."""
from collections.abc import Sequence

from pydantic import JsonValue

from amazme_backend.ai.types import Auth, ModelSpec, ToolDefinition
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
from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.plugins import PluginOffer
from amazme_backend.contracts.questions import AskUser
from amazme_backend.contracts.sessions import DelegateTasks, RunOptions
from amazme_backend.contracts.tools import ToolSearchInput
from amazme_backend.contracts.web import WebFetch, WebSearch
from amazme_backend.shared.model import Model


def _object_schema(schema: dict[str, JsonValue]) -> dict[str, JsonValue]:
    if schema.get("type") is None:
        return {"type": "object", **schema}
    return schema


_BUILTINS: tuple[tuple[str, str, type[Model]], ...] = (
    ("shell", "Execute a command with local user permissions in the selected project. timeout_seconds is the execution deadline (default 30s, foreground maximum 120s). run_in_background returns a durable job receipt and permits explicit deadlines up to 86400s; set the deadline for long commands. Accepted is not finished. Jobs survive reply completion, turn cancellation and client disconnect; explicit job_kill, session closure or host shutdown stop them. At most four live jobs per session, sixteen per profile and eight starts per user input including automatic followups. Never retry unknown side effects.", Shell),
    ("job_list", "List this session's background jobs, active first, at most 64 recent records. State and resource_clean report actual settlement, including unknown/cleanup_pending.", JobListInput),
    ("job_output", "Read a retained background output page. Byte cursors are per stream, repeatable and never consumed by completion notices. Optional wait_seconds (0..30) waits for settlement; user input interrupts waiting without stopping the job. The command keeps its execution deadline. Inspect wait_reason, state and output retention errors.", JobOutputWait),
    ("job_kill", "Idempotently request cancellation of a job in this session and check real exit. Accepted cancellation is not proof of exit; retry cleanup_pending. Unknown effects are never replayed.", JobQuery),
    ("read_file", "Read a UTF-8 workspace file page, with a whole-file digest and zero-based byte offset. Use next_offset to continue; at most 32000 bytes per page and 16 MiB per file. Read before overwriting or editing. A missing file is an explicit absence observation.", ReadFile),
    ("glob", "Discover workspace files by a glob pattern, including hidden and ignored files except VCS metadata. A basename pattern matches any depth; ** spans directories. Literal directory prefixes narrow traversal. Results show at most 100 newest visited matches and explicit limits. Does not follow symlinks or count as reading file contents.", FileGlob),
    ("grep", "Search UTF-8 workspace files with a Python regular expression, optionally one positive include glob and ignore_case. Empty include is unrestricted. Respects nested .gitignore rules and skips hidden files, VCS metadata, symlinks and binary files. Returns paths, 1-based lines and bounded previews; inspect truncated, skipped_files and reason before claiming completeness. Narrow the search when limited; use read_file for full contents and a write baseline.", FileGrep),
    ("git_diff", "Review local Git changes without modifying the repository. scope selects all uncommitted changes versus HEAD (including untracked files), unstaged changes versus the index (including untracked files), or staged changes versus HEAD. path selects a checkout inside a granted workspace. Returns file statuses and a bounded unified diff; inspect truncated and reason. Does not fetch, stage, commit, execute repository helpers, or establish file write baselines. Use read_file before editing.", GitDiff),
    ("write_file", "Create a UTF-8 workspace file without overwriting a concurrent creation, or replace a file at the version you previously read. Existing unread or externally modified files are refused; read again on conflict.", WriteFile),
    ("edit_file", "Replace an exact literal string in a previously read UTF-8 file (up to 1 MiB). The default requires exactly one match; replace_all explicitly replaces every match. Preserves literal line endings. Refuses stale observations, missing files, zero matches and ambiguous matches.", EditFile),
    ("apply_patch", "Apply a Codex-style *** Begin Patch / *** End Patch through the input string. Supports Add File, Update File with @@ hunks and optional Move to, and Delete File, up to 16 file operations and 32000 input characters. Read existing sources and existing destinations first. The complete patch is checked before any file mutation; syntax, stale reads, or unmatched hunks reject all writes. Updates normalize CRLF to LF. Execution stops at the first failure and reports completed, failed and skipped mutations without rollback. Never retry an unknown result; re-read affected files. Prepared file content is bounded; split oversized patches.", ApplyPatch),
    ("tool_output", "Read a retained shell output stream using its locator and byte offset. stdout/stderr have separate cursors; use next_offset for the next page. Reads are repeatable. Logs retain a bounded prefix for seven days; inspect archive errors and retained_bytes before claiming complete output.", OutputRead),
    ("ask_user_question", "Ask up to three concise questions when a choice or required information blocks progress. Provide stable ids, optional choices, and multi_select for independent options. Mark recommended options explicitly. Wait for the actual human answer; defaults are never consent. Free text is always available. A skipped question is answered: do not ask it again; continue with a stated assumption when possible or explain what remains required. Human answers are not tool approvals.", AskUser),
    ("delegate_task", "Delegate up to eight required independent tasks. Wait for their results before completing.", DelegateTasks),
    ("web_search", "Search through the saved web policy. It stays off until the user enables that policy, uses an authenticated provider endpoint, and an unknown result must not be retried.", WebSearch),
    ("web_fetch", "Fetch one http(s) page through the saved web policy. It stays off until the user enables that policy, uses an authenticated provider endpoint, and an unknown result must not be retried.", WebFetch),
)


def build_tools(offers: Sequence[McpOffer] | None = None, options: RunOptions | None = None,
                plugins: Sequence[PluginOffer] | None = None, *, codemode: bool = True) -> list[ToolDefinition]:
    tools = [ToolDefinition(name=name, description=description, parameters=schema.model_json_schema())
             for name, description, schema in _BUILTINS]
    for offer in offers or ():
        if offer.exposure != "direct" and not offer.active:
            continue
        description = (f"MCP tool {offer.name} on service {offer.server_id} in workspace {offer.workspace}. "
                       f"{offer.description} Do not retry an unknown result.")
        tools.append(ToolDefinition(name=offer.alias, description=description[:1000],
                                    parameters=_object_schema(offer.input_schema)))
    for plugin in plugins or ():
        description = (f"Plugin tool {plugin.name} in workspace {plugin.workspace}. "
                       f"{plugin.description} Do not retry an unknown result.")
        tools.append(ToolDefinition(name=plugin.alias, description=description[:4000], parameters=plugin.parameters))
    if any(offer.exposure in {"codemode", "deferred"} and not offer.active for offer in offers or ()):
        tools.append(ToolDefinition(name="tool_search",
            description="Search deferred tool metadata with BM25 and load matching tools for the next model call. For MCP tool discovery, use tool_search.",
            parameters=ToolSearchInput.model_json_schema()))
    if codemode and (any(offer.exposure == "codemode" for offer in offers or ())
                     or options is not None and options.allowed_tools is not None and options.tool_allowed("codemode")):
        tools.append(ToolDefinition(name="codemode",
            description="Run JavaScript that calls other tools through tools.name(arguments). Discover names and descriptions in ALL_TOOLS; each description includes the JSON parameter schema. Use text(), image(), store() and load(). Nested calls use the session's approvals and cancellation. An unknown result must not be replayed.",
            parameters={"type": "object", "properties": {"code": {"type": "string", "minLength": 1, "maxLength": 8000}},
                        "required": ["code"], "additionalProperties": False}))
    return tools if options is None else [tool for tool in tools if options.tool_allowed(tool.name)]


_ANTHROPIC_NAMES = {"shell": "Bash", "read_file": "Read", "glob": "Glob", "grep": "Grep", "write_file": "Write", "delegate_task": "Task",
                    "web_search": "WebSearch", "web_fetch": "WebFetch"}


def wire_names(model: ModelSpec, auth: Auth) -> dict[str, str]:
    if model.api == "anthropic-messages" and model.provider == "anthropic" and (
        auth.auth_type == "oauth" or auth.api_key.get_secret_value().startswith("sk-ant-oat")
    ):
        return dict(_ANTHROPIC_NAMES)
    return {}
