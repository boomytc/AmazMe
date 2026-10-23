"""Fixed plugin entry. It stamps one line in its working directory and then exits.

The supervisor starts this program. It has no shell, no SQLite, and no path from
plugin configuration.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import cast


def main() -> None:
    try:
        loaded: object = json.loads(sys.stdin.readline() or "")
    except json.JSONDecodeError:
        raise SystemExit(2) from None
    if not isinstance(loaded, dict):
        raise SystemExit(2)
    permit = cast(dict[object, object], loaded)
    text = permit.get("text")
    if permit.get("capability") != "stamp" or not isinstance(text, str) or not text or len(text) > 200 or "\n" in text or "\x00" in text:
        raise SystemExit(2)
    root = Path(".").resolve()
    target = (root / "stamp.txt").resolve()
    if target.parent != root:
        raise SystemExit(2)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, (text + "\n").encode())
    finally:
        os.close(fd)
    sys.stdout.write(json.dumps({"ok": True}) + "\n")


if __name__ == "__main__":
    main()
