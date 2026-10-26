import asyncio
import shutil
import sqlite3
import tempfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import IO

from amazme_backend.shared.errors import BackendError

"Serialized Host database connection and on-disk integrity boundary."


class HostDatabase:
    def __init__(
        self,
        path: Path,
        *,
        require_existing: bool = False,
        read_only: bool = False,
        preflight: Callable[[sqlite3.Connection], None] | None = None,
    ):
        self.path = path
        self.require_existing = require_existing
        self.read_only = read_only
        self.preflight = preflight
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sqlite-owner")
        self.connection: sqlite3.Connection | None = None
        self.lock_file: IO[str] | None = None
        self.closed = False
        self.failure: str = ""
        self.identity: tuple[int, int] | None = None
        self.file_size = 0

    def _validate_file(self, *, initialized: bool = True) -> None:
        info = self.path.stat()
        if self.identity != (info.st_dev, info.st_ino) or (
            initialized and info.st_size < max(100, self.file_size)
        ):
            raise OSError("database file identity changed")
        self.file_size = info.st_size

    def _invoke[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.failure:
            raise BackendError("storage_blocked", self.failure, 503)
        try:
            if self.connection is None:
                exists = self.path.exists()
                if exists:
                    info = self.path.stat()
                    self.identity = (info.st_dev, info.st_ino)
                if self.require_existing and (not exists or self.path.stat().st_size == 0):
                    raise BackendError("storage_missing", status=503)
                if self.read_only:
                    if not exists or self.path.stat().st_size == 0:
                        raise BackendError("storage_missing", status=503)
                    opened = sqlite3.connect(
                        self.path.resolve().as_uri() + "?mode=ro", uri=True, isolation_level=None
                    )
                    try:
                        opened.row_factory = sqlite3.Row
                        opened.execute("PRAGMA query_only=ON")
                        opened.execute("PRAGMA foreign_keys=ON")
                        info = self.path.stat()
                        self.identity = (info.st_dev, info.st_ino)
                        self.file_size = info.st_size
                        self.validate_schema(opened)
                    except BaseException:
                        opened.close()
                        raise
                    self.connection = opened
                    self._validate_file()
                    result = operation(self.connection)
                    self._validate_file()
                    return result
                if exists and self.path.stat().st_size:
                    with tempfile.TemporaryDirectory(prefix="amazme-preflight-") as temporary:
                        copied = Path(temporary) / "store.sqlite"
                        shutil.copyfile(self.path, copied)
                        wal = self.path.with_name(self.path.name + "-wal")
                        if wal.exists():
                            shutil.copyfile(wal, copied.with_name(copied.name + "-wal"))
                        probe = sqlite3.connect(copied.as_uri() + "?mode=ro", uri=True)
                        try:
                            self.validate_schema(probe)
                        finally:
                            probe.close()
                if exists:
                    self._validate_file(initialized=False)
                self.connection = sqlite3.connect(
                    self.path.resolve().as_uri() + ("?mode=rw" if exists else "?mode=rwc"),
                    uri=True,
                    isolation_level=None,
                )
                if self.identity is None:
                    info = self.path.stat()
                    self.identity = (info.st_dev, info.st_ino)
                self._validate_file(initialized=False)
                self.connection.row_factory = sqlite3.Row
                self.connection.execute("PRAGMA user_version=2")
                self.connection.execute("PRAGMA journal_mode=WAL")
                self.connection.execute("PRAGMA synchronous=FULL")
                self.connection.execute("PRAGMA foreign_keys=ON")
            self._validate_file()
            result = operation(self.connection)
            self._validate_file()
            return result
        except (sqlite3.DatabaseError, OSError) as exc:
            self.failure = type(exc).__name__ + ":" + str(exc)
            raise BackendError("storage_failure", self.failure, 503) from exc

    def validate_schema(self, probe: sqlite3.Connection) -> None:
        version = probe.execute("PRAGMA user_version").fetchone()[0]
        tables = probe.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        fresh = not self.require_existing and version == 0 and (tables == 0)
        if version != 2 and (not fresh):
            raise BackendError("unsupported_storage_format")
        if self.require_existing and tables == 0:
            raise BackendError("storage_missing", status=503)
        if probe.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise BackendError("storage_corrupt")
        if version == 2 and self.preflight:
            self.preflight(probe)

    async def call[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.closed:
            raise BackendError("database_closed", status=503)
        return await asyncio.shield(
            asyncio.get_running_loop().run_in_executor(self.pool, self._invoke, operation)
        )

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True

        def close_connection() -> None:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
            if self.lock_file is not None:
                self.lock_file.close()
                self.lock_file = None

        try:
            await asyncio.get_running_loop().run_in_executor(self.pool, close_connection)
        finally:
            self.pool.shutdown(wait=True)
