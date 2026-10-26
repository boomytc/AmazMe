from __future__ import annotations

import re
from enum import StrEnum
from pathlib import Path

from amazme_backend.shared.errors import BackendError


class SessionRuntimeFile(StrEnum):
    WRITER_LOCK = "writer.lock"
    WORKER_LOG = "worker.log"



_SESSION_ID = re.compile(r"^[a-f0-9]{32}$")

def session_database(profile: Path, session: str) -> Path:
    if _SESSION_ID.fullmatch(session) is None:
        raise BackendError("invalid_session")
    return profile / "sessions" / session / "session.sqlite"
