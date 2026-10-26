"""Bounded raw execution streams. Locators are resolved by the Supervisor, never paths."""
from __future__ import annotations

import codecs
import os
import stat
import time
from pathlib import Path

from amazme_backend.contracts.execution import OutputArchive, OutputPage, OutputRead, StreamRetention
from amazme_backend.platform.private_files import private_write
from amazme_backend.shared.errors import BackendError

STREAM_LIMIT = 4 * 1024 * 1024
ARCHIVE_LIMIT = 128  # Reservations bound the profile to 1 GiB, including active streams.
RETENTION_SECONDS = 7 * 24 * 3600


def decode_prefix(raw: bytes, *, final: bool) -> tuple[str, int]:
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    content = decoder.decode(raw, final=final)
    pending, _ = decoder.getstate()
    return content, len(raw) - len(pending)


class OutputCapture:
    def __init__(self, directory: Path, locator: str, expires_at: int, error: str = ""):
        self.directory = directory
        self.archive = OutputArchive(locator=locator, expires_at=expires_at,
            stdout=StreamRetention(error=error), stderr=StreamRetention(error=error))
        self.last_publish = 0.0
        self.metadata_failed = False

    def append(self, stream: str, data: bytes) -> None:
        retained = self.archive.stdout if stream == "stdout" else self.archive.stderr
        retained.observed_bytes += len(data)
        if retained.error:
            return
        payload = data[:max(0, STREAM_LIMIT - retained.retained_bytes)]
        try:
            if payload:
                fd = os.open(self.directory / (stream + ".log"),
                    os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                try:
                    view = memoryview(payload)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise OSError("short log write")
                        retained.retained_bytes += written
                        view = view[written:]
                    os.fsync(fd)
                finally:
                    os.close(fd)
            if len(payload) < len(data):
                retained.error = "output_quota"
        except OSError:
            retained.error = "output_save_failed"

    def publish(self, *, settled: bool = False) -> None:
        self.archive.settled = settled
        if not self.archive.expires_at or self.metadata_failed:
            return
        if not settled and time.monotonic() - self.last_publish < 0.1:
            return
        try:
            private_write(self.directory / "output.json", self.archive.model_dump_json())
        except OSError:
            self.metadata_failed = True
            for retained in (self.archive.stdout, self.archive.stderr):
                retained.error = "output_metadata_failed"
        self.last_publish = time.monotonic()


def read_output(directory: Path, value: OutputRead) -> OutputPage:
    try:
        meta = directory / "output.json"
        if meta.is_symlink() or meta.stat().st_size > 8192:
            raise BackendError("output_unavailable")
        archive = OutputArchive.model_validate_json(meta.read_bytes())
        if archive.locator != value.locator:
            raise BackendError("output_unavailable")
        if archive.expires_at <= int(time.time()):
            raise BackendError("output_expired", status=410)
        retained = archive.stdout if value.stream == "stdout" else archive.stderr
        path = directory / (value.stream + ".log")
        if path.is_symlink():
            raise BackendError("output_unavailable")
        if not path.exists() and retained.retained_bytes == 0:
            raw = b""
            size = 0
        else:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > STREAM_LIMIT:
                    raise BackendError("output_unavailable")
                size = info.st_size
                raw = os.pread(fd, value.limit, value.offset)
            finally:
                os.close(fd)
        if value.offset > size or (value.offset and raw and raw[0] & 0xC0 == 0x80):
            raise BackendError("output_cursor")
        retained.retained_bytes = size
        retained.observed_bytes = max(size, retained.observed_bytes)
        final = value.offset + len(raw) == size and (archive.settled or bool(retained.error))
        content, consumed = decode_prefix(raw, final=final)
        next_offset = value.offset + consumed
        return OutputPage(archive=archive, stream=value.stream, offset=value.offset,
            next_offset=next_offset, content=content, has_more=next_offset < size)
    except (OSError, ValueError) as error:
        raise BackendError("output_unavailable", status=503) from error
