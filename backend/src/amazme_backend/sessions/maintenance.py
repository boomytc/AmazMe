"""Read settled history and remove only an already-settled session directory."""
import sqlite3
from pathlib import Path

from amazme_backend.contracts.models import Message
from amazme_backend.contracts.sessions import (
    Receipt,
)
from amazme_backend.contracts.web import WebPolicy
from amazme_backend.profiles.layout import SessionRuntimeFile
from amazme_backend.sessions.persistence.records import codemode_state_at, loaded_mcp_keys
from amazme_backend.sessions.types import (
    Run,
)
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model

_SESSION_FILES = frozenset({
    "session.sqlite", "session.sqlite-wal", "session.sqlite-shm", "session.lock", *SessionRuntimeFile,
})


def remove_session_directory(directory: Path) -> None:
    if not directory.exists():
        return
    if directory.is_symlink() or directory.parent.is_symlink() or not directory.is_dir():
        raise BackendError("branch_cleanup_refused")
    names = {item.name for item in directory.iterdir()}
    if not names <= _SESSION_FILES:
        raise BackendError("branch_cleanup_refused")
    for name in sorted(names):
        (directory / name).unlink()
    directory.rmdir()


def read_settled_root(path: Path, request_id: str) -> tuple[str, Receipt, list[tuple[str, str]], str]:
    """Read one settled root turn. The caller copies it; this connection never writes."""
    if not path.is_file():
        raise BackendError("branch_point_missing", status=404)
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        try:
            row = connection.execute("SELECT digest, payload FROM requests WHERE id=?", (request_id,)).fetchone()
        except sqlite3.Error as exc:
            raise BackendError("branch_point_missing", status=404) from exc
        if row is None:
            raise BackendError("branch_point_missing", status=404)
        try:
            receipt = Receipt.model_validate_json(row[1])
            messages = [
                (str(key), str(payload)) for key, payload in connection.execute(
                    "SELECT message_key, payload FROM messages WHERE request_id=? ORDER BY ordinal", (request_id,))
            ]
            run_row = connection.execute("SELECT payload FROM runs WHERE request_id=?", (request_id,)).fetchone()
            run = Run.model_validate_json(run_row[0]) if run_row else None
            for _, payload in messages:
                Message.model_validate_json(payload)
        except (ValueError, sqlite3.Error) as exc:
            raise BackendError("storage_corrupt", status=503) from exc
        if receipt.kind != "root" or receipt.request_id != request_id:
            raise BackendError("branch_point_not_root")
        settled = (receipt.status == "succeeded" and receipt.decision is not None
                   and receipt.decision.status == "succeeded" and messages and run is not None
                   and run.request_id == request_id and run.lease is None
                   and not run.opening and not run.cleanup_required)
        if not settled:
            raise BackendError("branch_point_unsettled")
        assert run is not None
        run.loaded_mcp_tools = loaded_mcp_keys(connection, request_id)
        run.codemode_state = codemode_state_at(connection, request_id)
        return str(row[0]), receipt, messages, run.model_dump_json()
    finally:
        connection.close()


def read_session_policies(path: Path) -> WebPolicy:
    """Read the parent's switches. Call history stays on the parent."""
    if not path.is_file():
        raise BackendError("branch_point_missing", status=404)
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        return _optional_policy(connection, "SELECT payload FROM web_policies WHERE id='policy'", WebPolicy)
    finally:
        connection.close()


def _optional_policy[T: Model](connection: sqlite3.Connection, query: str, model: type[T]) -> T:
    try:
        row = connection.execute(query).fetchone()
    except sqlite3.OperationalError:
        return model()
    if row is None:
        return model()
    try:
        return model.model_validate_json(row[0])
    except ValueError as exc:
        raise BackendError("storage_corrupt", status=503) from exc
