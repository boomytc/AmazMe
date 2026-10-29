"""Private session schema and preflight; no database is opened here."""
import secrets
import sqlite3

from amazme_backend.contracts.events import CommitBatch
from amazme_backend.contracts.execution import EffectHold, EffectResolution
from amazme_backend.contracts.models import Message
from amazme_backend.contracts.sessions import (
    Approval,
    Preview,
    Receipt,
)
from amazme_backend.sessions.types import (
    Run,
    Step,
)
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


def preflight(db: sqlite3.Connection) -> None:
    # Validate the existing schema before enabling WAL or running any DDL.
    columns = {
        "metadata": "key,value", "requests": "ordinal,id,digest,payload,status,parent_id,kind",
        "runs": "request_id,payload", "messages": "request_id,ordinal,message_key,payload",
        "steps": "id,request_id,ordinal,payload", "approvals": "id,request_id,payload",
        "decisions": "id,digest,request_id", "cancellations": "id,payload", "effects": "id,payload",
        "resolutions": "id,digest,request_id,payload,result", "previews": "request_id,payload",
        "batches": "seq,payload,bytes",
    }
    for table, names in columns.items():
        db.execute(f"SELECT {names} FROM {table} LIMIT 0")
    required = {"stream_id", "revision", "host_epoch", "freeze_id", "stopping", "blocked",
                "driver_id", "execution_epoch"}
    if not required <= {str(r[0]) for r in db.execute("SELECT key FROM metadata")}:
        raise BackendError("storage_incomplete", status=503)
    models: tuple[tuple[str, type[Model]], ...] = (
        ("requests", Receipt), ("runs", Run), ("messages", Message), ("steps", Step),
        ("approvals", Approval), ("cancellations", Receipt), ("effects", EffectHold),
        ("resolutions", EffectResolution), ("previews", Preview), ("batches", CommitBatch),
    )
    try:
        for table, model in models:
            for row in db.execute(f"SELECT payload FROM {table}"):
                model.model_validate_json(row[0])
        for row in db.execute("SELECT value FROM metadata WHERE key IN ('revision','host_epoch','execution_epoch')"):
            if int(row[0]) < 0:
                raise ValueError("negative metadata counter")
    except ValueError as exc:
        raise BackendError("storage_corrupt", status=503) from exc
    if db.execute("PRAGMA foreign_key_check").fetchone():
        raise BackendError("storage_corrupt", status=503)

def initialize(db: sqlite3.Connection) -> None:
    db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests(
                  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  status TEXT GENERATED ALWAYS AS(json_extract(payload,'$.status')) VIRTUAL,
                  parent_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.parent_id')) VIRTUAL,
                  kind TEXT GENERATED ALWAYS AS(json_extract(payload,'$.kind')) VIRTUAL);
                CREATE INDEX IF NOT EXISTS requests_status ON requests(status,ordinal);
                CREATE INDEX IF NOT EXISTS requests_parent ON requests(parent_id);
                CREATE TABLE IF NOT EXISTS runs(request_id TEXT PRIMARY KEY REFERENCES requests(id),
                  payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS messages(request_id TEXT NOT NULL REFERENCES requests(id),
                  ordinal INTEGER NOT NULL,message_key TEXT NOT NULL,payload TEXT NOT NULL,
                  PRIMARY KEY(request_id,message_key),UNIQUE(request_id,ordinal));
                CREATE TABLE IF NOT EXISTS steps(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),
                  ordinal INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(request_id,ordinal));
                CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),
                  payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,digest TEXT NOT NULL,request_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS cancellations(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,digest TEXT NOT NULL,
                  request_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
                CREATE UNIQUE INDEX IF NOT EXISTS resolutions_call ON resolutions(json_extract(payload,'$.call_id'));
                CREATE TABLE IF NOT EXISTS previews(request_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS compactions(id TEXT PRIMARY KEY,basis TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS compaction_claims(
                  id TEXT PRIMARY KEY,through_request_id TEXT NOT NULL,basis TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS workflows(
                  id TEXT PRIMARY KEY,digest TEXT NOT NULL,parent_id TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS workflows_parent ON workflows(parent_id);
                CREATE TABLE IF NOT EXISTS workflow_verdicts(
                  workflow_id TEXT NOT NULL,verdict_id TEXT NOT NULL,digest TEXT NOT NULL,passed INTEGER NOT NULL,
                  PRIMARY KEY(workflow_id,verdict_id));
                CREATE TABLE IF NOT EXISTS web_policies(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS web_calls(
                  id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS step_images(
                  step_id TEXT PRIMARY KEY REFERENCES steps(id),payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS prompt_images(
                  request_id TEXT PRIMARY KEY REFERENCES requests(id),payload TEXT NOT NULL);
            """)
    for key, value in {"stream_id": secrets.token_hex(16), "revision": "0", "host_epoch": "0",
                       "freeze_id": "", "stopping": "", "blocked": "", "driver_id": "", "execution_epoch": "0"}.items():
        db.execute("INSERT OR IGNORE INTO metadata VALUES(?,?)", (key, value))
    db.execute("COMMIT")
