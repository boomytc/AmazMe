"""Original client schedule rules and durable admissions, using the Host delivery ledger."""

from __future__ import annotations

import calendar
import hashlib
import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .accounts import ProviderTransport
from .contracts import (
    BackendError,
    CronRule,
    OnceRule,
    ProviderConfig,
    ScheduleControl,
    ScheduleInput,
    ScheduleOutcome,
    ScheduleRule,
    ScheduleRun,
    ScheduleView,
    Submit,
)
from .host_store import delivery_provider, grant_present
from .manage import contains_secret

MAX_TIME = 253402300799999
MINUTE = 60000


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise BackendError("schedule_zone") from exc


def instant(local: datetime, tz: ZoneInfo) -> int | None:
    chosen = local.replace(tzinfo=tz, fold=0)
    try:
        back = chosen.astimezone(UTC).astimezone(tz).replace(tzinfo=None)
    except (ValueError, OverflowError):
        return None
    if back != local:
        return None
    value = (chosen.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)) // timedelta(milliseconds=1)
    return value if 0 <= value <= MAX_TIME else None


@lru_cache(maxsize=128)
def cron(expression: str) -> tuple[tuple[tuple[int, ...], bool], ...]:
    fields = expression.split()
    if len(fields) != 5:
        raise BackendError("schedule_cron")
    result: list[tuple[tuple[int, ...], bool]] = []
    for raw, (low, high) in zip(fields, ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7)), strict=True):
        values: set[int] = set()
        for piece in raw.split(","):
            match = re.fullmatch(r"(\*|\d+(?:-\d+)?)(?:/(\d+))?", piece)
            if match is None:
                raise BackendError("schedule_cron")
            text, step_text = match.groups()
            step = int(step_text or "1")
            bounds = text.split("-")
            start = low if text == "*" else int(bounds[0])
            end = high if text == "*" or step_text and len(bounds) == 1 else int(bounds[-1])
            if not 1 <= step <= MAX_TIME or not low <= start <= end <= high:
                raise BackendError("schedule_cron")
            values.update(0 if high == 7 and item == 7 else item for item in range(start, end + 1, step))
        result.append((tuple(sorted(values)), raw.startswith("*")))
    return tuple(result)


def normalize(rule: ScheduleRule) -> ScheduleRule:
    if rule.kind == "interval":
        return rule
    tz = zone(rule.time_zone)
    if rule.kind == "cron":
        expression = " ".join(rule.expression.split())
        cron(expression)
        return rule.model_copy(update={"expression": expression})
    try:
        due = instant(datetime.fromisoformat(rule.at), tz)
    except ValueError as exc:
        raise BackendError("schedule_time") from exc
    if due is None:
        raise BackendError("schedule_time_gap")
    return rule


