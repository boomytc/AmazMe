"""Codex patches, whole-request preflight, and ordered checked file mutations.

Parser and text matching adapted from deepseek-harness fs-patch at ce7073d512,
following OpenAI Codex rust-v0.158.0. Copyright 2025 OpenAI. Apache-2.0
portions are covered by PATCH_LICENSE.txt; filesystem integration is AmazMe's.
"""
from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from amazme_backend.contracts.execution import (
    ExecutedFileChange,
    FileAbsent,
    FileObservation,
    FilePresent,
    PatchBaseline,
    PatchDelete,
    PatchMutation,
    PatchTarget,
    PatchWrite,
    PreparedPatch,
    StoppedFileChange,
    ToolResult,
)
from amazme_backend.contracts.workspaces import FileWrite
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.files import applied_change, capture_text, delete_file, file_diff, write_file


@dataclass
class Hunk:
    line: int
    old: list[str] = field(default_factory=lambda: list[str]())
    new: list[str] = field(default_factory=lambda: list[str]())
    context: str | None = None
    eof: bool = False


@dataclass
class Operation:
    kind: Literal["add", "update", "delete"]
    path: str
    line: int
    content: str = ""
    destination: str | None = None
    hunks: list[Hunk] = field(default_factory=lambda: list[Hunk]())


def _syntax(line: int, reason: str) -> BackendError:
    return BackendError("patch_syntax", f"Patch line {line}: {reason}")


def parse_patch(patch: str) -> list[Operation]:
    if "\x00" in patch:
        raise BackendError("file_not_text")
    leading = patch[:len(patch) - len(patch.lstrip())].count("\n")
    lines = [(number + leading + 1, text.removesuffix("\r"))
             for number, text in enumerate(patch.strip().split("\n"))]
    if len(lines) >= 4 and lines[0][1] in {"<<EOF", "<<'EOF'", '<<"EOF"'} and lines[-1][1].endswith("EOF"):
        lines = lines[1:-1]
    if lines[0][1].strip() != "*** Begin Patch" or lines[-1][1].strip() != "*** End Patch":
        raise _syntax(lines[0][0], "expected *** Begin Patch and *** End Patch")
    operations: list[Operation] = []
    ended = False

    def finish() -> None:
        if operations and operations[-1].kind == "update":
            operation = operations[-1]
            if not operation.hunks or not (operation.hunks[-1].old or operation.hunks[-1].new):
                raise _syntax(operation.line, "update requires a nonempty hunk")

    for number, raw in lines[1:]:
        operation = operations[-1] if operations else None
        text = raw.rstrip() if operation and operation.kind == "update" else raw.strip()
        if ended:
            if raw.strip() and number != lines[-1][0]:
                raise _syntax(number, "unexpected content after *** End Patch")
            continue
        header = next((kind for kind in ("Add", "Update", "Delete") if text.startswith(f"*** {kind} File: ")), None)
        if text.strip() == "*** End Patch":
            finish()
            ended = True
        elif header is not None:
            finish()
            path = text[len(f"*** {header} File: "):]
            if not path or Path(path).is_absolute() or any(unicodedata.category(char) == "Cc" for char in path):
                raise _syntax(number, "invalid file path")
            if len(operations) >= 16:
                raise BackendError("patch_capacity", "Split patches containing more than 16 file operations.")
            kind: Literal["add", "update", "delete"] = "add" if header == "Add" else "update" if header == "Update" else "delete"
            operations.append(Operation(kind, path, number))
        elif operation and operation.kind == "add" and raw.startswith("+"):
            operation.content += raw[1:] + "\n"
        elif operation and operation.kind == "update":
            previous = operation.hunks[-1] if operation.hunks else None
            marker = text == "@@" or text.startswith("@@ ")
            if previous and previous.eof:
                if not text:
                    continue
                if not marker:
                    raise _syntax(number, "expected @@ after *** End of File")
            if previous is None and operation.destination is None and text.startswith("*** Move to: "):
                operation.destination = text[len("*** Move to: "):]
                if not operation.destination or Path(operation.destination).is_absolute():
                    raise _syntax(number, "move destination requires a workspace-relative path")
            elif marker:
                if previous is not None and not (previous.old or previous.new):
                    raise _syntax(number, "empty update hunk")
                operation.hunks.append(Hunk(number, context=text[3:] if text.startswith("@@ ") else None))
            elif text == "*** End of File":
                if previous is not None:
                    if not (previous.old or previous.new):
                        raise _syntax(number, "empty update hunk")
                    previous.eof = True
            elif not raw or raw[0] in " +-":
                if previous is None:
                    previous = Hunk(number)
                    operation.hunks.append(previous)
                if not raw.startswith("+"):
                    previous.old.append(raw[1:])
                if not raw.startswith("-"):
                    previous.new.append(raw[1:])
            else:
                raise _syntax(number, "expected context, added, or removed line")
        else:
            raise _syntax(number, "expected Add File, Update File, or Delete File")
    return operations


