"""Remote daemon. A dropped client connection does not stop the process or erase receipts."""

from __future__ import annotations

import hashlib
import json
import socket
import sys
from pathlib import Path
from typing import cast

LIMIT = 65536


def identity() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _load(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        return {}
    loaded = cast(dict[object, object], value)
    receipts: dict[str, dict[str, str]] = {}
    for key, item in loaded.items():
        if not isinstance(item, dict):
            continue
        body = cast(dict[object, object], item)
        command = body.get("command")
        result = body.get("result")
        if isinstance(key, str) and isinstance(command, str) and isinstance(result, str):
            receipts[key] = {"command": command, "result": result}
    return receipts


def _save(path: Path, receipts: dict[str, dict[str, str]]) -> None:
    path.write_text(json.dumps(receipts, ensure_ascii=False, sort_keys=True))


def _line(buf: bytearray) -> bytes | None:
    if b"\n" not in buf:
        if len(buf) > LIMIT:
            raise SystemExit(125)
        return None
    line, _, rest = bytes(buf).partition(b"\n")
    buf[:] = rest
    return line


def _send(conn: socket.socket, message: dict[str, object]) -> None:
    conn.sendall((json.dumps(message, ensure_ascii=False) + "\n").encode())


def _apply(state: Path, call_id: str, command: str) -> dict[str, object]:
    path = state / "receipts.json"
    receipts = _load(path)
    current = receipts.get(call_id)
    if current is not None:
        if current["command"] != command:
            return {"op": "conflict", "call_id": call_id}
        return {"op": "result", "call_id": call_id, "text": current["result"]}
    with (state / "effects.txt").open("a") as handle:
        handle.write(command + "\n")
    text = "ran:" + command
    receipts[call_id] = {"command": command, "result": text}
    _save(path, receipts)
    return {"op": "result", "call_id": call_id, "text": text}


def _query(state: Path, call_id: str) -> dict[str, object]:
    current = _load(state / "receipts.json").get(call_id)
    if current is None:
        return {"op": "unknown", "call_id": call_id}
    return {"op": "result", "call_id": call_id, "text": current["result"]}


def _serve_connection(conn: socket.socket, state: Path) -> None:
    host_key = (state / "host_key").read_text().strip()
    generation = int((state / "generation").read_text().strip())
    _send(conn, {"op": "hello", "host_key": host_key, "daemon_id": identity(), "generation": generation})
    buf = bytearray()
    while True:
        part = conn.recv(4096)
        if not part:
            return
        buf.extend(part)
        while True:
            line = _line(buf)
            if line is None:
                break
            if not line:
                continue
            message = json.loads(line)
            op = message.get("op")
            call_id = message.get("call_id")
            if not isinstance(call_id, str):
                _send(conn, {"op": "reject"})
                continue
            if op == "call" and isinstance(message.get("command"), str):
                reply = _apply(state, call_id, message["command"])
                if message["command"] == "drop":
                    return
                _send(conn, reply)
            elif op == "query":
                _send(conn, _query(state, call_id))
            elif op == "cancel":
                # A finished receipt stays. No receipt means the stop is unproven.
                known = _query(state, call_id)
                _send(conn, known if known["op"] == "result" else {"op": "unknown", "call_id": call_id})
            else:
                _send(conn, {"op": "reject"})


def serve(state: Path) -> None:
    state.mkdir(parents=True, exist_ok=True)
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    port = sock.getsockname()[1]
    (state / "port").write_text(str(port))
    while True:
        conn, _ = sock.accept()
        try:
            _serve_connection(conn, state)
        except (OSError, json.JSONDecodeError, SystemExit):
            pass
        finally:
            conn.close()


def main() -> int:
    state = Path(sys.argv[1])
    state.mkdir(parents=True, exist_ok=True)
    key = state / "host_key"
    generation = state / "generation"
    if not key.exists():
        key.write_text(sys.argv[2])
    if not generation.exists():
        generation.write_text(sys.argv[3])
    serve(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
