"""Local CLI/TUI context; the SDK lets callers report their own IANA zone."""
import os
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_time_zone() -> str:
    reported = os.environ.get("TZ", "").removeprefix(":")
    if not reported:
        try:
            _, marker, reported = str(Path("/etc/localtime").resolve(strict=True)).partition("/zoneinfo/")
            if not marker:
                return ""
        except OSError:
            return ""
    if reported != "UTC" and "/" not in reported:
        return ""
    try:
        return ZoneInfo(reported).key
    except (ValueError, ZoneInfoNotFoundError):
        return ""
