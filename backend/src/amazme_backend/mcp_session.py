"""MCP stdio client and the container spec the supervisor launches."""

from __future__ import annotations

import hashlib
import json
import socket
import time
from typing import Callable

from .contracts import BackendError


class McpClient:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.sock.setblocking(False)
        self.buf = bytearray()
        self.tools: list[dict[str, str]] = []
        self.results: dict[str, str] = {}
        self.conflicts: set[str] = set()
        self.exit_code: int | None = None

    def permit(self, command: str, uid: int, gid: int) -> None:
        self._send({"op": "permit", "command": command, "uid": uid, "gid": gid})
        self.pump(3, lambda: bool(self.tools) or self.exit_code is not None)
        if not self.tools:
            raise BackendError("mcp_catalog_failed", status=503)

    def call(self, call_id: str, name: str, arguments: dict[str, object]) -> None:
        self._send({"op": "call", "call_id": call_id, "name": name, "arguments": arguments})

    def cancel(self) -> None:
        self._send({"op": "cancel"})
        self.pump(2, lambda: self.exit_code is not None)

    def pump(self, timeout: float, done: Callable[[], bool] | None = None) -> None:
        deadline = time.monotonic() + timeout
        while True:
            self._read()
            if done is not None and done():
                return
            if time.monotonic() >= deadline:
                return
            time.sleep(0.01)

    def _send(self, message: dict[str, object]) -> None:
        packet = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        view = memoryview(packet)
        offset = 0
        while offset < len(view):
            try:
                count = self.sock.send(view[offset:])
            except BlockingIOError:
                self._read()
                time.sleep(0.01)
                continue
            if count <= 0:
                raise BackendError("mcp_channel_closed", status=503)
            offset += count

    def _read(self) -> None:
        while True:
            try:
                part = self.sock.recv(8192)
            except BlockingIOError:
                break
            if not part:
                break
            self.buf.extend(part)
        while b"\n" in self.buf:
            line, _, rest = bytes(self.buf).partition(b"\n")
            self.buf[:] = rest
            if not line:
                continue
            body = json.loads(line)
            op = body.get("op")
            if op == "catalog":
                self.tools = body["tools"]
            elif op == "result":
                self.results[body["call_id"]] = body["text"]
            elif op == "conflict":
                self.conflicts.add(body["call_id"])
            elif op == "exit":
                self.exit_code = int(body["code"])


def mcp_digest(name: str, arguments: dict[str, str]) -> str:
    body = json.dumps({"name": name, "arguments": arguments}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()
