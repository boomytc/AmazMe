"""Granted-workspace file browse and checked writes. No host shell and no symlink escape."""
from __future__ import annotations

import codecs
import difflib
import errno
import fcntl
import hashlib
import os
import secrets
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from amazme_backend.contracts.execution import AppliedFileChange
from amazme_backend.contracts.workspaces import (
    FILE_LIST_LIMIT,
    FILE_READ_LIMIT,
    FILE_WRITE_LIMIT,
    EditFile,
    FileChange,
    FileContent,
    FileEntry,
    FileList,
    FileWrite,
)
from amazme_backend.platform.private_files import copy_extended_metadata
from amazme_backend.shared.errors import BackendError


def applied_change(path: str, action: Literal["write", "delete"], diff: str, *,
                   operation: int = 0, limit: int = 16000) -> AppliedFileChange:
    payload = diff.encode()
    return AppliedFileChange(kind="applied", action=action, operation=operation, path=path,
                             diff=payload[:limit].decode(errors="ignore"), truncated=len(payload) > limit)


def file_diff(before: str, after: str, path: str, *, deleted: bool = False) -> str:
    lines = difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                 fromfile=path, tofile="/dev/null" if deleted else path)
    return "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n" for line in lines)


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
        try:
            if current.is_symlink():
                raise BackendError(symlink_code)
            if not current.exists():
                raise BackendError("workspace_missing", status=404)
            if not current.is_dir() or not current.resolve().is_relative_to(root.resolve()):
                raise BackendError("workspace_not_directory")
        except OSError as exc:
            raise _os_error(exc) from exc
    return current


def _kind(path: Path) -> str:
    if path.is_symlink():
        return "link"
    if path.is_dir():
        return "dir"
    if path.is_file():
        return "file"
    return "other"


def list_files(root: Path, relative: str = "", offset: int = 0) -> FileList:
    if offset < 0:
        raise BackendError("invalid_workspace_page")
    directory = root.resolve() if relative in {"", "."} else _walk(root, _parts(relative), "workspace_not_directory")
    if directory.is_symlink() or not directory.is_dir():
        raise BackendError("workspace_not_directory")
    try:
        children = sorted(directory.iterdir(), key=lambda item: item.name)
    except OSError as exc:
        raise _os_error(exc) from exc
    entries: list[FileEntry] = []
    for child in children[offset:offset + FILE_LIST_LIMIT]:
        try:
            entries.append(FileEntry(name=child.name, kind=_kind(child), size=child.lstat().st_size))
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise _os_error(exc) from exc
    shown = "" if relative in {"", "."} else relative.strip("/")
    return FileList(path=shown, entries=entries, truncated=len(children) > offset + FILE_LIST_LIMIT,
                    offset=offset, total=len(children))


def _text_prefix(data: bytes) -> str:
    try:
        return data.decode()
    except UnicodeDecodeError as exc:
        if exc.start > 0 and exc.end == len(data):
            return data[:exc.start].decode()
        raise BackendError("file_not_text") from exc


def _open_parent(root: Path, parts: list[str]) -> int:
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent
    except BaseException:
        os.close(parent)
        raise


