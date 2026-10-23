"""Workspace-scoped memories. Discovery and injection share one match."""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from .contracts import BackendError, MemoryView, Message
from .workspace_map import guest_path

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
    database = profile / "host.sqlite"
    if not database.is_file():
        return "primary"
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            row = connection.execute("SELECT workspace FROM sessions WHERE id=?", (session_id,)).fetchone()
        except sqlite3.OperationalError:
            return "primary"
    finally:
        connection.close()
    if row is None or not row[0]:
        return "primary"
    return str(row[0])


def remember(workspace: str, text: str) -> str:
    cleaned = text.strip()
    if not cleaned or len(cleaned) > 500 or "\x00" in cleaned:
        raise BackendError("memory_rejected")
    if workspace != "primary":
        guest_path(workspace)
    return digest(workspace, cleaned)
