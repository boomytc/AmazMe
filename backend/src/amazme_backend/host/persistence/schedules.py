from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Literal

from amazme_backend.accounts.configuration import ProviderTransport
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.schedules import (
    ScheduleControl,
    ScheduleInput,
    ScheduleOutcome,
    ScheduleRun,
    ScheduleView,
)
from amazme_backend.contracts.sessions import Submit
from amazme_backend.features.management.rules import contains_secret
from amazme_backend.features.schedules.policy import (
    MAX_TIME,
    MINUTE,
    first_target,
    latest_due,
    next_target,
    normalize,
)
from amazme_backend.host.persistence.deliveries import delivery_provider
from amazme_backend.host.persistence.workspaces import grant_present
from amazme_backend.shared.errors import BackendError


def load(db: sqlite3.Connection, schedule_id: str) -> ScheduleView:
    row = db.execute("SELECT payload FROM schedules WHERE id=? AND deleted=0", (schedule_id,)).fetchone()
    if row is None:
        raise BackendError("schedule_not_found", status=404)
    return ScheduleView.model_validate_json(row[0])


def listing(db: sqlite3.Connection) -> list[ScheduleView]:
    return [
        ScheduleView.model_validate_json(row[0])
        for row in db.execute("SELECT payload FROM schedules WHERE deleted=0 ORDER BY id")
    ]


def persist(db: sqlite3.Connection, value: ScheduleView) -> ScheduleView:
    db.execute("UPDATE schedules SET payload=? WHERE id=?", (value.model_dump_json(), value.schedule_id))
    return value


def check_open(db: sqlite3.Connection) -> None:
    if db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]:
        raise BackendError("update_frozen", status=503)


def save(db: sqlite3.Connection, value: ScheduleInput, now: int, secrets: tuple[str, ...]) -> ScheduleView:
    check_open(db)
    value = value.model_copy(update={"text": value.text.strip(), "rule": normalize(value.rule)})
    if not value.text or contains_secret(value.text, secrets):
        raise BackendError("schedule_text")
    data = value.model_dump(exclude={"expected_generation"})
    digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    previous = db.execute("SELECT digest,deleted FROM schedules WHERE id=?", (value.schedule_id,)).fetchone()
    current: ScheduleView | None = None
    if previous is not None:
        if previous[1]:
            raise BackendError("schedule_removed")
        current = load(db, value.schedule_id)
        same = all((current.model_dump()[key] == content for key, content in data.items()))
        if (
            not value.expected_generation
            and previous[0] == digest
            or (same and current.generation == value.expected_generation + 1)
        ):
            return current
        if (
            current.pending
            or current.generation != value.expected_generation
            or current.session_id != value.session_id
        ):
            raise BackendError("schedule_conflict")
    elif value.expected_generation:
        raise BackendError("schedule_not_found", status=404)
    session = db.execute(
        "SELECT workspace,archived,branch_ready FROM sessions WHERE id=?", (value.session_id,)
    ).fetchone()
    if session is None or session[1] or (not session[2]) or (not grant_present(db, str(session[0]))):
        raise BackendError("schedule_target_missing")
    target = first_target(value.rule, now)
    if target is None or target <= now or now + value.timeout_seconds * 1000 > MAX_TIME:
        raise BackendError("schedule_future_required")
    record = ScheduleView(
        **data,
        workspace=str(session[0]),
        generation=current.generation + 1 if current else 1,
        enabled=current.enabled if current else True,
        created_at=current.created_at if current else now,
        next_run_at=target,
        history=current.history if current else [],
    )
    if current is None:
        if db.execute("SELECT count(*) FROM schedules WHERE deleted=0").fetchone()[0] >= 128:
            raise BackendError("schedule_capacity", status=429)
        db.execute(
            "INSERT INTO schedules(id,session,digest,payload) VALUES(?,?,?,?)",
            (record.schedule_id, record.session_id, digest, record.model_dump_json()),
        )
    return persist(db, record)


def finish(db: sqlite3.Connection, record: ScheduleView, outcome: ScheduleOutcome, now: int) -> ScheduleView:
    db.execute(
        "UPDATE schedule_runs SET outcome=? WHERE schedule=? AND request=?",
        (outcome.model_dump_json(), record.schedule_id, outcome.request_id),
    )
    record.history = [*record.history, outcome][-20:]
    record.pending = None
    if outcome.scheduled_for is not None:
        record.next_run_at = next_target(record.rule, outcome.scheduled_for, now)
        record.enabled = record.enabled and record.next_run_at is not None
    return persist(db, record)