def _stamp(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _hash_file(root: Path, parts: list[str], offset: int, limit: int,
               max_bytes: int | None) -> tuple[str, bytes, int]:
    parent = _open_parent(root, parts)
    try:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise BackendError("workspace_not_file")
        if max_bytes is not None and before.st_size > max_bytes:
            raise BackendError("file_too_large")
        digest = hashlib.sha256()
        decoder = codecs.getincrementaldecoder("utf-8")()
        total = 0
        while block := os.read(fd, 65536):
            total += len(block)
            if max_bytes is not None and total > max_bytes:
                raise BackendError("file_too_large")
            digest.update(block)
            decoder.decode(block)
        decoder.decode(b"", final=True)
        head = os.pread(fd, limit, offset)
        if _stamp(before) != _stamp(os.fstat(fd)) or total != before.st_size:
            raise BackendError("file_conflict")
        if offset > total or (offset and head and head[0] & 0xC0 == 0x80):
            raise BackendError("file_cursor")
        return digest.hexdigest(), head, total
    except UnicodeDecodeError as error:
        raise BackendError("file_not_text") from error
    finally:
        os.close(fd)


def capture_text(root: Path, relative: str) -> tuple[str, str] | None:
    """Capture complete text through directory handles without following write-path links."""
    parts = _parts(relative)
    try:
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as exc:
        raise _os_error(exc) from exc
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            except FileNotFoundError:
                return None
            os.close(parent)
            parent = child
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise BackendError("workspace_not_file")
            if info.st_nlink > 1:
                raise BackendError("workspace_hardlink_write")
            with os.fdopen(os.dup(fd), "rb") as stream:
                data = stream.read(FILE_WRITE_LIMIT + 1)
            if len(data) > FILE_WRITE_LIMIT:
                raise BackendError("checkpoint_unavailable")
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise BackendError("file_not_text") from exc
            return hashlib.sha256(data).hexdigest(), text
        finally:
            os.close(fd)
    except OSError as exc:
        raise _os_error(exc) from exc
    finally:
        os.close(parent)


def read_file(root: Path, relative: str, offset: int = 0, limit: int = FILE_READ_LIMIT, *,
              max_bytes: int | None = None) -> FileContent:
    if offset < 0 or not 4 <= limit <= FILE_READ_LIMIT:
        raise BackendError("invalid_workspace_page")
    parts = _parts(relative)
    if len(parts) > 1:
        _walk(root, parts[:-1], "workspace_not_directory")
    requested = root.resolve() / Path(*parts)
    if not requested.exists() and not requested.is_symlink():
        raise BackendError("workspace_missing", status=404)
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
        digest, head, total = _hash_file(root.resolve(), list(path.relative_to(root.resolve()).parts),
                                         offset, limit, max_bytes)
    except OSError as exc:
        raise _os_error(exc) from exc
    content = _text_prefix(head)
    following = offset + len(content.encode())
    return FileContent(path="/".join(parts), digest=digest, content=content,
                       truncated=offset > 0 or following < total, offset=offset,
                       next_offset=following, total_bytes=total, has_more=following < total)


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


def _mutate_file(root: Path, relative: str, expected_digest: str,
                 transform: Callable[[str], str]) -> FileChange:
    parts = _parts(relative)
    if len(parts) > 1:
        _walk(root, parts[:-1], "workspace_symlink_write")
    parent, original, stage = -1, -1, -1
    temporary = ".amazme-write-" + secrets.token_hex(16)
    published = False
    previous_text = ""
    try:
        parent = _open_parent(root, parts)
        before: os.stat_result | None = None
        if expected_digest:
            original = os.open(parts[-1], os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
            try:
                fcntl.flock(original, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise BackendError("file_conflict") from error
            before = os.fstat(original)
            if not stat.S_ISREG(before.st_mode):
                raise BackendError("workspace_not_file")
            if before.st_nlink > 1:
                raise BackendError("workspace_hardlink_write")
            previous = os.pread(original, FILE_WRITE_LIMIT + 1, 0)
            if len(previous) > FILE_WRITE_LIMIT:
                raise BackendError("file_too_large")
            try:
                previous_text = previous.decode()
            except UnicodeDecodeError as error:
                raise BackendError("file_not_text") from error
            if hashlib.sha256(previous).hexdigest() != expected_digest:
                raise BackendError("file_conflict")
        else:
            try:
                existing = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                if stat.S_ISLNK(existing.st_mode):
                    raise BackendError("workspace_symlink_write")
                if not stat.S_ISREG(existing.st_mode):
                    raise BackendError("workspace_not_file")
                raise BackendError("file_conflict")
        content = transform(previous_text)
        payload = content.encode()
        if len(payload) > FILE_WRITE_LIMIT:
            raise BackendError("file_too_large")
        stage = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600 if before is not None else 0o644, dir_fd=parent)
        _write_all(stage, payload)
        if before is not None:
            staged = os.fstat(stage)
            if (staged.st_uid, staged.st_gid) != (before.st_uid, before.st_gid):
                os.fchown(stage, before.st_uid, before.st_gid)
            copy_extended_metadata(original, stage)
            os.fchmod(stage, stat.S_IMODE(before.st_mode))
        os.fsync(stage)
        if before is not None:
            current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if _stamp(current) != _stamp(before) or _stamp(os.fstat(original)) != _stamp(before):
                raise BackendError("file_conflict")
            os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
        else:
            # Hard-link publication is atomic no-clobber even when another writer creates the name.
            os.link(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        published = True
        if before is None:
            os.unlink(temporary, dir_fd=parent)
        os.fsync(parent)
    except FileExistsError as error:
        raise BackendError("file_conflict") from error
    except OSError as error:
        if published:
            raise BackendError("file_outcome_unknown") from error
        raise _os_error(error) from error
    finally:
        for fd in (stage, original):
            if fd >= 0:
                os.close(fd)
        if parent >= 0:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
            finally:
                os.close(parent)
    written = "/".join(parts)
    diff = file_diff(previous_text, content, written)
    return FileChange(path=written, digest=hashlib.sha256(payload).hexdigest(), diff=diff)


def write_file(root: Path, value: FileWrite) -> FileChange:
    if len(value.content.encode()) > FILE_WRITE_LIMIT:
        raise BackendError("file_too_large")
    return _mutate_file(root, value.path, value.expected_digest, lambda _previous: value.content)


def delete_file(root: Path, relative: str, expected_digest: str) -> None:
    """Delete a regular file only at its prepared version, without following links."""
    parts = _parts(relative)
    parent = original = -1
    deleted = False
    try:
        parent = _open_parent(root, parts)
        original = os.open(parts[-1], os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        try:
            fcntl.flock(original, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BackendError("file_conflict") from error
        before = os.fstat(original)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink > 1:
            raise BackendError("workspace_not_file")
        data = os.pread(original, FILE_WRITE_LIMIT + 1, 0)
        if len(data) > FILE_WRITE_LIMIT:
            raise BackendError("file_too_large")
        if not expected_digest or hashlib.sha256(data).hexdigest() != expected_digest:
            raise BackendError("file_conflict")
        current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if _stamp(current) != _stamp(before) or _stamp(os.fstat(original)) != _stamp(before):
            raise BackendError("file_conflict")
        os.unlink(parts[-1], dir_fd=parent)
        deleted = True
        os.fsync(parent)
    except OSError as error:
        if deleted:
            raise BackendError("file_outcome_unknown") from error
        raise _os_error(error) from error
    finally:
        if original >= 0:
            os.close(original)
        if parent >= 0:
            os.close(parent)


def edit_file(root: Path, value: EditFile, expected_digest: str) -> FileChange:
    def replace(previous: str) -> str:
        matches = previous.count(value.old_string)
        if matches == 0:
            raise BackendError("file_edit_not_found")
        if matches > 1 and not value.replace_all:
            raise BackendError("file_edit_ambiguous")
        return previous.replace(value.old_string, value.new_string)
    if not expected_digest:
        raise BackendError("file_not_observed")
    return _mutate_file(root, value.path, expected_digest, replace)


def stat_is_file(info: os.stat_result) -> bool:
    return stat.S_ISREG(info.st_mode)
