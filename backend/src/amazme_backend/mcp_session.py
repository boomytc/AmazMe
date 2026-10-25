"""Bounded local MCP control channel owned by the supervisor."""
from __future__ import annotations

import hashlib
import json
import socket
import time
from collections.abc import Callable
from typing import Literal

from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from .contracts import BackendError, McpTool, McpView, Model
from .mcp_gate import LIMIT, MESSAGE


class McpResult(Model):
    op: Literal["result"]
    call_id: str
    text: str
    data: dict[str, JsonValue]
    is_error: bool


class McpCatalog(Model):
    op: Literal["catalog"]
    tools: list[McpTool]
    protocol_version: str


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

    def permit(self, command: str, uid: int, gid: int, cwd: str, environment: dict[str, str] | None = None) -> None:
        values: dict[str, JsonValue] = {key: value for key, value in (environment or {}).items()}
        self._send({"op": "permit", "command": command, "uid": uid, "gid": gid, "cwd": cwd, "environment": values})
        self.pump(10, lambda: self.ready or self.closed or self.exit_code is not None)
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


class McpOffer(Model):
    alias: str = Field(pattern=r"^mcp_[a-f0-9]{20}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = Field(min_length=1, max_length=64)
    command: str = Field(min_length=1, max_length=16000)
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    description: str = ""
    input_schema: dict[str, JsonValue]
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


def schema_digest(schema: dict[str, JsonValue]) -> str:
    body = json.dumps(schema, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


def mcp_alias(server_id: str, name: str) -> str:
    return "mcp_" + hashlib.sha256(f"{server_id}\n{name}".encode()).hexdigest()[:20]


def catalog_payload(offers: list[McpOffer]) -> str:
    return json.dumps([item.model_dump(mode="json") for item in offers], ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def catalog_schema_digest(catalog: str, name: str) -> str:
    try:
        items = TypeAdapter(list[dict[str, JsonValue]]).validate_json(catalog)
    except (json.JSONDecodeError, ValidationError):
        return ""
    for item in items:
        schema = item.get("input_schema")
        if item.get("name") == name and isinstance(schema, dict):
            return schema_digest(schema)
    return ""


def offers_from_views(servers: list[McpView]) -> list[McpOffer]:
    """Tools the model may call. Only a ready server's stored catalog is offered."""
    offers: list[McpOffer] = []
    for server in servers:
        if server.phase != "ready" or not server.command or not server.workspace:
            continue
        for tool in server.tools:
            schema = tool.input_schema
            if schema.get("type") not in (None, "object"):
                continue
            offers.append(McpOffer(alias=mcp_alias(server.server_id, tool.name), server_id=server.server_id,
                                   workspace=server.workspace, command=server.command, name=tool.name,
                                   description=tool.description[:500], input_schema=schema,
                                   schema_digest=schema_digest(schema)))
    if len({item.alias for item in offers}) != len(offers):
        raise BackendError("mcp_catalog_conflict")
    return offers


def mcp_digest(server: str, command: str, workspace: str, build: str, name: str, arguments: dict[str, JsonValue]) -> str:
    body = json.dumps({"server": server, "command": command, "workspace": workspace, "build": build,
                       "name": name, "arguments": arguments}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()
