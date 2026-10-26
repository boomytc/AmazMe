import sqlite3

from amazme_backend.contracts.sessions import Session


def session_sql(tail: str) -> str:
    return (
        "SELECT s.id AS id,s.title AS title,s.parent_id AS parent_id,s.fork_request_id AS fork_request_id,s.archived AS archived,s.workspace AS workspace,s.updated_ms AS updated_ms,s.branch_ready AS branch_ready,coalesce(p.project,'') AS project_id FROM sessions s LEFT JOIN project_sessions p ON p.session=s.id "
        + tail
    )


def session_row(row: sqlite3.Row) -> Session:
    keys = set(row.keys())
    project_id = str(row["project_id"]) if "project_id" in keys else ""
    return Session(
        session_id=str(row["id"]),
        title=str(row["title"]),
        parent_id=str(row["parent_id"]),
        fork_request_id=str(row["fork_request_id"]),
        archived=bool(row["archived"]),
        workspace=str(row["workspace"] or "primary"),
        project_id=project_id,
        updated_ms=int(row["updated_ms"]),
        prepared=bool(row["branch_ready"]),
    )
