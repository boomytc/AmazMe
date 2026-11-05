"""Parse patch operations without reading or changing files.

Parser and text matching adapted from deepseek-harness fs-patch at ce7073d512,
following OpenAI Codex rust-v0.158.0. Copyright 2025 OpenAI. Apache-2.0
portions are covered by PATCH_LICENSE.txt; filesystem integration is AmazMe's.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Literal

from amazme_backend.shared.errors import BackendError


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
            if not path or PurePosixPath(path).is_absolute() or any(unicodedata.category(char) == "Cc" for char in path):
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
                if not operation.destination or PurePosixPath(operation.destination).is_absolute():
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
