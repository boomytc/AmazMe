"""Python remote command daemon over SSH stdio; persist intent before running user code."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from typing import BinaryIO, cast

LIMIT = 65536


def identity() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def execute(command: str) -> str:
    process = subprocess.Popen(command, shell=True, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    output: list[bytearray] = [bytearray(), bytearray()]

    def drain(pipe: BinaryIO | None, buf: bytearray) -> None:
        if pipe is None:
            return
        try:
            while part := pipe.read(4096):
                buf.extend(part[:max(0, 16000 - len(buf))])
        finally:
            pipe.close()

    readers = [threading.Thread(target=drain, args=(pipe, buf), daemon=True)
               for pipe, buf in zip((process.stdout, process.stderr), output)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        timed_out = True
        # The directly owned process group is the limit of this stop request.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    for reader in readers:
        reader.join(2)
    return json.dumps({"exit_code": process.returncode, "stdout": output[0].decode(errors="replace"),
                       "stderr": output[1].decode(errors="replace"), "timed_out": timed_out,
                       "output_incomplete": any(reader.is_alive() for reader in readers)}, ensure_ascii=False)


def request(db: sqlite3.Connection, value: dict[str, object]) -> dict[str, object]:
    op, call_id = value.get("op"), value.get("call_id")
    if not isinstance(call_id, str) or re.fullmatch(r"[a-f0-9]{32}", call_id) is None:
        return {"op": "reject"}
    found = db.execute("SELECT command,result FROM calls WHERE id=?", (call_id,)).fetchone()
    if op in {"query", "cancel"}:
        if found is not None and found[1] is not None:
            return {"op": "result", "call_id": call_id, "text": found[1]}
        # Disconnect or a cancellation request cannot prove a remote process stopped.
        return {"op": "unknown", "call_id": call_id}
    command = value.get("command")
    if op != "call" or not isinstance(command, str) or not command or len(command) > 16000:
        return {"op": "reject"}
    if found is not None:
        if command != found[0]:
            return {"op": "conflict", "call_id": call_id}
        return {"op": "result", "call_id": call_id, "text": found[1]} if found[1] is not None else {
            "op": "unknown", "call_id": call_id}
    if int(db.execute("SELECT count(*) FROM calls").fetchone()[0]) >= 4096:
        return {"op": "unknown", "call_id": call_id}
    # A second connection may race this insert; only its winner executes.
    changed = db.execute("INSERT OR IGNORE INTO calls(id,command) VALUES(?,?)", (call_id, command)).rowcount
    db.commit()
    if not changed:
        return request(db, value)
    result = execute(command)
    db.execute("UPDATE calls SET result=? WHERE id=?", (result, call_id))
    db.commit()
    return {"op": "result", "call_id": call_id, "text": result}


def main() -> int:
    state = Path(sys.argv[1])
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.umask(0o077)
    db = sqlite3.connect(state / "receipts.sqlite3", timeout=5)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,command TEXT NOT NULL,result TEXT)")
    generation_path = state / "generation"
    if not generation_path.exists():
        generation_path.write_text("1")
    generation = int(generation_path.read_text())

    def send(value: dict[str, object]) -> None:
        sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    send({"op": "hello", "daemon_id": identity(), "generation": generation})
    try:
        while line := sys.stdin.buffer.readline(LIMIT + 1):
            if len(line) > LIMIT or not line.endswith(b"\n"):
                return 125
            value: object = json.loads(line)
            if not isinstance(value, dict):
                return 125
            send(request(db, {str(k): v for k, v in cast(dict[object, object], value).items()}))
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
