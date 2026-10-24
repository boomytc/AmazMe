"""Read-only allocation limits for build/verification scopes on macOS/Linux.

Only supplied trees are traversed. Missing roots count as zero; other read errors
fail closed. Symlink roots are refused and nested symlinks are counted, never
followed. Sparse files use st_blocks, with device/inode deduplication across roots.

ResourceBudget uses SIGALRM on the main thread, interrupting blocking subprocess
and HTTP waits. BudgetAbort deliberately bypasses ordinary Exception retries.
Callers own process/VM cleanup in finally, outside the monitored scope. Sampling
is a watchdog, not a filesystem quota: allocation can overshoot between samples.
"""

from __future__ import annotations

import math
import os
import signal
import stat
import threading
import time
from collections.abc import Iterable
from pathlib import Path

DEFAULT_LIMIT_BYTES = 8 * 1024**3
DEFAULT_MIN_FREE_BYTES = 20 * 1024**3


class ResourceBudgetError(RuntimeError):
    """A preflight limit or filesystem observation failed."""


class BudgetAbort(BaseException):
    """Unwind the monitored operation all the way to its cleanup owner."""


def allocated_bytes(paths: Iterable[Path]) -> int:
    seen: set[tuple[int, int]] = set()
    total = 0
    try:
        for root in paths:
            root = Path(root)
            try:
                info = root.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode):
                raise ResourceBudgetError(f"Budget root is a symlink: {root}")
            pending = [(root, info)]
            while pending:
                path, info = pending.pop()
                key = (info.st_dev, info.st_ino)
                if key in seen:
                    continue
                seen.add(key)
                total += info.st_blocks * 512
                if stat.S_ISDIR(info.st_mode):
                    with os.scandir(path) as entries:
                        for entry in entries:
                            pending.append((Path(entry.path), entry.stat(follow_symlinks=False)))
    except (OSError, AttributeError) as error:
        raise ResourceBudgetError(f"Cannot measure allocated bytes: {error}") from error
    return total


def free_bytes(paths: Iterable[Path]) -> int:
    """Minimum available bytes on the filesystems containing the supplied roots."""
    available = []
    try:
        for supplied in paths:
            path = Path(supplied).absolute()
            while True:
                try:
                    info = path.lstat()
                    break
                except FileNotFoundError:
                    if path == path.parent:
                        raise
                    path = path.parent
            if stat.S_ISLNK(info.st_mode):
                raise ResourceBudgetError(f"Budget ancestor is a symlink: {path}")
            usage = os.statvfs(path)
            available.append(usage.f_bavail * usage.f_frsize)
    except OSError as error:
        raise ResourceBudgetError(f"Cannot measure free space: {error}") from error
    if not available:
        raise ResourceBudgetError("At least one budget path is required")
    return min(available)


def _validate(limit_bytes: int, min_free_bytes: int, reserve_bytes: int) -> None:
    if limit_bytes <= 0 or min_free_bytes < 0 or reserve_bytes < 0:
        raise ValueError("Budget cap must be positive; free floor and reserve must be nonnegative")


def _require(allocated: int, available: int, limit: int, floor: int, reserve: int = 0) -> None:
    if allocated + reserve > limit:
        raise ResourceBudgetError(f"Allocated {allocated} + reserve {reserve} exceeds cap {limit} bytes")
    if available - reserve < floor:
        raise ResourceBudgetError(f"Free {available} - reserve {reserve} is below floor {floor} bytes")


def require_budget(paths: Iterable[Path], limit_bytes: int = DEFAULT_LIMIT_BYTES,
                   min_free_bytes: int = DEFAULT_MIN_FREE_BYTES, *, reserve_bytes: int = 0) -> int:
    _validate(limit_bytes, min_free_bytes, reserve_bytes)
    roots = tuple(paths)
    allocated, available = allocated_bytes(roots), free_bytes(roots)
    _require(allocated, available, limit_bytes, min_free_bytes, reserve_bytes)
    return allocated


class ResourceBudget:
    def __init__(self, paths: Iterable[Path], limit_bytes: int = DEFAULT_LIMIT_BYTES,
                 min_free_bytes: int = DEFAULT_MIN_FREE_BYTES, *, deadline_seconds: float = 900,
                 interval_seconds: float = 0.5):
        _validate(limit_bytes, min_free_bytes, 0)
        if not all(math.isfinite(v) and v > 0 for v in (deadline_seconds, interval_seconds)):
            raise ValueError("Budget deadline and sample interval must be finite and positive")
        self.paths = tuple(Path(p).absolute() for p in paths)
        if not self.paths:
            raise ValueError("At least one budget path is required")
        self.limit_bytes, self.min_free_bytes = limit_bytes, min_free_bytes
        self.deadline_seconds, self.interval_seconds = deadline_seconds, interval_seconds
        self.highwater_bytes = self.current_bytes = 0
        self.minimum_free_bytes: int | None = None
        self.samples = 0
        self.failure = ""
        self.started: float | None = None
        self.ended: float | None = None
        self._active = False
        self._previous = signal.SIG_DFL

    def _sample(self, *, deadline: bool = True) -> None:
        try:
            self.current_bytes = allocated_bytes(self.paths)
            self.highwater_bytes = max(self.highwater_bytes, self.current_bytes)
            available = free_bytes(self.paths)
            self.minimum_free_bytes = min(self.minimum_free_bytes, available) if self.samples else available
            self.samples += 1
            _require(self.current_bytes, available, self.limit_bytes, self.min_free_bytes)
            if deadline and self.started is not None and time.monotonic() - self.started >= self.deadline_seconds:
                raise ResourceBudgetError(f"Resource scope exceeded {self.deadline_seconds}s deadline")
        except Exception as error:
            self.failure = self.failure or str(error)
            raise BudgetAbort(str(error)) from error

    def _alarm(self, _signum, _frame) -> None:
        # One-shot rearming prevents a slow tree scan from recursively interrupting itself.
        self._sample()
        self._arm()

    def _arm(self) -> None:
        remaining = self.deadline_seconds - (time.monotonic() - self.started)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, min(self.interval_seconds, remaining)))

    def __enter__(self) -> ResourceBudget:
        if threading.current_thread() is not threading.main_thread():
            raise ResourceBudgetError("ResourceBudget must run on the main thread")
        if self.started is not None or any(signal.getitimer(signal.ITIMER_REAL)):
            raise ResourceBudgetError("ResourceBudget cannot reuse a scope or replace an active timer")
        self.started = time.monotonic()
        try:
            self._sample()
        except BaseException:
            self.ended = time.monotonic()
            raise
        self._previous = signal.signal(signal.SIGALRM, self._alarm)
        self._active = True
        self._arm()
        return self

    def __exit__(self, exc_type, _value, _traceback) -> None:
        if self._active:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self._previous)
            self._active = False
        try:
            self._sample(deadline=exc_type is None)
        except BudgetAbort:
            if exc_type is None:
                raise
        finally:
            self.ended = time.monotonic()

    def snapshot(self) -> dict:
        return {"paths": [str(p) for p in self.paths], "cap_bytes": self.limit_bytes,
                "highwater_bytes": self.highwater_bytes, "current_bytes": self.current_bytes,
                "free_floor_bytes": self.min_free_bytes, "minimum_free_bytes": self.minimum_free_bytes,
                "deadline_seconds": self.deadline_seconds, "interval_seconds": self.interval_seconds,
                "elapsed_seconds": 0 if self.started is None else (self.ended or time.monotonic()) - self.started,
                "samples": self.samples, "failure": self.failure}