_PUNCTUATION = str.maketrans({**dict.fromkeys("‐‑‒–—―−", "-"), **dict.fromkeys("‘’‚‛", "'"),
                            **dict.fromkeys("“”„‟", '"'), **dict.fromkeys("\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000", " ")})


def _seek(lines: list[str], pattern: list[str], start: int, eof: bool) -> int | None:
    if not pattern:
        return start
    last = len(lines) - len(pattern)
    normalizers: tuple[Callable[[str], str], ...] = (
        lambda value: value, str.rstrip, str.strip, lambda value: value.strip().translate(_PUNCTUATION),
    )
    for normalize in normalizers:
        expected = [normalize(value) for value in pattern]
        if eof:
            if last >= 0 and [normalize(value) for value in lines[last:]] == expected:
                return last
            continue
        # KMP retains progress through repeated context lines without rescanning them.
        prefixes = [0] * len(expected)
        matched = 0
        for index in range(1, len(expected)):
            while matched and expected[index] != expected[matched]:
                matched = prefixes[matched - 1]
            if expected[index] == expected[matched]:
                matched += 1
            prefixes[index] = matched
        matched = 0
        for index in range(start, len(lines)):
            value = normalize(lines[index])
            while matched and value != expected[matched]:
                matched = prefixes[matched - 1]
            if value == expected[matched]:
                matched += 1
            if matched == len(expected):
                return index - matched + 1
    return None


def apply_hunks(before: str, hunks: list[Hunk]) -> str:
    original = before.replace("\r\n", "\n").split("\n")
    if original[-1] == "":
        original.pop()
    cursor = 0
    replacements: list[tuple[int, int, list[str]]] = []
    for hunk in hunks:
        if hunk.context is not None:
            found = _seek(original, [hunk.context], cursor, False)
            if found is None:
                raise BackendError("patch_mismatch", f"Patch line {hunk.line}: context anchor not found.")
            cursor = found + 1
        if not hunk.old:
            replacements.append((len(original) - int(bool(original) and original[-1] == ""), 0, hunk.new))
            continue
        old, new = hunk.old, hunk.new
        found = _seek(original, old, cursor, hunk.eof)
        if found is None and old[-1] == "":
            old = old[:-1]
            new = new[:-1] if new and new[-1] == "" else new
            found = _seek(original, old, cursor, hunk.eof)
        if found is None:
            raise BackendError("patch_mismatch", f"Patch line {hunk.line}: old content not found.")
        replacements.append((found, len(old), new))
        cursor = found + len(old)
    for start, length, replacement in reversed(sorted(replacements, key=lambda item: item[0])):
        original[start:start + length] = replacement
    if not original or original[-1] != "":
        original.append("")
    return "\n".join(original)


def _digest(content: str | None) -> str:
    return "" if content is None else hashlib.sha256(content.encode()).hexdigest()


@dataclass
class _State:
    target: PatchTarget
    initial: str | None
    current: str | None
    touched: bool = False


@dataclass(frozen=True)
class PatchPreparation:
    plan: PreparedPatch
    snapshots: list[tuple[PatchBaseline, str | None]]


