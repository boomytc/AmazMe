"""Bounded local MCP control channel owned by the supervisor."""
from __future__ import annotations

import hashlib
import json
import socket
import time
from collections.abc import Callable

from pydantic import JsonValue

from amazme_backend.contracts.mcp import McpHttpSettings, McpTool
from amazme_backend.execution.mcp.gate import LIMIT, MESSAGE
from amazme_backend.execution.mcp.protocol import McpCatalog, McpResult
from amazme_backend.shared.errors import BackendError


class McpClient:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.sock.setblocking(False)
        self.buf = bytearray()
        self.tools: list[McpTool] = []
        self.results: dict[str, McpResult] = {}
        self.conflicts: set[str] = set()
        self.cancel_acks: set[str] = set()
        self.exit_code: int | None = None
        self.closed = self.ready = self.catalog_failed = False
        self.busy: set[str] = set()
        self.protocol_version = ""

    def permit(self, command: str, uid: int, gid: int, cwd: str, environment: dict[str, str] | None = None,
               environment_commands: dict[str, str] | None = None, timeout_seconds: float = 60,
               http: McpHttpSettings | None = None, profile: str = "", name: str = "") -> None:
        values: dict[str, JsonValue] = {key: value for key, value in (environment or {}).items()}
        commands: dict[str, JsonValue] = {key: value for key, value in (environment_commands or {}).items()}
        permit: dict[str, JsonValue] = {"op": "permit", "command": command, "uid": uid, "gid": gid, "cwd": cwd, "environment": values, "environment_commands": commands, "timeout_seconds": timeout_seconds}
        if http is not None:
            permit.update({"http": http.model_dump(mode="json", by_alias=True), "profile": profile, "name": name})
        self._send(permit)
        self.pump(20 if commands else 10, lambda: self.ready or self.closed or self.exit_code is not None)
        if not self.ready:
            raise BackendError("mcp_catalog_failed", status=503)

    def call(self, call_id: str, name: str, arguments: dict[str, JsonValue]) -> None:
        self._send({"op": "call", "call_id": call_id, "name": name, "arguments": arguments})

    def cancel(self) -> None:
        self._send({"op": "cancel"})
        self.pump(3.5, lambda: self.exit_code is not None or self.closed)

    def cancel_call(self, call_id: str) -> None:
        """Ask the server to cancel one JSON-RPC request. The service process stays up."""
        self._send({"op": "cancel_call", "call_id": call_id})
        self.pump(1, lambda: call_id in self.cancel_acks or self.closed or self.exit_code is not None)

    def pump(self, timeout: float, done: Callable[[], bool] | None = None) -> None:
        deadline = time.monotonic() + timeout
        while True:
            self._read()
            if (done is not None and done()) or self.closed or time.monotonic() >= deadline:
                return
            time.sleep(0.01)

    def _send(self, message: dict[str, JsonValue]) -> None:
        packet = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        if len(packet) > LIMIT:
            raise BackendError("mcp_message_too_large")
        offset, deadline = 0, time.monotonic() + 2
        while offset < len(packet):
            if time.monotonic() > deadline:
                raise BackendError("mcp_channel_backpressure", status=503)
            try:
                count = self.sock.send(packet[offset:])
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
                self.closed = True
                break
            self.buf.extend(part)
            if len(self.buf) > LIMIT:
                raise BackendError("mcp_message_too_large", status=503)
        while b"\n" in self.buf:
            line, _, rest = bytes(self.buf).partition(b"\n")
            self.buf[:] = rest
            if not line:
                continue
            body = MESSAGE.validate_json(line)
            op = body.get("op")
            if op == "catalog":
                catalog = McpCatalog.model_validate_json(line)
                self.tools, self.protocol_version, self.ready = catalog.tools, catalog.protocol_version, True
                self.catalog_failed = False
            elif op == "catalog_failed":
                self.catalog_failed = True
            elif op == "busy" and isinstance(body.get("call_id"), str):
                self.busy.add(str(body["call_id"]))
            elif op == "result":
                result = McpResult.model_validate_json(line)
                self.results[result.call_id] = result
            elif op == "conflict" and isinstance(body.get("call_id"), str):
                self.conflicts.add(str(body["call_id"]))
            elif op == "cancel_ack" and isinstance(body.get("call_id"), str):
                self.cancel_acks.add(str(body["call_id"]))
            elif op == "exit" and type(body.get("code")) is int:
                self.exit_code = int(str(body["code"]))
            else:
                raise BackendError("mcp_message_invalid", status=503)


def mcp_digest(server: str, command: str, workspace: str, build: str, name: str, arguments: dict[str, JsonValue]) -> str:
    body = json.dumps({"server": server, "command": command, "workspace": workspace, "build": build,
                       "name": name, "arguments": arguments}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()
