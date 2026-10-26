"""Test-only access to the writer and context already owned by a session service."""

from amazme_backend.sessions.persistence.database import Database
from amazme_backend.sessions.persistence.state import SessionContext
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.store import SessionTransactions


def session_database_owner(service: SessionStore) -> Database:
    owner: object = getattr(service, "_store")
    if not isinstance(owner, SessionTransactions):
        raise TypeError("Expected the session service's existing transaction owner")
    return owner.database


def session_state(service: SessionStore) -> SessionContext:
    owner: object = getattr(service, "_store")
    if not isinstance(owner, SessionTransactions):
        raise TypeError("Expected the session service's existing transaction owner")
    return owner.state