def prepare_patch(call_id: str, operations: list[Operation], targets: Mapping[str, PatchTarget],
                  observations: Mapping[str, FileObservation]) -> PatchPreparation:
    states: dict[tuple[str, str], _State] = {}
    mutations: list[PatchMutation] = []

    def state(raw: str) -> _State:
        target = targets[raw]
        key = target.root, target.relative
        if key not in states:
            captured = capture_text(Path(target.root), target.relative)
            content = captured[1] if captured is not None else None
            if content is not None and "\x00" in content:
                raise BackendError("file_not_text")
            states[key] = _State(target, content, content)
        return states[key]

    def observed(value: _State, *, source: bool) -> None:
        if source and value.current is None:
            raise BackendError("workspace_missing")
        if value.touched:
            return
        observation = observations.get(value.target.path)
        if observation is not None and observation.root != value.target.root:
            raise BackendError("file_observation_mismatch")
        if isinstance(observation, FilePresent):
            if _digest(value.current) != observation.digest:
                raise BackendError("file_conflict")
        elif value.current is not None:
            raise BackendError("file_conflict" if observation is not None else "file_not_observed")

    def write(value: _State, content: str, operation: int) -> None:
        if "\x00" in content:
            raise BackendError("file_not_text")
        mutations.append(PatchWrite(**value.target.model_dump(), expected_digest=_digest(value.current),
                                    content=content, operation=operation))
        value.current, value.touched = content, True

    def delete(value: _State, operation: int) -> None:
        mutations.append(PatchDelete(**value.target.model_dump(), expected_digest=_digest(value.current), operation=operation))
        value.current, value.touched = None, True

    for index, operation in enumerate(operations):
        current = state(operation.path)
        observed(current, source=operation.kind != "add")
        if operation.kind == "add":
            write(current, operation.content, index)
        elif operation.kind == "delete":
            delete(current, index)
        else:
            assert current.current is not None
            content = apply_hunks(current.current, operation.hunks)
            if operation.destination is None:
                write(current, content, index)
            else:
                destination = state(operation.destination)
                if destination is current:
                    raise BackendError("patch_same_target")
                observed(destination, source=False)
                write(destination, content, index)
                delete(current, index)
    snapshots = [(PatchBaseline(**value.target.model_dump(), expected_digest=_digest(value.initial)), value.initial)
                 for value in states.values()]
    plan = PreparedPatch(call_id=call_id, baselines=[item[0] for item in snapshots], mutations=mutations)
    return PatchPreparation(plan, snapshots)


def _parents(target: PatchTarget, created: list[str]) -> None:
    parent = -1
    relative = Path(target.relative)
    traversed = Path(target.root)
    try:
        parent = os.open(target.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for part in relative.parts[:-1]:
            traversed /= part
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            except FileNotFoundError:
                try:
                    os.mkdir(part, dir_fd=parent)
                except FileExistsError:
                    pass
                else:
                    created.append(str(traversed))
                    try:
                        os.fsync(parent)
                    except OSError as error:
                        raise BackendError("file_outcome_unknown") from error
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
    except OSError as error:
        raise BackendError("workspace_write_failed") from error
    finally:
        if parent >= 0:
            os.close(parent)


def execute_patch(plan: PreparedPatch) -> ToolResult:
    """Recheck every initial file before effects, then stop on the first failed mutation."""
    contents: dict[tuple[str, str], str] = {}
    for baseline in plan.baselines:
        captured = capture_text(Path(baseline.root), baseline.relative)
        if (captured[0] if captured is not None else "") != baseline.expected_digest:
            raise BackendError("file_conflict")
        contents[baseline.root, baseline.relative] = captured[1] if captured else ""
    observations: dict[str, FileObservation] = {}
    records: list[dict[str, str | int]] = []
    created: list[str] = []
    failed = ""
    changes: list[ExecutedFileChange] = []
    remaining = 16000
    for mutation in plan.mutations:
        record: dict[str, str | int] = {"operation": mutation.operation, "kind": mutation.kind, "path": mutation.path}
        if failed:
            records.append({**record, "status": "skipped"})
            changes.append(StoppedFileChange(kind="skipped", action=mutation.kind, path=mutation.path,
                                             operation=mutation.operation))
            continue
        try:
            if isinstance(mutation, PatchWrite):
                if not mutation.expected_digest:
                    _parents(mutation, created)
                changed = write_file(Path(mutation.root), FileWrite(path=mutation.relative, content=mutation.content,
                                                                   expected_digest=mutation.expected_digest))
                observations[mutation.path] = FilePresent(path=mutation.path, root=mutation.root, digest=changed.digest)
                diff = changed.diff
                contents[mutation.root, mutation.relative] = mutation.content
            else:
                delete_file(Path(mutation.root), mutation.relative, mutation.expected_digest)
                observations[mutation.path] = FileAbsent(path=mutation.path, root=mutation.root)
                diff = file_diff(contents[mutation.root, mutation.relative], "", mutation.path, deleted=True)
                contents[mutation.root, mutation.relative] = ""
            applied = applied_change(mutation.path, mutation.kind, diff, operation=mutation.operation, limit=remaining)
            changes.append(applied)
            remaining -= len(applied.diff.encode())
            records.append({**record, "status": "completed"})
        except BackendError as error:
            if error.code == "file_outcome_unknown":
                raise
            failed = error.code
            records.append({**record, "status": "failed", "error": failed})
            changes.append(StoppedFileChange(kind="failed", action=mutation.kind, path=mutation.path,
                                             operation=mutation.operation, error=failed))
    return ToolResult(call_id=plan.call_id, exit_code=1 if failed else 0,
                      stdout=json.dumps({"phase": "commit", "outcomes": records, "created_directories": created}, ensure_ascii=False), stderr=failed,
                      file_observations=list(observations.values()), file_changes=changes)
