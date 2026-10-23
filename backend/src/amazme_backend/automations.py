"""Resolve a civil time in an IANA zone. Gaps and folds are not guessed."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .contracts import BackendError


def resolve_due(local: str, zone: str, fold: int | None) -> tuple[int, int]:
    try:
        tz = ZoneInfo(zone)
    except ZoneInfoNotFoundError as exc:
        raise BackendError("automation_zone") from exc
    try:
        naive = datetime.strptime(local, "%Y-%m-%dT%H:%M")
    except ValueError as exc:
        raise BackendError("automation_time") from exc
    earlier = naive.replace(tzinfo=tz, fold=0)
    later = naive.replace(tzinfo=tz, fold=1)
    back = earlier.astimezone(ZoneInfo("UTC")).astimezone(tz).replace(tzinfo=None)
    if back != naive:
        raise BackendError("automation_time_gap")
    ambiguous = earlier.utcoffset() != later.utcoffset()
    if ambiguous and fold not in (0, 1):
        raise BackendError("automation_time_fold")
    if not ambiguous and fold not in (None, 0):
        raise BackendError("automation_time_fold")
    chosen = later if ambiguous and fold == 1 else earlier
    return int(chosen.timestamp() * 1000), 1 if ambiguous and fold == 1 else 0