def claim(
    db: sqlite3.Connection,
    schedule_id: str,
    now: int,
    provider: ProviderConfig,
    secrets: tuple[str, ...],
    *,
    operation_id: str = "",
    generation: int = 0,
    busy: bool = False,
    transports: dict[str, ProviderTransport] | None = None,
) -> ScheduleView:
    check_open(db)
    record = load(db, schedule_id)
    occurrence = None if operation_id else latest_due(record.rule, record.next_run_at or now, now)
    request_id = hashlib.sha256(
        f"{schedule_id}:{operation_id or f'{record.generation}:{occurrence}'}".encode()
    ).hexdigest()[:32]
    if db.execute(
        "SELECT 1 FROM schedule_runs WHERE schedule=? AND request=?", (schedule_id, request_id)
    ).fetchone():
        return record
    if operation_id and record.generation != generation:
        raise BackendError("schedule_conflict")
    if record.pending:
        if operation_id:
            raise BackendError("schedule_busy")
        return record
    if not operation_id and (not record.enabled or record.next_run_at is None or record.next_run_at > now):
        return record
    if sum((item.pending is not None for item in listing(db))) >= 4:
        raise BackendError("schedule_running_capacity", status=429)
    reason = ""
    session = db.execute(
        "SELECT workspace,archived,branch_ready FROM sessions WHERE id=?", (record.session_id,)
    ).fetchone()
    if (
        session is None
        or session[1]
        or (not session[2])
        or (session[0] != record.workspace)
        or (not grant_present(db, record.workspace))
        or contains_secret(record.text, secrets)
    ):
        reason = "target_missing"
        record.enabled = False
    elif (
        occurrence is not None
        and record.missed == "skip"
        and (now - occurrence > record.grace_minutes * MINUTE)
    ):
        reason = "missed"
    elif record.busy == "skip" and (
        busy
        or db.execute(
            "SELECT 1 FROM deliveries WHERE session=? AND state='pending' LIMIT 1", (record.session_id,)
        ).fetchone()
    ):
        reason = "busy"
    db.execute("INSERT INTO schedule_runs(schedule,request) VALUES(?,?)", (schedule_id, request_id))
    if reason:
        return finish(
            db,
            record,
            ScheduleOutcome(
                request_id=request_id,
                started_at=now,
                finished_at=now,
                scheduled_for=occurrence,
                status="refused" if reason == "target_missing" else "skipped",
                detail=reason,
            ),
            now,
        )
    if db.execute("SELECT count(*) FROM deliveries WHERE state='pending'").fetchone()[0] >= 128:
        raise BackendError("delivery_capacity", status=429)
    value = Submit(request_id=request_id, text=record.text)
    payload = value.model_dump_json()
    identity = hashlib.sha256(json.dumps([record.session_id, "submit", request_id]).encode()).hexdigest()
    configured = delivery_provider(db, record.session_id, value, provider, transports)
    db.execute(
        "INSERT INTO deliveries(id,session,kind,digest,payload,provider) VALUES(?,?,?,?,?,?)",
        (
            identity,
            record.session_id,
            "submit",
            hashlib.sha256(payload.encode()).hexdigest(),
            payload,
            configured,
        ),
    )
    db.execute("UPDATE sessions SET wanted=1,next_check=0,updated_ms=? WHERE id=?", (now, record.session_id))
    record.pending = ScheduleRun(
        request_id=request_id,
        started_at=now,
        deadline_at=now + record.timeout_seconds * 1000,
        scheduled_for=occurrence,
    )
    return persist(db, record)


def control(
    db: sqlite3.Connection,
    schedule_id: str,
    value: ScheduleControl,
    action: Literal["enabled", "cancel", "remove"],
) -> ScheduleView:
    if action == "enabled":
        check_open(db)
    removed = db.execute("SELECT payload FROM schedules WHERE id=? AND deleted=1", (schedule_id,)).fetchone()
    record = (
        ScheduleView.model_validate_json(removed[0])
        if removed and action == "remove"
        else load(db, schedule_id)
    )
    if value.expected_generation != record.generation:
        raise BackendError("schedule_conflict")
    if action == "enabled":
        if value.enabled is None:
            raise BackendError("schedule_enabled_required")
        record.enabled = value.enabled and record.next_run_at is not None
    elif record.pending:
        if value.request_id != record.pending.request_id:
            raise BackendError("schedule_run_changed")
        record.pending.cancel_reason = record.pending.cancel_reason or "cancelled"
    if action == "remove":
        record.enabled = False
    return persist(db, record)


def remove(db: sqlite3.Connection, identity: str) -> None:
    row = db.execute("SELECT payload FROM schedules WHERE id=?", (identity,)).fetchone()
    if row is None:
        raise BackendError("schedule_not_found", status=404)
    record = ScheduleView.model_validate_json(row[0])
    if record.pending:
        raise BackendError("schedule_cleanup_pending")
    db.execute("UPDATE schedules SET deleted=1 WHERE id=?", (identity,))
