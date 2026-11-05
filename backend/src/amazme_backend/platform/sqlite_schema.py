"""Read-only schema checks derived from the same DDL used for fresh stores."""
import sqlite3
from functools import cache

from amazme_backend.shared.errors import BackendError

type Columns = frozenset[tuple[str, str, int, str | None, int, int]]
type Schema = tuple[dict[str, Columns], frozenset[tuple[str, str, str]]]


def _shape(db: sqlite3.Connection) -> Schema:
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    columns = {
        str(table[0]): frozenset(
            (str(row[1]), str(row[2]), int(row[3]), str(row[4]) if row[4] is not None else None,
             int(row[5]), int(row[6]))
            for row in db.execute('PRAGMA table_xinfo("' + str(table[0]).replace('"', '""') + '")')
        )
        for table in tables
    }
    indexes = frozenset(
        (str(row[0]), str(row[1]), " ".join(str(row[2]).split()))
        for row in db.execute("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    )
    return columns, indexes


@cache
def _expected(schema: str) -> Schema:
    reference = sqlite3.connect(":memory:")
    try:
        reference.executescript(schema)
        return _shape(reference)
    finally:
        reference.close()


def require_schema(db: sqlite3.Connection, schema: str) -> None:
    if _shape(db) != _expected(schema):
        raise BackendError("unsupported_storage_schema", status=503)
