"""Bounded workspace discovery and text search through no-follow directory handles."""
from __future__ import annotations

import glob
import heapq
import os
import re
import stat
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from pathspec import GitIgnoreSpec

from amazme_backend.contracts.execution import FileGlob, FileGrep, FileSearchResult, SearchMatch
from amazme_backend.shared.errors import BackendError

_VCS = frozenset({".git", ".hg", ".svn", ".bzr", ".jj", ".sl"})


class _Limit(Exception):
    pass


def _pattern(value: str) -> re.Pattern[str]:
    if not value.strip() or value.startswith(("!", "/")) or ".." in PurePosixPath(value).parts or "\x00" in value:
        raise BackendError("search_pattern")
    variants = [value]
    while any("{" in item for item in variants):
        expanded: list[str] = []
        for item in variants:
            match = re.search(r"\{([^{}]+)\}", item)
            if match is None:
                if "{" in item:
                    raise BackendError("search_pattern")
                expanded.append(item)
                continue
            expanded.extend(item[:match.start()] + part + item[match.end():] for part in match[1].split(","))
            if len(expanded) > 32:
                raise BackendError("search_pattern")
        variants = expanded
    return re.compile("|".join(glob.translate(item if "/" in item else "**/" + item,
                                            recursive=True, include_hidden=True) for item in variants))


def search_files(root: Path, value: FileGlob | FileGrep, check: Callable[[], None]) -> FileSearchResult:
    selected = PurePosixPath(value.path)
    if selected.is_absolute() or ".." in selected.parts or "\x00" in value.path:
        raise BackendError("invalid_workspace_path")
    if any(part in _VCS for part in selected.parts):
        raise BackendError("search_vcs_excluded")
    matcher = _pattern(value.pattern) if isinstance(value, FileGlob) else None
    include = _pattern(value.include) if isinstance(value, FileGrep) and value.include else None
    try:
        expression = re.compile(value.pattern, re.IGNORECASE if value.ignore_case else 0) if isinstance(value, FileGrep) else None
    except re.error as error:
        raise BackendError("search_pattern", str(error)) from error
    # A literal prefix avoids traversing unrelated trees while preserving workspace-relative matching.
    parts = list(selected.parts)
    inferred = isinstance(value, FileGlob) and not parts
    if isinstance(value, FileGlob) and not parts:
        for part in value.pattern.split("/")[:-1]:
            if not re.fullmatch(r"[\w .-]+", part) or part in {".", "..", *_VCS}:
                break
            parts.append(part)
    visited = skipped = entries = scanned = match_count = payload = 0
    reason = ""
    matches: list[SearchMatch] = []
    newest: list[tuple[int, str]] = []

    def file(parent: int, name: str, path: str, info: os.stat_result) -> None:
        nonlocal visited, skipped, scanned, match_count, payload, reason
        visited += 1
        if matcher is not None:
            if matcher.fullmatch(path):
                match_count += 1
                heapq.heappush(newest, (info.st_mtime_ns, path))
                if len(newest) > 100:
                    heapq.heappop(newest)
            return
        if include is not None and not include.fullmatch(path):
            return
        if info.st_size > 16 * 1024 * 1024:
            skipped += 1
            return
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                skipped += 1
                return
            line_number = 0
            while raw := stream.readline(65537):
                check()
                line_number += 1
                scanned += len(raw)
                if scanned > 64 * 1024 * 1024:
                    reason = "byte_limit"
                    raise _Limit
                if len(raw) > 65536 or b"\x00" in raw:
                    skipped += 1
                    break
                try:
                    text = raw.decode("utf-8").rstrip("\r\n")
                except UnicodeDecodeError:
                    skipped += 1
                    break
                if expression is not None and expression.search(text):
                    preview = text.encode()[:2000].decode("utf-8", errors="ignore")
                    hit = SearchMatch(path=path, line=line_number, text=preview)
                    size = len(hit.model_dump_json().encode())
                    if len(matches) >= 250 or payload + size > 48000:
                        reason = "result_limit"
                        raise _Limit
                    matches.append(hit)
                    payload += size

    def rules(fd: int, prefix: str, ignores: list[tuple[str, GitIgnoreSpec]]) -> list[tuple[str, GitIgnoreSpec]]:
        nonlocal skipped
        if isinstance(value, FileGrep):
            try:
                ignore_fd = os.open(".gitignore", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(ignore_fd, "rb") as source:
                    if stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                        raw = source.read(65537)
                        if len(raw) > 65536:
                            skipped += 1
                        else:
                            ignores = [*ignores, (prefix, GitIgnoreSpec.from_lines(raw.decode().splitlines()))]
            except FileNotFoundError:
                pass
            except (OSError, UnicodeError):
                skipped += 1
        return ignores

    def walk(fd: int, prefix: str, depth: int, ignores: list[tuple[str, GitIgnoreSpec]]) -> None:
        nonlocal entries, skipped, reason
        check()
        if depth > 64:
            reason = "depth_limit"
            raise _Limit
        ignores = rules(fd, prefix, ignores)
        with os.scandir(fd) as listing:
            children: list[os.DirEntry[str]] = []
            for entry in listing:
                check()
                entries += 1
                if entries > 100000:
                    reason = "entry_limit"
                    raise _Limit
                children.append(entry)
        for entry in sorted(children, key=lambda child: child.name):
            check()
            if entry.name in _VCS or entry.is_symlink():
                continue
            if isinstance(value, FileGrep) and entry.name.startswith("."):
                continue
            path = prefix + entry.name
            try:
                path.encode("utf-8")
                info = entry.stat(follow_symlinks=False)
                directory = stat.S_ISDIR(info.st_mode)
                ignored = False
                for base, spec in ignores:
                    result = spec.check_file(path[len(base):] + ("/" if directory else "")).include
                    if result is not None:
                        ignored = result
                if ignored:
                    continue
                if directory:
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        walk(child, path + "/", depth + 1, ignores)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    file(fd, entry.name, path, info)
            except (OSError, UnicodeError):
                skipped += 1

    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        inherited: list[tuple[str, GitIgnoreSpec]] = []
        prefix = ""
        for part in parts[:-1]:
            inherited = rules(parent, prefix, inherited)
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            prefix += part + "/"
        if parts:
            inherited = rules(parent, prefix, inherited)
            name = parts[-1]
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    walk(child, "/".join(parts) + "/", 0, inherited)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                file(parent, name, "/".join(parts), info)
            else:
                raise BackendError("workspace_not_file")
        else:
            walk(parent, "", 0, [])
    except _Limit:
        pass
    except FileNotFoundError as error:
        if not inferred:
            raise BackendError("workspace_missing") from error
    except OSError as error:
        raise BackendError("search_path", str(error.strerror)) from error
    finally:
        os.close(parent)
    if matcher is not None:
        for _, path in sorted(newest, reverse=True):
            hit = SearchMatch(path=path)
            size = len(hit.model_dump_json().encode())
            if payload + size > 48000:
                break
            matches.append(hit)
            payload += size
        if match_count > len(matches):
            reason = reason or "result_limit"
    if skipped:
        reason = reason or "files_skipped"
    return FileSearchResult(matches=matches, truncated=bool(reason), visited_files=visited,
                            skipped_files=skipped, reason=reason)
