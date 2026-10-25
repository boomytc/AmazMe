"""Native MCP stdio gate: initialize, catalog, approved calls, explicit shutdown."""
from __future__ import annotations

import contextlib
import json
import os
import pwd
import select
import subprocess
import time
from typing import cast

from pydantic import JsonValue, TypeAdapter

from .contracts import McpLaunch, McpTool
from .native_execution import tool_environment

LIMIT = 262144
CALL_IDENTITY_LIMIT = 4096
VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
MESSAGE = TypeAdapter(dict[str, JsonValue])


def _mapping(value: JsonValue) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise ValueError("MCP object required")
    return value


def _send(fd: int, value: dict[str, JsonValue]) -> None:
    packet = (json.dumps(value, ensure_ascii=False) + "\n").encode()
    if len(packet) > LIMIT:
        raise ValueError("MCP message exceeds limit")
    offset, deadline = 0, time.monotonic() + 2
    while offset < len(packet):
        if time.monotonic() > deadline:
            raise TimeoutError("MCP write stalled")
        try:
            count = os.write(fd, packet[offset:])
        except BlockingIOError:
            select.select([], [fd], [], .05)
            continue
        if count <= 0:
            raise BrokenPipeError()
        offset += count


def _lines(buffer: bytearray) -> list[dict[str, JsonValue]]:
    result: list[dict[str, JsonValue]] = []
    while b"\n" in buffer:
        line, _, rest = bytes(buffer).partition(b"\n")
        buffer[:] = rest
        if len(line) > LIMIT:
            raise ValueError("MCP message exceeds limit")
        if line:
            result.append(MESSAGE.validate_json(line))
    if len(buffer) > LIMIT:
        raise ValueError("MCP message exceeds limit")
    return result


def _catalog(value: dict[str, JsonValue]) -> list[McpTool]:
    entries = value.get("tools")
    if not isinstance(entries, list):
        raise ValueError("MCP tools list missing")
    tools: list[McpTool] = []
    for entry in entries:
        tool = _mapping(entry)
        schema = _mapping(tool.get("inputSchema"))
        name = tool.get("name")
        if schema.get("type") != "object" or not isinstance(name, str):
            raise ValueError("MCP inputSchema or name invalid")
        tools.append(McpTool(name=name, description=str(tool.get("description", ""))[:2000], input_schema=schema))
    return tools


def _stop_server(server: subprocess.Popen[bytes]) -> int:
    if server.stdin and not server.stdin.closed:
        server.stdin.close()
    for action, delay in ((None, .3), (server.terminate, .5), (server.kill, 2)):
        if server.poll() is not None:
            return server.returncode
        if action:
            action()
        try:
            return server.wait(timeout=delay)
        except subprocess.TimeoutExpired:
            pass
    raise TimeoutError("MCP process exit unconfirmed")


