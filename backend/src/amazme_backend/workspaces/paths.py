from __future__ import annotations

from pathlib import Path

from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.grants import PRIMARY, validate_workspace

"Logical workspace identifiers resolve to real local directories; not an OS sandbox."


def split_client_path(relative: str) -> tuple[str, str]:
    text = relative.strip("/")
    if text in {"", "."}:
        return (PRIMARY, "")
    path = Path(text)
    parts = [part for part in path.parts if part != "."]
    if path.is_absolute() or not parts or ".." in parts:
        raise BackendError("invalid_workspace_path")
    if parts[0] != "grant":
        return (PRIMARY, text)
    if len(parts) == 1:
        return ("grant", "")
    validate_workspace(parts[1])
    return (parts[1], "/".join(parts[2:]))


def tool_path(session_workspace: str, relative: str) -> tuple[str, str]:
    """A tool path without an explicit grant uses the session workspace."""
    name, inner = split_client_path(relative)
    if name == PRIMARY:
        return (validate_workspace(session_workspace), inner)
    return (name, inner)


def client_path(name: str, inner: str) -> str:
    if name == PRIMARY:
        return inner
    suffix = "/" + inner if inner else ""
    return "grant/" + name + suffix
