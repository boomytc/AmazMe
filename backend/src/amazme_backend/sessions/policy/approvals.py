"""Decide which normalized tool intents need a human before execution."""
import re
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from amazme_backend.contracts.execution import (
    ApplyPatch,
    EditFile,
    ReadFile,
    Shell,
    WriteFile,
    readonly_command_argv,
)
from amazme_backend.contracts.models import ToolCall
from amazme_backend.contracts.sessions import ApprovalPolicy, Receipt
from amazme_backend.contracts.web import WebFetch, WebSearch
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.patch_syntax import parse_patch
from amazme_backend.workspaces.paths import tool_path


def _sensitive(path: str) -> bool:
    parts = [part.casefold() for part in PurePosixPath(path).parts]
    return any(part in {".git", ".ssh", ".gnupg", ".aws", ".codex", ".amazme", ".agents", ".github",
                        ".profile", ".bashrc", ".bash_profile", ".zshenv", ".zprofile", ".zshrc",
                        ".npmrc", ".netrc", ".gitconfig", ".gitmodules", ".gitattributes", "id_rsa", "id_ed25519"}
               or part == ".env" or part.startswith(".env.") or part.endswith((".pem", ".p12", ".key"))
               for part in parts)


def _mentioned(target: str, user_text: str) -> bool:
    # Match a whole target rather than a prefix of another URL or search term.
    boundary = r"""[^\s`'"“”‘’()<>,;，。；：（）]"""
    return re.search(rf"(?<!{boundary}){re.escape(target)}(?!{boundary})", user_text) is not None


def _review_write(path: str, workspace: str) -> bool:
    try:
        name, relative = tool_path(workspace, path)
    except BackendError:
        return True
    return name != workspace or _sensitive(relative)


def needs_approval(policy: ApprovalPolicy, call: ToolCall, workspace: str, request: Receipt) -> bool:
    if policy == "auto":
        return False
    if call.name in {"glob", "grep", "git_diff", "tool_output", "job_list", "job_output", "delegate_task"}:
        return False
    if call.name == "read_file":
        return _sensitive(ReadFile.model_validate_json(call.arguments).path)
    if call.name in {"write_file", "edit_file"}:
        change = (WriteFile if call.name == "write_file" else EditFile).model_validate_json(call.arguments)
        return _review_write(change.path, workspace)
    if call.name == "apply_patch":
        try:
            operations = parse_patch(ApplyPatch.model_validate_json(call.arguments).input)
            return any(op.kind == "delete" or _review_write(op.path, workspace)
                       or (op.destination is not None and _review_write(op.destination, workspace)) for op in operations)
        except BackendError:
            return True
    if call.name == "shell":
        shell = Shell.model_validate_json(call.arguments)
        return shell.run_in_background or readonly_command_argv(shell.command) is None
    if call.name in {"web_search", "web_fetch"}:
        if policy == "all" or request.kind != "root" or request.input_origin != "user":
            return True
        # Only auto-release literal user-supplied material to the configured web service.
        if call.name == "web_search":
            query = WebSearch.model_validate_json(call.arguments).query
            return not _mentioned(query, request.text)
        url = WebFetch.model_validate_json(call.arguments).url
        target = urlsplit(url)
        host = target.hostname or ""
        return (not _mentioned(url, request.text) or target.scheme != "https"
                or target.netloc.lower() not in {host, host + ":443"} or bool(target.query or target.fragment)
                or "." not in host or not host.rsplit(".", 1)[1].isalpha()
                or host.endswith((".local", ".localhost", ".internal", ".test", ".lan", ".home")))
    # MCP, plugins, job termination and new tools have no bounded read/write contract here.
    return True