def cron_target(rule: CronRule, after: int, direction: int, floor: int = 0) -> int | None:
    minutes, hours, days, months, weekdays = cron(rule.expression)
    tz = zone(rule.time_zone)
    day = datetime.fromtimestamp(after // 1000, tz).date()
    start_year = day.year
    lower = datetime.fromtimestamp(floor // 1000, tz).date()
    while 1969 <= day.year <= 9999 and abs(day.year - start_year) <= 400:
        if direction < 0 and day < lower:
            break
        if day.month not in months[0]:
            year, month = day.year, day.month + direction
            if month == 13:
                year, month = year + 1, 1
            elif month == 0:
                year, month = year - 1, 12
            if not 1 <= year <= 9999:
                break
            day = day.replace(year=year, month=month, day=1 if direction > 0 else calendar.monthrange(year, month)[1])
            continue
        dom, dow = day.day in days[0], (day.weekday() + 1) % 7 in weekdays[0]
        matches = dom and dow if days[1] or weekdays[1] else dom or dow
        if matches:
            for hour in hours[0][::direction]:
                for minute in minutes[0][::direction]:
                    candidate = instant(datetime(day.year, day.month, day.day, hour, minute), tz)
                    if candidate is not None and (candidate > after if direction > 0 else floor <= candidate <= after):
                        return candidate
        try:
            day += timedelta(days=direction)
        except OverflowError:
            break
    return None


def first_target(rule: ScheduleRule, now: int) -> int | None:
    if isinstance(rule, OnceRule):
        return instant(datetime.fromisoformat(rule.at), zone(rule.time_zone))
    if isinstance(rule, CronRule):
        return cron_target(rule, now, 1)
    target = now + rule.every_minutes * MINUTE
    return target if target <= MAX_TIME else None


def latest_due(rule: ScheduleRule, saved: int, now: int) -> int:
    if rule.kind == "once":
        return saved
    if rule.kind == "cron":
        return max(saved, cron_target(rule, now, -1, saved) or saved)
    gap = rule.every_minutes * MINUTE
    return saved + max(0, now - saved) // gap * gap


def next_target(rule: ScheduleRule, occurrence: int, now: int) -> int | None:
    if rule.kind == "once":
        return None
    if rule.kind == "cron":
        return cron_target(rule, max(occurrence, now), 1)
    target = occurrence + (max(0, now - occurrence) // (rule.every_minutes * MINUTE) + 1) * rule.every_minutes * MINUTE
    return target if target <= MAX_TIME else None


def load(db: sqlite3.Connection, schedule_id: str) -> ScheduleView:
    row = db.execute("SELECT payload FROM schedules WHERE id=? AND deleted=0", (schedule_id,)).fetchone()
    if row is None:
        raise BackendError("schedule_not_found", status=404)
    return ScheduleView.model_validate_json(row[0])


def listing(db: sqlite3.Connection) -> list[ScheduleView]:
    return [ScheduleView.model_validate_json(row[0]) for row in db.execute("SELECT payload FROM schedules WHERE deleted=0 ORDER BY id")]


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
        same = all(current.model_dump()[key] == content for key, content in data.items())
        if not value.expected_generation and previous[0] == digest or same and current.generation == value.expected_generation + 1:
            return current
        if current.pending or current.generation != value.expected_generation or current.session_id != value.session_id:
            raise BackendError("schedule_conflict")
    elif value.expected_generation:
        raise BackendError("schedule_not_found", status=404)
    session = db.execute("SELECT workspace,archived,branch_ready FROM sessions WHERE id=?", (value.session_id,)).fetchone()
    if session is None or session[1] or not session[2] or not grant_present(db, str(session[0])):
        raise BackendError("schedule_target_missing")
    target = first_target(value.rule, now)
    if target is None or target <= now or now + value.timeout_seconds * 1000 > MAX_TIME:
        raise BackendError("schedule_future_required")
    record = ScheduleView(**data, workspace=str(session[0]), generation=current.generation + 1 if current else 1,
                          enabled=current.enabled if current else True, created_at=current.created_at if current else now,
                          next_run_at=target, history=current.history if current else [])
    if current is None:
        if db.execute("SELECT count(*) FROM schedules WHERE deleted=0").fetchone()[0] >= 128:
            raise BackendError("schedule_capacity", status=429)
        db.execute("INSERT INTO schedules(id,session,digest,payload) VALUES(?,?,?,?)",
                   (record.schedule_id, record.session_id, digest, record.model_dump_json()))
    return persist(db, record)


def finish(db: sqlite3.Connection, record: ScheduleView, outcome: ScheduleOutcome, now: int) -> ScheduleView:
    db.execute("UPDATE schedule_runs SET outcome=? WHERE schedule=? AND request=?",
               (outcome.model_dump_json(), record.schedule_id, outcome.request_id))
    record.history = [*record.history, outcome][-20:]
    record.pending = None
    if outcome.scheduled_for is not None:
        record.next_run_at = next_target(record.rule, outcome.scheduled_for, now)
        record.enabled = record.enabled and record.next_run_at is not None
    return persist(db, record)


def claim(db: sqlite3.Connection, schedule_id: str, now: int, provider: ProviderConfig,
          secrets: tuple[str, ...], *, operation_id: str = "", generation: int = 0, busy: bool = False,
          transports: dict[str, ProviderTransport] | None = None) -> ScheduleView:
    check_open(db)
    record = load(db, schedule_id)
    occurrence = None if operation_id else latest_due(record.rule, record.next_run_at or now, now)
    request_id = hashlib.sha256(f"{schedule_id}:{operation_id or f'{record.generation}:{occurrence}'}".encode()).hexdigest()[:32]
    if db.execute("SELECT 1 FROM schedule_runs WHERE schedule=? AND request=?", (schedule_id, request_id)).fetchone():
        return record
    if operation_id and record.generation != generation:
        raise BackendError("schedule_conflict")
    if record.pending:
        if operation_id:
            raise BackendError("schedule_busy")
        return record
    if not operation_id and (not record.enabled or record.next_run_at is None or record.next_run_at > now):
        return record
    if sum(item.pending is not None for item in listing(db)) >= 4:
        raise BackendError("schedule_running_capacity", status=429)
    reason = ""
    session = db.execute("SELECT workspace,archived,branch_ready FROM sessions WHERE id=?", (record.session_id,)).fetchone()
    if (session is None or session[1] or not session[2] or session[0] != record.workspace
            or not grant_present(db, record.workspace) or contains_secret(record.text, secrets)):
        reason = "target_missing"
        record.enabled = False
    elif occurrence is not None and record.missed == "skip" and now - occurrence > record.grace_minutes * MINUTE:
        reason = "missed"
    elif record.busy == "skip" and (busy or db.execute(
            "SELECT 1 FROM deliveries WHERE session=? AND state='pending' LIMIT 1", (record.session_id,)).fetchone()):
        reason = "busy"
    db.execute("INSERT INTO schedule_runs(schedule,request) VALUES(?,?)", (schedule_id, request_id))
    if reason:
        return finish(db, record, ScheduleOutcome(request_id=request_id, started_at=now, finished_at=now,
                      scheduled_for=occurrence, status="refused" if reason == "target_missing" else "skipped", detail=reason), now)
    if db.execute("SELECT count(*) FROM deliveries WHERE state='pending'").fetchone()[0] >= 128:
        raise BackendError("delivery_capacity", status=429)
    value = Submit(request_id=request_id, text=record.text)
    payload = value.model_dump_json()
    identity = hashlib.sha256(json.dumps([record.session_id, "submit", request_id]).encode()).hexdigest()
    configured = delivery_provider(db, record.session_id, value, provider, transports)
    db.execute("INSERT INTO deliveries(id,session,kind,digest,payload,provider) VALUES(?,?,?,?,?,?)",
               (identity, record.session_id, "submit", hashlib.sha256(payload.encode()).hexdigest(), payload, configured))
    db.execute("UPDATE sessions SET wanted=1,next_check=0,updated_ms=? WHERE id=?", (now, record.session_id))
    record.pending = ScheduleRun(request_id=request_id, started_at=now, deadline_at=now + record.timeout_seconds * 1000,
                                scheduled_for=occurrence)
    return persist(db, record)


def control(db: sqlite3.Connection, schedule_id: str, value: ScheduleControl, action: Literal["enabled", "cancel", "remove"]) -> ScheduleView:
    if action == "enabled":
        check_open(db)
    removed = db.execute("SELECT payload FROM schedules WHERE id=? AND deleted=1", (schedule_id,)).fetchone()
    record = ScheduleView.model_validate_json(removed[0]) if removed and action == "remove" else load(db, schedule_id)
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
