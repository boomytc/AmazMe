"""Original client schedule rules and durable admissions, using the Host delivery ledger."""

from __future__ import annotations

import calendar
import re
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from amazme_backend.contracts.schedules import (
    CronRule,
    OnceRule,
    ScheduleRule,
)
from amazme_backend.shared.errors import BackendError

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
            day = day.replace(
                year=year, month=month, day=1 if direction > 0 else calendar.monthrange(year, month)[1]
            )
            continue
        dom, dow = day.day in days[0], (day.weekday() + 1) % 7 in weekdays[0]
        matches = dom and dow if days[1] or weekdays[1] else dom or dow
        if matches:
            for hour in hours[0][::direction]:
                for minute in minutes[0][::direction]:
                    candidate = instant(datetime(day.year, day.month, day.day, hour, minute), tz)
                    if candidate is not None and (
                        candidate > after if direction > 0 else floor <= candidate <= after
                    ):
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
    target = (
        occurrence
        + (max(0, now - occurrence) // (rule.every_minutes * MINUTE) + 1) * rule.every_minutes * MINUTE
    )
    return target if target <= MAX_TIME else None
