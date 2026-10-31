import hashlib
import json
import sqlite3
import time

from amazme_backend.accounts.configuration import ProviderTransport, select_model
from amazme_backend.ai.catalog import SELECTION_INDEX
from amazme_backend.contracts.execution import EffectResolution
from amazme_backend.contracts.ipc.worker import Cancel, JobNotice
from amazme_backend.contracts.models import ModelSelection
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.questions import QuestionAnswer
from amazme_backend.contracts.sessions import ApprovalDecision, Receipt, Submit
from amazme_backend.host.persistence.owner import PersistenceOwner
from amazme_backend.host.records import Delivery, DeliveryKind
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


def delivery_provider(
    db: sqlite3.Connection,
    session: str,
    value: Submit,
    provider: ProviderConfig,
    transports: dict[str, ProviderTransport] | None = None,
) -> str:
    if value.mode == "steer":
        return ""
    selection = value.model_selection
    if selection is None:
        chosen = db.execute(
            "SELECT provider,model FROM session_models WHERE session=?", (session,)
        ).fetchone()
        if chosen is not None:
            selection = ModelSelection(provider=str(chosen[0]), model=str(chosen[1]))
    captured = select_model(provider, selection, transports or {}, catalog=SELECTION_INDEX)
    db.execute(
        "INSERT INTO session_models(session,provider,model) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET provider=excluded.provider,model=excluded.model",
        (session, captured.provider, captured.model),
    )
    return captured.model_dump_json()


def delivery_row(row: sqlite3.Row) -> Delivery:
    value = Delivery.model_validate(
        {
            "delivery_id": row["id"],
            "session_id": row["session"],
            "kind": row["kind"],
            "payload": row["payload"],
            "state": row["state"],
            "receipt": Receipt.model_validate_json(row["receipt"]) if row["receipt"] else None,
            "error_code": row["error_code"],
            "error_status": row["error_status"],
            "provider": ProviderConfig.model_validate_json(row["provider"]) if row["provider"] else None,
        }
    )
    commands = {"submit": Submit, "cancel": Cancel, "approval": ApprovalDecision, "question": QuestionAnswer, "resolve": EffectResolution,
                "job_notice": JobNotice}
    commands[value.kind].model_validate_json(value.payload)
    return value


async def enqueue(
    self: PersistenceOwner,
    session: str,
    kind: DeliveryKind,
    key: str,
    value: Model,
    *,
    provider: ProviderConfig | None = None,
    transports: dict[str, ProviderTransport] | None = None,
) -> Delivery:
    payload = value.model_dump_json()
    digest = hashlib.sha256(payload.encode()).hexdigest()
    identity = hashlib.sha256(json.dumps([session, kind, key]).encode()).hexdigest()

    def operation(db: sqlite3.Connection) -> Delivery:
        existing = db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone()
        if existing:
            if existing["digest"] != digest:
                raise BackendError("request_conflict")
            return delivery_row(existing)
        if db.execute("SELECT quitting FROM control WHERE id=1").fetchone()[0]:
            raise BackendError("host_stopping", status=503)
        row = db.execute("SELECT archived,branch_ready FROM sessions WHERE id=?", (session,)).fetchone()
        if row is None:
            raise BackendError("session_not_found", status=404)
        if not bool(row["branch_ready"]):
            raise BackendError("branch_preparation_pending")
        if kind in {"submit", "job_notice"} and int(row[0]):
            raise BackendError("session_archived")
        if (
            kind not in {"cancel", "resolve"}
            and db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]
        ):
            raise BackendError("update_frozen", status=503)
        if db.execute("SELECT count(*) FROM deliveries WHERE state='pending'").fetchone()[0] >= 128:
            raise BackendError("delivery_capacity", status=429)
        configured = ""
        if isinstance(value, Submit) and provider is not None:
            configured = delivery_provider(db, session, value, provider, transports)
        db.execute(
            "INSERT INTO deliveries(id,session,kind,digest,payload,provider) VALUES(?,?,?,?,?,?)",
            (identity, session, kind, digest, payload, configured),
        )
        db.execute(
            "UPDATE sessions SET empty_draft=0,wanted=1,next_check=0,updated_ms=? WHERE id=?",
            (time.time_ns() // 1000000, session),
        )
        return delivery_row(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())

    return await self.transaction(operation)


async def begin_quit(self: PersistenceOwner) -> None:

    def operation(db: sqlite3.Connection) -> None:
        db.execute("UPDATE control SET quitting=1 WHERE id=1")
        db.execute(
            "UPDATE deliveries SET state='rejected',error_code='host_stopping',error_status=503 WHERE state='pending'"
        )

    await self.transaction(operation)


async def pin_delivery_provider(
    self: PersistenceOwner,
    identity: str,
    provider: ProviderConfig,
    transports: dict[str, ProviderTransport] | None = None,
) -> Delivery:
    """Scheduled deliveries reserve their model before starting any worker."""

    def operation(db: sqlite3.Connection) -> Delivery:
        row = db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise BackendError("delivery_not_found")
        if row["kind"] == "submit" and row["state"] == "pending" and (not row["provider"]):
            value = Submit.model_validate_json(row["payload"])
            captured = delivery_provider(db, str(row["session"]), value, provider, transports)
            db.execute("UPDATE deliveries SET provider=? WHERE id=? AND provider=''", (captured, identity))
        return delivery_row(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())

    return await self.transaction(operation)


async def delivered(self: PersistenceOwner, identity: str, receipt: Receipt) -> Delivery:

    def operation(db: sqlite3.Connection) -> Delivery:
        db.execute(
            "UPDATE deliveries SET state='delivered',receipt=? WHERE id=? AND state='pending'",
            (receipt.model_dump_json(), identity),
        )
        return delivery_row(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())

    return await self.transaction(operation)


async def rejected(self: PersistenceOwner, identity: str, error: BackendError) -> Delivery:

    def operation(db: sqlite3.Connection) -> Delivery:
        db.execute(
            "UPDATE deliveries SET state='rejected',error_code=?,error_status=? WHERE id=? AND state='pending'",
            (error.code, error.status, identity),
        )
        return delivery_row(db.execute("SELECT * FROM deliveries WHERE id=?", (identity,)).fetchone())

    return await self.transaction(operation)


async def pending(self: PersistenceOwner, session: str | None = None) -> list[Delivery]:
    return await self.call(
        lambda db: [
            delivery_row(row)
            for row in db.execute(
                "SELECT * FROM deliveries WHERE state='pending' AND (? IS NULL OR session=?) ORDER BY CASE kind WHEN 'cancel' THEN 0 ELSE 1 END,ordinal LIMIT 128",
                (session, session),
            )
        ]
    )
