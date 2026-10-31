"""Read-only checkout review; Git subprocess ownership stays in the native runner."""
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from amazme_backend.contracts.execution import GitChangedFile, GitDiff, GitDiffResult
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.files import file_diff, read_file

GitQuery = Callable[[Path, list[str], tuple[int, ...], bool], bytes]
DIFF_BYTES = 32000


def _text(value: bytes) -> str:
    try:
        return value.decode()
    except UnicodeError:
        raise BackendError("repository_path_encoding") from None


def repository_diff(root: Path, value: GitDiff, query: GitQuery, check: Callable[[], None]) -> GitDiffResult:
    check()
    root = root.resolve()
    parts = PurePosixPath(value.path).parts
    if PurePosixPath(value.path).is_absolute() or ".." in parts or "\x00" in value.path:
        raise BackendError("invalid_workspace_path")
    directory = root
    for part in parts:
        directory /= part
        if directory.is_symlink() or not directory.is_dir():
            raise BackendError("workspace_not_directory")
    checkout = Path(_text(query(directory, ["rev-parse", "--show-toplevel"], (0,), False)).removesuffix("\n")).resolve()
    if not checkout.is_relative_to(root):
        raise BackendError("repository_outside_workspace")

    def git(args: list[str], allowed: tuple[int, ...] = (0,), *, prefix: bool = False) -> bytes:
        return query(checkout, args, allowed, prefix)

    head = _text(git(["rev-parse", "--verify", "--quiet", "HEAD"], (0, 1))).strip()
    branch = _text(git(["symbolic-ref", "--quiet", "--short", "HEAD"], (0, 1))).removesuffix("\n")
    base = head or _text(git(["hash-object", "-t", "tree", "--stdin"])).strip()
    ranges = [base] if value.scope == "uncommitted" else ["--cached", base] if value.scope == "staged" else []
    # Git's clean/process filters can run even for diff; enumerate all drivers and disable them locally.
    filters = _text(git(["config", "--null", "--name-only", "--get-regexp", r"^filter\."], (0, 1))).split("\x00")
    overrides: list[str] = []
    for driver in sorted({key.rsplit(".", 1)[0] for key in filters if key.endswith((".clean", ".process"))}):
        overrides.extend(["-c", driver + ".clean=", "-c", driver + ".process=", "-c", driver + ".required=false"])
    diff = [*overrides, "diff", "--no-ext-diff", "--no-textconv", "--submodule=short", "--ignore-submodules=dirty", "--no-color", "-M", *ranges]
    names = iter(_text(git([*diff, "--name-status", "-z", "--"])).split("\x00"))
    files: list[GitChangedFile] = []
    try:
        for status in names:
            if not status:
                break
            original, path = (next(names), next(names)) if status[0] in {"R", "C"} else ("", next(names))
            files.append(GitChangedFile.model_validate({"path": path, "original_path": original, "status": status[0]}))
    except (StopIteration, ValueError):
        raise BackendError("repository_response_invalid") from None
    untracked = ([] if value.scope == "staged" else
                 [path for path in _text(git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\x00") if path])
    files.extend(GitChangedFile(path=path, status="?") for path in untracked)
    payload = git([*diff, "--src-prefix=a/", "--dst-prefix=b/", "--"], prefix=True)
    kept: list[GitChangedFile] = []
    metadata_bytes = 0
    for item in files:
        size = len(item.model_dump_json().encode())
        if len(kept) >= 200 or metadata_bytes + size > 32000:
            break
        kept.append(item)
        metadata_bytes += size
    truncated = len(payload) > DIFF_BYTES or len(kept) < len(files)
    reasons = ["diff_limit"] if len(payload) > DIFF_BYTES else []
    if len(kept) < len(files):
        reasons.append("file_limit")
    for path in untracked:
        check()
        if len(payload) > DIFF_BYTES:
            truncated = True
            if "diff_limit" not in reasons:
                reasons.append("diff_limit")
            break
        try:
            content = read_file(checkout, path, limit=DIFF_BYTES, max_bytes=1024 * 1024)
            if "\x00" in content.content[:8000]:
                raise BackendError("file_not_text")
            label = json.dumps(path, ensure_ascii=False) if any(ord(c) < 32 or c in '\\"' for c in path) else path
            payload += file_diff("", content.content, label).encode()
            if content.has_more:
                truncated = True
                reasons.append("untracked_content_limit")
        except BackendError as error:
            payload += (f"Untracked {json.dumps(path, ensure_ascii=False)}: {error.code}\n").encode()
            truncated = True
            reasons.append("untracked_not_read")
        check()
    if len(payload) > DIFF_BYTES:
        truncated = True
        if "diff_limit" not in reasons:
            reasons.append("diff_limit")
    return GitDiffResult(path=str(checkout), scope=value.scope, branch=branch, head=head,
                         total_files=len(files), files=kept, diff=payload[:DIFF_BYTES].decode(errors="ignore"),
                         truncated=truncated, reason=",".join(dict.fromkeys(reasons)))
