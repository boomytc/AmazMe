from __future__ import annotations

import sqlite3
from pathlib import Path

from amazme_backend.shared.errors import BackendError


def load_memory_rows(profile: Path) -> list[tuple[str, str, str]]:
    database = profile / "host.sqlite"
    if not database.is_file():
        return []
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            rows = connection.execute("SELECT id, workspace, text FROM memories ORDER BY id").fetchall()
        except sqlite3.OperationalError:
            return []
    finally:
        connection.close()
    return [(str(memory_id), str(workspace), str(text)) for memory_id, workspace, text in rows]


def session_workspace(profile: Path, session_id: str, *, active: bool = False) -> str:
    """Return the stored workspace. Unreadable state is not the primary directory."""
    database = profile / "host.sqlite"
    if not database.is_file():
        raise BackendError("workspace_unresolved", status=503)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            columns = "workspace, archived" if active else "workspace, 0"
            row = connection.execute(f"SELECT {columns} FROM sessions WHERE id=?", (session_id,)).fetchone()
        except sqlite3.Error as error:
            raise BackendError("workspace_unresolved", status=503) from error
    finally:
        connection.close()
    if row is None:
        raise BackendError("session_not_found", status=404)
    if active and bool(row[1]):
        raise BackendError("session_archived")
    workspace = str(row[0] or "")
    if not workspace:
        raise BackendError("workspace_unresolved", status=503)
    return workspace


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


def branch_pending(profile: Path, session: str) -> bool:
    database = profile / "host.sqlite"
    if not database.is_file():
        raise BackendError("workspace_unresolved", status=503)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            row = connection.execute(
                "SELECT parent_id,fork_request_id,branch_ready,archived FROM sessions WHERE id=?", (session,)
            ).fetchone()
        except sqlite3.Error as error:
            raise BackendError("workspace_unresolved", status=503) from error
    finally:
        connection.close()
    return row is not None and bool(row[0]) and bool(row[1]) and not row[2] and not row[3]


def session_removed(profile: Path, session: str) -> bool:
    database = profile / "host.sqlite"
    if not database.is_file():
        raise BackendError("workspace_unresolved", status=503)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            row = connection.execute(
                "SELECT completed FROM session_removals WHERE session=?", (session,)
            ).fetchone()
        except sqlite3.Error as error:
            raise BackendError("workspace_unresolved", status=503) from error
    finally:
        connection.close()
    return row is not None and bool(row[0])
