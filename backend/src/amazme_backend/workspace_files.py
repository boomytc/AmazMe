"""Granted-workspace file browse and checked writes. No host shell and no symlink escape."""
from __future__ import annotations

import difflib
import errno
import hashlib
import os
import stat
from pathlib import Path

from pydantic import Field

from .contracts import BackendError, Model

_LIST_LIMIT = 200
_READ_LIMIT = 32_000
_WRITE_LIMIT = 1_048_576


class FileEntry(Model):
    name: str
    kind: str
    size: int


class FileList(Model):
    path: str
    guest_path: str = ""
    entries: list[FileEntry]
    truncated: bool = False


class FileContent(Model):
    path: str
    guest_path: str = ""
    digest: str
    content: str
    truncated: bool = False


class FileWrite(Model):
    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(max_length=_WRITE_LIMIT)
    expected_digest: str = Field(default="", max_length=64)


class FileChange(Model):
    path: str
    digest: str
    diff: str


def _parts(relative: str) -> list[str]:
    if not relative or relative == ".":
        raise BackendError("invalid_workspace_path")
    path = Path(relative)
    parts = [part for part in path.parts if part != "."]
    if path.is_absolute() or not parts or ".." in parts:
        raise BackendError("invalid_workspace_path")
    return parts


def _walk(root: Path, parts: list[str], symlink_code: str) -> Path:
    current = root.resolve()
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise BackendError(symlink_code)
        if not current.exists() or not current.is_dir() or not current.resolve().is_relative_to(root.resolve()):
            raise BackendError("workspace_not_directory")
    return current


def _kind(path: Path) -> str:
    if path.is_symlink():
        return "link"
    if path.is_dir():
        return "dir"
    if path.is_file():
        return "file"
    return "other"


def list_files(root: Path, relative: str = "") -> FileList:
    directory = root.resolve() if relative in {"", "."} else _walk(root, _parts(relative), "workspace_not_directory")
    if directory.is_symlink() or not directory.is_dir():
        raise BackendError("workspace_not_directory")
    try:
        children = sorted(directory.iterdir(), key=lambda item: item.name)
    except OSError as exc:
        raise _os_error(exc) from exc
    entries = [
        FileEntry(name=child.name, kind=_kind(child), size=child.lstat().st_size)
        for child in children[:_LIST_LIMIT]
    ]
    shown = "" if relative in {"", "."} else relative.strip("/")
    return FileList(path=shown, entries=entries, truncated=len(children) > _LIST_LIMIT)


def _text_prefix(data: bytes) -> str:
    try:
        return data.decode()
    except UnicodeDecodeError as exc:
        if exc.start > 0 and exc.end == len(data):
            return data[:exc.start].decode()
        raise BackendError("file_not_text") from exc


def _hash_file(path: Path) -> tuple[str, bytes, int]:
    digest = hashlib.sha256()
    head = bytearray()
    total = 0
    with path.open("rb") as handle:
        while block := handle.read(65_536):
            total += len(block)
            digest.update(block)
            if len(head) < _READ_LIMIT:
                head.extend(block[: _READ_LIMIT - len(head)])
    return digest.hexdigest(), bytes(head), total


def read_file(root: Path, relative: str) -> FileContent:
    parts = _parts(relative)
    if len(parts) > 1:
        _walk(root, parts[:-1], "workspace_not_directory")
    requested = root.resolve() / Path(*parts)
    if requested.is_symlink():
        target = requested.resolve()
        if not target.is_relative_to(root.resolve()):
            raise BackendError("workspace_path_escape")
        if not target.is_file():
            raise BackendError("workspace_not_file")
        path = target
    elif not requested.is_file() or not requested.resolve().is_relative_to(root.resolve()):
        raise BackendError("workspace_not_file")
    else:
        path = requested
    try:
        digest, head, total = _hash_file(path)
    except OSError as exc:
        raise _os_error(exc) from exc
    return FileContent(path="/".join(parts), digest=digest, content=_text_prefix(head), truncated=total > _READ_LIMIT)


def _os_error(exc: OSError) -> BackendError:
    if exc.errno in {errno.ELOOP, errno.EMLINK}:
        return BackendError("workspace_symlink_write")
    if exc.errno in {errno.EACCES, errno.EPERM}:
        return BackendError("workspace_permission")
    if exc.errno == errno.ENOSPC:
        return BackendError("workspace_no_space", status=503)
    if exc.errno in {errno.EISDIR, errno.ENOTDIR}:
        return BackendError("workspace_not_file")
    if exc.errno == errno.ENOENT:
        return BackendError("file_conflict")
    return BackendError("workspace_write_failed")


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    offset = 0
    while offset < len(view):
        count = os.write(fd, view[offset:])
        if count <= 0:
            raise BackendError("workspace_write_failed")
        offset += count


def _restore(fd: int, previous: bytes) -> None:
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        _write_all(fd, previous)
        os.fsync(fd)
    except (OSError, BackendError):
        return


def write_file(root: Path, value: FileWrite) -> FileChange:
    payload = value.content.encode()
    if len(payload) > _WRITE_LIMIT:
        raise BackendError("file_too_large")
    parts = _parts(value.path)
    parent = _walk(root, parts[:-1], "workspace_symlink_write") if len(parts) > 1 else root.resolve()
    requested = parent / parts[-1]
    if requested.is_symlink():
        raise BackendError("workspace_symlink_write")
    if requested.exists() and not requested.is_file():
        raise BackendError("workspace_not_file")
    existed = requested.is_file()
    if existed and requested.stat().st_size > _WRITE_LIMIT:
        raise BackendError("file_too_large")
    try:
        previous = requested.read_bytes() if existed else b""
    except OSError as exc:
        raise _os_error(exc) from exc
    if existed:
        try:
            previous_text = previous.decode()
        except UnicodeDecodeError as exc:
            raise BackendError("file_not_text") from exc
        digest = hashlib.sha256(previous).hexdigest()
    else:
        previous_text = ""
        digest = ""
    if value.expected_digest != digest:
        raise BackendError("file_conflict")
    if existed and requested.stat().st_nlink > 1:
        raise BackendError("workspace_hardlink_write")
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    if not existed:
        flags |= os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(requested, flags, 0o644)
    except FileExistsError as exc:
        raise BackendError("file_conflict") from exc
    except OSError as exc:
        raise _os_error(exc) from exc
    try:
        info = os.fstat(fd)
        if not stat_is_file(info) or info.st_nlink > 1:
            raise BackendError("workspace_hardlink_write")
        current = os.pread(fd, info.st_size, 0)
        if existed:
            if hashlib.sha256(current).hexdigest() != value.expected_digest:
                raise BackendError("file_conflict")
        elif info.st_size:
            raise BackendError("file_conflict")
        os.ftruncate(fd, 0)
        try:
            _write_all(fd, payload)
            os.fsync(fd)
        except (OSError, BackendError) as exc:
            _restore(fd, previous)
            if isinstance(exc, OSError):
                raise _os_error(exc) from exc
            raise
    finally:
        os.close(fd)
    written = "/".join(parts)
    diff = "".join(difflib.unified_diff(
        previous_text.splitlines(keepends=True), value.content.splitlines(keepends=True),
        fromfile=written, tofile=written))
    return FileChange(path=written, digest=hashlib.sha256(payload).hexdigest(), diff=diff)


def stat_is_file(info: os.stat_result) -> bool:
    return stat.S_ISREG(info.st_mode)
