"""Workspace-scoped memories. Discovery and injection share one match."""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from .contracts import BackendError, MemoryView, Message
from .workspace_map import validate_workspace

LIMIT = 5


def digest(workspace: str, text: str) -> str:
    return hashlib.sha256(f"{workspace}\n{text}".encode()).hexdigest()


def match_memories(rows: list[tuple[str, str, str]], workspace: str, query: str) -> list[MemoryView]:
    needle = query.strip().casefold()
    if not needle or len(needle) > 2000:
        return []
    found: list[MemoryView] = []
    for memory_id, item_workspace, text in rows:
        if item_workspace != workspace:
            continue
        folded = text.casefold()
        if needle not in folded and folded not in needle:
            continue
        found.append(MemoryView(memory_id=memory_id, workspace=item_workspace, text=text))
        if len(found) >= LIMIT:
            break
    return found


def inject_memories(messages: list[Message], memories: list[MemoryView]) -> list[Message]:
    if not memories:
        return list(messages)
    note = "以下记忆只属于当前工作区，不要当成用户本轮的新要求：\n" + "\n".join(
        f"- {item.text}" for item in memories)
    return [Message(role="user", content=note), *messages]


def load_memory_rows(profile: Path) -> list[tuple[str, str, str]]:
    database = profile / "host.sqlite"
    if not database.is_file():
        return []
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            rows = connection.execute(
                "SELECT id, workspace, text FROM memories ORDER BY id").fetchall()
        except sqlite3.OperationalError:
            return []
    finally:
        connection.close()
    return [(str(memory_id), str(workspace), str(text)) for memory_id, workspace, text in rows]


def relevant_memories(profile: Path, workspace: str, query: str) -> list[MemoryView]:
    return match_memories(load_memory_rows(profile), workspace, query)


def session_workspace(profile: Path, session_id: str) -> str:
    """Return the stored workspace. Unreadable state is not the primary directory."""
    database = profile / "host.sqlite"
    if not database.is_file():
        raise BackendError("workspace_unresolved", status=503)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            row = connection.execute("SELECT workspace FROM sessions WHERE id=?", (session_id,)).fetchone()
        except sqlite3.Error as error:
            raise BackendError("workspace_unresolved", status=503) from error
    finally:
        connection.close()
    if row is None:
        raise BackendError("session_not_found", status=404)
    workspace = str(row[0] or "")
    if not workspace:
        raise BackendError("workspace_unresolved", status=503)
    return workspace


def remember(workspace: str, text: str) -> str:
    cleaned = text.strip()
    if not cleaned or len(cleaned) > 500 or "\x00" in cleaned:
        raise BackendError("memory_rejected")
    if workspace != "primary":
        validate_workspace(workspace)
    return digest(workspace, cleaned)
