"""Streamable HTTP transport inside the existing owned MCP gate."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
from pathlib import Path

import httpx
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage
from pydantic import JsonValue

from .common import Profile
from .contracts import BackendError, McpHttpSettings, McpTool
from .mcp_auth import http_settings
from .mcp_gate import CALL_IDENTITY_LIMIT, LIMIT, MESSAGE, VERSIONS, _catalog, _lines, _mapping, _send


class HttpGate:
    def __init__(self, incoming: MemoryObjectReceiveStream[SessionMessage | Exception], outgoing: MemoryObjectSendStream[SessionMessage], settings: McpHttpSettings):
        self.incoming, self.outgoing, self.settings = incoming, outgoing, settings
        self.responses: dict[str, asyncio.Future[dict[str, JsonValue]]] = {}
        self.progress: dict[str, float] = {}
        self.changed = asyncio.Event()
        self.failed = asyncio.Event()
        self.active: tuple[str, asyncio.Task[None]] | None = None
        self.seen: dict[str, tuple[str, dict[str, JsonValue] | None]] = {}
        self.sequence = 0
        self.version = ""

    async def send(self, value: dict[str, JsonValue]) -> None:
        await self.outgoing.send(SessionMessage(message=JSONRPCMessage.model_validate(value)))

    async def rpc(self, method: str, params: dict[str, JsonValue], request_id: str, timeout: float) -> dict[str, JsonValue]:
        future: asyncio.Future[dict[str, JsonValue]] = asyncio.get_running_loop().create_future()
        self.responses[request_id] = future
        self.progress[request_id] = time.monotonic()
        try:
            await self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            while not future.done():
                remaining = timeout - (time.monotonic() - self.progress[request_id])
                if remaining <= 0:
                    await self.cancel(request_id)
                    raise TimeoutError("MCP request timed out")
                await asyncio.wait([future], timeout=min(remaining, 1))
            return future.result()
        finally:
            self.responses.pop(request_id, None)
            self.progress.pop(request_id, None)

    async def read(self) -> None:
        async for packet in self.incoming:
            if isinstance(packet, Exception):
                raise packet
            raw = packet.message.model_dump_json(by_alias=True, exclude_none=True)
            if len(raw.encode()) > LIMIT:
                raise BackendError("mcp_message_too_large")
            message = MESSAGE.validate_json(raw)
            method = message.get("method")
            identity = message.get("id")
            if method is not None:
                if identity is not None:
                    await self.send({"jsonrpc": "2.0", "id": identity, **({"result": {}} if method == "ping" else {"error": {"code": -32601, "message": "Method not supported"}})})
                elif method == "notifications/tools/list_changed":
                    self.changed.set()
                elif method == "notifications/progress":
                    params = _mapping(message.get("params"))
                    token = params.get("progressToken")
                    if isinstance(token, str) and token in self.progress:
                        self.progress[token] = time.monotonic()
            elif isinstance(identity, str) and identity in self.responses:
                future = self.responses[identity]
                if not future.done():
                    future.set_result(message)
        raise EOFError("MCP HTTP stream closed")

    async def catalog(self) -> None:
        tools: list[McpTool] = []
        cursors: set[str] = set()
        params: dict[str, JsonValue] = {}
        while True:
            self.sequence += 1
            reply = await self.rpc("tools/list", params, f"catalog:{self.sequence}", 10)
            result = _mapping(reply.get("result"))
            tools.extend(_catalog(result))
            if len(tools) > 64 or len({tool.name for tool in tools}) != len(tools):
                raise BackendError("mcp_catalog_capacity")
            cursor = result.get("nextCursor")
            if cursor is None:
                _send(1, MESSAGE.validate_python({"op": "catalog", "tools": [tool.model_dump(mode="json") for tool in tools], "protocol_version": self.version}))
                return
            if not isinstance(cursor, str) or cursor in cursors or len(cursors) >= 64:
                raise BackendError("mcp_catalog_cursor")
            cursors.add(cursor)
            params = {"cursor": cursor}

    async def refresh(self) -> None:
        while True:
            await self.changed.wait()
            self.changed.clear()
            if self.active:
                await asyncio.shield(self.active[1])
            try:
                await self.catalog()
            except (BackendError, ValueError, TimeoutError):
                _send(1, {"op": "catalog_failed"})

    async def call(self, identity: str, name: str, arguments: dict[str, JsonValue], canonical: str) -> None:
        reply = await self.rpc("tools/call", {"name": name, "arguments": arguments, "_meta": {"progressToken": identity}}, identity, self.settings.timeout)
        error = "error" in reply
        result = _mapping(reply.get("error") if error else reply.get("result"))
        content = result.get("content")
        parts = [part.get("text") for part in content if isinstance(part, dict)] if isinstance(content, list) else []
        text = "\n".join(part for part in parts if isinstance(part, str)) or json.dumps(result, ensure_ascii=False)
        response: dict[str, JsonValue] = {"op": "result", "call_id": identity, "text": text[:8000], "data": result, "is_error": error or result.get("isError") is True}
        self.seen[identity] = canonical, response
        _send(1, response)

    async def cancel(self, identity: str) -> None:
        await self.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": identity, "reason": "User cancelled call"}})

    async def control(self) -> None:
        control = socket.socket(fileno=os.dup(0))
        control.setblocking(False)
        buffer = bytearray()
        try:
            while True:
                raw = await asyncio.get_running_loop().sock_recv(control, 65536)
                if not raw:
                    return
                buffer.extend(raw)
                for message in _lines(buffer):
                    op, identity = message.get("op"), message.get("call_id")
                    if op == "cancel":
                        if self.active:
                            await self.cancel(self.active[0])
                        return
                    if op == "cancel_call" and isinstance(identity, str):
                        if self.active and self.active[0] == identity:
                            await self.cancel(identity)
                        _send(1, {"op": "cancel_ack", "call_id": identity})
                        continue
                    name, arguments = message.get("name"), message.get("arguments")
                    if op != "call" or not isinstance(identity, str) or not isinstance(name, str) or not isinstance(arguments, dict):
                        raise BackendError("mcp_message_invalid")
                    canonical = json.dumps([name, arguments], sort_keys=True)
                    prior = self.seen.get(identity)
                    if prior:
                        if prior[0] != canonical:
                            _send(1, {"op": "conflict", "call_id": identity})
                        elif prior[1] is not None:
                            _send(1, prior[1])
                        continue
                    if self.active and not self.active[1].done():
                        _send(1, {"op": "busy", "call_id": identity})
                        continue
                    if len(self.seen) >= CALL_IDENTITY_LIMIT:
                        _send(1, {"op": "conflict", "call_id": identity})
                        continue
                    self.seen[identity] = canonical, None
                    task = asyncio.create_task(self.call(identity, name, arguments, canonical))
                    self.active = identity, task
                    task.add_done_callback(self.completed)
        finally:
            control.close()

    def completed(self, task: asyncio.Task[None]) -> None:
        if not task.cancelled() and task.exception() is not None:
            self.failed.set()

    async def run(self) -> None:
        tasks: list[asyncio.Task[None]] = [asyncio.create_task(self.read())]
        tasks[0].add_done_callback(self.completed)
        try:
            initialized = await self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "pi", "version": "0.1.0"}}, "initialize", 10)
            result = _mapping(initialized.get("result"))
            version = result.get("protocolVersion")
            if not isinstance(version, str) or version not in VERSIONS or not isinstance(result.get("serverInfo"), dict):
                raise BackendError("mcp_initialize_failed")
            self.version = version
            await self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            await self.catalog()
            tasks += [asyncio.create_task(self.refresh()), asyncio.create_task(self.control())]
            tasks[1].add_done_callback(self.completed)
            failed = asyncio.create_task(self.failed.wait())
            try:
                done, _pending = await asyncio.wait([tasks[2], failed], return_when=asyncio.FIRST_COMPLETED)
                if failed in done:
                    raise BackendError("mcp_transport_closed")
                await tasks[2]
            finally:
                failed.cancel()
        finally:
            if self.active:
                tasks.append(self.active[1])
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def run_http_gate(permit: dict[str, JsonValue]) -> int:
    if (permit.get("op") != "permit" or (permit.get("uid"), permit.get("gid")) != (os.getuid(), os.getgid())
            or not isinstance(permit.get("profile"), str) or not isinstance(permit.get("cwd"), str) or not isinstance(permit.get("name"), str)):
        return 125
    settings = McpHttpSettings.model_validate(permit.get("http"))
    profile = Profile(Path(str(permit["profile"])))
    headers, auth = await http_settings(settings, profile, str(permit["name"]), str(permit["cwd"]))
    for fd in (0, 1):
        os.set_blocking(fd, False)
    async with httpx.AsyncClient(headers=headers, auth=auth, timeout=httpx.Timeout(15, read=None), trust_env=False, follow_redirects=False) as client:
        async with streamable_http_client(settings.url, http_client=client) as (incoming, outgoing, _session):
            await HttpGate(incoming, outgoing, settings).run()
    _send(1, {"op": "exit", "code": 0})
    return 0
