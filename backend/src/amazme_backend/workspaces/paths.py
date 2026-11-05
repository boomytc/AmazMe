from __future__ import annotations

import re
from pathlib import PurePosixPath

from amazme_backend.shared.errors import BackendError

"Logical workspace identifiers resolve to real local directories; not an OS sandbox."


PRIMARY = "primary"
_NAME = re.compile("[a-z][a-z0-9-]{0,31}")


def validate_workspace(name: str) -> str:
    if name != PRIMARY and (name == "grant" or _NAME.fullmatch(name) is None):
        raise BackendError("invalid_workspace_name")
    return name


def split_client_path(relative: str) -> tuple[str, str]:
    text = relative.strip("/")
    if text in {"", "."}:
        return (PRIMARY, "")
    path = PurePosixPath(text)
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