def _environment(launch: McpLaunch, shell: str, cwd: str) -> dict[str, str]:
    environment = {**tool_environment(), **launch.environment}
    deadline = time.monotonic() + 10
    cached: dict[str, str] = {}
    for key, command in launch.environment_commands.items():
        if command not in cached:
            process = subprocess.Popen([shell, "-c", command], cwd=cwd, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
            assert process.stdout is not None
            fd, output = process.stdout.fileno(), bytearray()
            os.set_blocking(fd, False)
            try:
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("MCP environment command timed out")
                    readable, _, _ = select.select([fd], [], [], .05)
                    if not readable:
                        continue
                    part = os.read(fd, 4096)
                    if not part:
                        break
                    output.extend(part)
                    if len(output) > 16384:
                        raise ValueError("MCP environment command output exceeds limit")
                process.wait(timeout=max(.01, deadline - time.monotonic()))
                if process.returncode != 0:
                    raise ValueError("MCP environment command failed")
                cached[command] = output.decode().strip()
                if not cached[command]:
                    raise ValueError("MCP environment command returned no value")
            finally:
                _stop_server(process)
                process.stdout.close()
        environment[key] = cached[command]
    return environment


def main() -> int:
    control = bytearray()
    while b"\n" not in control:
        data = os.read(0, 4096)
        if not data:
            return 125
        control.extend(data)
        if len(control) > LIMIT:
            return 125
    messages = _lines(control)
    if len(messages) != 1:
        return 125
    permit = messages[0]
    command, cwd = permit.get("command"), permit.get("cwd")
    if (set(permit) != {"op", "command", "cwd", "uid", "gid", "environment", "environment_commands", "timeout_seconds"} or permit["op"] != "permit"
            or (permit["uid"], permit["gid"]) != (os.getuid(), os.getgid())
            or not isinstance(command, str) or not command or len(command) > 16000 or "\0" in command
            or not isinstance(cwd, str) or not os.path.isabs(cwd) or "\0" in cwd):
        return 125
    try:
        launch = McpLaunch.model_validate({"command": command, "cwd": cwd, "environment": permit["environment"], "environment_commands": permit["environment_commands"], "timeout_seconds": permit["timeout_seconds"]})
    except ValueError:
        return 125
    shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
    server = subprocess.Popen([shell, "-c", command], cwd=cwd, env=_environment(launch, shell, cwd),
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              start_new_session=True)
    assert server.stdin is not None and server.stdout is not None
    writer, reader = server.stdin.fileno(), server.stdout.fileno()
    for fd in (0, 1, writer, reader):
        os.set_blocking(fd, False)
    inbox = bytearray()
    number = 1
    waiting: tuple[str, int, str] | None = None
    call_deadline = 0.0
    seen: dict[str, tuple[str, dict[str, JsonValue]]] = {}
    tools: list[McpTool] = []
    cursors: set[str] = set()
    phase: str = str("initialize")
    version = ""
    pending_refresh = False
    deadline = time.monotonic() + 10
    refresh_deadline = 0.0

    def request(method: str, params: dict[str, JsonValue]) -> int:
        nonlocal number
        current = number
        number += 1
        _send(writer, {"jsonrpc": "2.0", "id": current, "method": method, "params": params})
        return current

    def begin_list(next_phase: str) -> None:
        nonlocal phase, tools, cursors, expected, refresh_deadline
        tools = []
        cursors = set()
        phase = next_phase
        if next_phase == "refresh":
            refresh_deadline = time.monotonic() + 10
        expected = request("tools/list", {})

    def finish_list() -> None:
        nonlocal phase, pending_refresh
        _send(1, {"op": "catalog", "tools": cast(list[JsonValue], [t.model_dump() for t in tools]), "protocol_version": version})
        phase = "ready"
        if pending_refresh:
            pending_refresh = False
            begin_list("refresh")

    def fail_refresh() -> None:
        """A changed list that cannot be read leaves the last published catalog in place."""
        nonlocal phase, pending_refresh
        _send(1, {"op": "catalog_failed"})
        phase = "ready"
        if pending_refresh:
            pending_refresh = False
            begin_list("refresh")

    try:
        expected = request("initialize", {"protocolVersion": "2025-11-25",
                                          "capabilities": {"tools": {"listChanged": True}},
                                          "clientInfo": {"name": "amazme", "version": "0.1.0"}})
        while True:
            readable, _, _ = select.select([0, reader], [], [], .05)
            if waiting is not None and time.monotonic() >= call_deadline:
                _send(writer, {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": waiting[1], "reason": "Request timed out"}})
                return 125
            if phase == "refresh" and time.monotonic() > refresh_deadline:
                fail_refresh()
                continue
            if phase in {"initialize", "catalog"} and time.monotonic() > deadline:
                raise TimeoutError("MCP initialization timed out")
            if 0 in readable:
                data = os.read(0, 4096)
                if not data:
                    return 125
                control.extend(data)
                for message in _lines(control):
                    op = message.get("op")
                    if op == "cancel":
                        if waiting is not None:
                            _send(writer, {"jsonrpc": "2.0", "method": "notifications/cancelled",
                                           "params": {"requestId": waiting[1], "reason": "User stopped service"}})
                        code = _stop_server(server)
                        _send(1, {"op": "exit", "code": code})
                        return code
                    if op == "cancel_call":
                        target = message.get("call_id")
                        if not isinstance(target, str):
                            raise ValueError("MCP cancel shape invalid")
                        if waiting is not None and waiting[0] == target:
                            _send(writer, {"jsonrpc": "2.0", "method": "notifications/cancelled",
                                           "params": {"requestId": waiting[1], "reason": "User cancelled call"}})
                        _send(1, {"op": "cancel_ack", "call_id": target})
                        continue
                    if op == "call" and phase != "ready":
                        refused = message.get("call_id")
                        if isinstance(refused, str):
                            _send(1, {"op": "busy", "call_id": refused})
                        continue
                    if op != "call" or phase != "ready":
                        raise ValueError("MCP call before ready")
                    call_id, name, arguments = message.get("call_id"), message.get("name"), message.get("arguments")
                    if not isinstance(call_id, str) or not isinstance(name, str) or not isinstance(arguments, dict):
                        raise ValueError("MCP call shape invalid")
                    canonical = json.dumps({"name": name, "arguments": arguments}, sort_keys=True, ensure_ascii=False)
                    previous = seen.get(call_id)
                    if previous is not None:
                        _send(1, previous[1] if previous[0] == canonical else {"op": "conflict", "call_id": call_id})
                        continue
                    if waiting is not None:
                        raise ValueError("MCP call capacity")
                    if len(seen) >= CALL_IDENTITY_LIMIT:
                        # Keep every sent identity. A full history refuses the new id and does not stop the service.
                        _send(1, {"op": "conflict", "call_id": call_id})
                        continue
                    waiting = (call_id, request("tools/call", {"name": name, "arguments": arguments, "_meta": {"progressToken": number}}), canonical)
                    call_deadline = time.monotonic() + launch.timeout_seconds
            if reader in readable:
                data = os.read(reader, 4096)
                if not data:
                    code = server.wait(timeout=2)
                    _send(1, {"op": "exit", "code": code})
                    return code
                inbox.extend(data)
                for message in _lines(inbox):
                    if message.get("jsonrpc") != "2.0":
                        raise ValueError("Invalid JSON-RPC version")
                    if "method" in message:
                        if "id" not in message:
                            params = message.get("params")
                            if (message.get("method") == "notifications/progress" and waiting is not None
                                    and isinstance(params, dict) and params.get("progressToken") == waiting[1]):
                                call_deadline = time.monotonic() + launch.timeout_seconds
                            if (message.get("method") == "notifications/tools/list_changed"
                                    and phase in {"catalog", "refresh", "ready"}):
                                if phase == "ready" and waiting is None:
                                    begin_list("refresh")
                                else:
                                    pending_refresh = True
                            continue
                        reply: dict[str, JsonValue] = {"jsonrpc": "2.0", "id": message["id"]}
                        reply["result" if message["method"] == "ping" else "error"] = {} if message["method"] == "ping" else {"code": -32601, "message": "Method not supported"}
                        _send(writer, reply)
                        continue
                    if phase == "initialize":
                        if message.get("id") != expected or "result" not in message:
                            raise ValueError("MCP initialize failed")
                        result = _mapping(message["result"])
                        raw_version = result.get("protocolVersion")
                        if not isinstance(raw_version, str) or raw_version not in VERSIONS or not isinstance(result.get("serverInfo"), dict):
                            raise ValueError("MCP version unsupported")
                        version = raw_version
                        _send(writer, {"jsonrpc": "2.0", "method": "notifications/initialized"})
                        begin_list("catalog")
                    elif phase in {"catalog", "refresh"}:
                        if message.get("id") != expected or "result" not in message:
                            if phase == "refresh":
                                fail_refresh()
                                continue
                            raise ValueError("MCP catalog failed")
                        result = _mapping(message["result"])
                        tools.extend(_catalog(result))
                        if len(tools) > 64 or len({t.name for t in tools}) != len(tools):
                            if phase == "refresh":
                                fail_refresh()
                                continue
                            raise ValueError("MCP catalog capacity or duplicate name")
                        cursor = result.get("nextCursor")
                        if cursor is not None:
                            if not isinstance(cursor, str) or cursor in cursors or len(cursors) >= 64:
                                if phase == "refresh":
                                    fail_refresh()
                                    continue
                                raise ValueError("MCP pagination invalid")
                            cursors.add(cursor)
                            expected = request("tools/list", {"cursor": cursor})
                        else:
                            finish_list()
                    elif waiting is not None:
                        call_id, expected, canonical = waiting
                        if message.get("id") != expected:
                            continue
                        is_error = "error" in message
                        result = _mapping(message["error"] if is_error else message.get("result"))
                        is_error |= result.get("isError") is True
                        content = result.get("content", [])
                        parts = [v.get("text") for v in content if isinstance(v, dict)] if isinstance(content, list) else []
                        text = "\n".join(v for v in parts if isinstance(v, str)) or json.dumps(result, ensure_ascii=False)
                        reply = {"op": "result", "call_id": call_id, "text": text[:8000], "data": result, "is_error": is_error}
                        _send(1, reply)
                        seen[call_id] = canonical, reply
                        waiting = None
                        if pending_refresh:
                            pending_refresh = False
                            begin_list("refresh")
    finally:
        with contextlib.suppress(OSError, TimeoutError):
            _stop_server(server)
        server.stdout.close()
