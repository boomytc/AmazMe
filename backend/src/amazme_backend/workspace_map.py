"""Logical workspace identifiers resolve to real local directories; not an OS sandbox."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .contracts import BackendError

PRIMARY = "primary"
_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")


def validate_workspace(name: str) -> str:
    if name != PRIMARY and (name == "grant" or _NAME.fullmatch(name) is None):
        raise BackendError("invalid_workspace_name")
    return name


def split_client_path(relative: str) -> tuple[str, str]:
    text = relative.strip("/")
    if text in {"", "."}:
        return PRIMARY, ""
    path = Path(text)
    parts = [part for part in path.parts if part != "."]
    if path.is_absolute() or not parts or ".." in parts:
        raise BackendError("invalid_workspace_path")
    if parts[0] != "grant":
        return PRIMARY, text
    if len(parts) == 1:
        return "grant", ""
    validate_workspace(parts[1])
    return parts[1], "/".join(parts[2:])


def tool_path(session_workspace: str, relative: str) -> tuple[str, str]:
    """A tool path without an explicit grant uses the session workspace."""
    name, inner = split_client_path(relative)
    if name == PRIMARY:
        return validate_workspace(session_workspace), inner
    return name, inner


def client_path(name: str, inner: str) -> str:
    if name == PRIMARY:
        return inner
    suffix = "/" + inner if inner else ""
    return "grant/" + name + suffix


def check_grant_directory(path: Path, profile: Path, primary: Path) -> Path:
    if not path.is_absolute() or path.is_symlink():
        raise BackendError("workspace_grant_forbidden" if not path.is_symlink() else "workspace_symlink")
    if not path.is_dir():
        raise BackendError("workspace_not_directory")
    resolved = path.resolve()
    home = Path.home().resolve()
    blocked = (home, home / ".ssh", home / "Library" / "Keychains", profile.resolve(), primary.resolve())
    if resolved in blocked or _inside(resolved, home / ".ssh") or _inside(resolved, home / "Library" / "Keychains"):
        raise BackendError("workspace_grant_forbidden")
    if _inside(resolved, profile.resolve()):
        raise BackendError("workspace_grant_forbidden")
    if "docker.sock" in resolved.parts:
        raise BackendError("workspace_grant_forbidden")
    return resolved


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return path != root


def load_grants(profile: Path) -> list[tuple[str, str]]:
    database = profile / "host.sqlite"
    if not database.is_file():
        return []
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            rows = connection.execute("SELECT name, host_path FROM workspace_grants ORDER BY name").fetchall()
        except sqlite3.OperationalError:
            return []
    finally:
        connection.close()
    return [(str(name), str(host)) for name, host in rows]


def grant_names(profile: Path) -> list[str]:
    return [name for name, _host in load_grants(profile)]
