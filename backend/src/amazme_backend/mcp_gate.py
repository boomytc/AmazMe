"""Container PID 1 for one stdio MCP server.

The product starts this only as the container command. Tool calls are forwarded
only when the supervisor sends them. Exit is reported only after waitpid.
"""

from __future__ import annotations

import json
import os
import select
import signal
import sys
from typing import cast

LIMIT = 65536


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SystemExit(125)
    return cast(dict[str, object], value)


def _items(value: object) -> list[object]:
    if not isinstance(value, list):
        raise SystemExit(125)
    return cast(list[object], value)


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    offset = 0
    while offset < len(view):
        count = os.write(fd, view[offset:])
        if count <= 0:
            raise SystemExit(125)
        offset += count


def _emit(message: dict[str, object]) -> None:
    _write_all(1, (json.dumps(message, ensure_ascii=False) + "\n").encode())


def _take_line(buf: bytearray) -> bytes | None:
    if b"\n" not in buf:
        if len(buf) > LIMIT:
            raise SystemExit(125)
        return None
    line, _, rest = bytes(buf).partition(b"\n")
    buf[:] = rest
    if len(line) > LIMIT:
        raise SystemExit(125)
    return line


def _fill(fd: int, buf: bytearray) -> None:
    part = os.read(fd, 4096)
    if not part:
        raise SystemExit(125)
    buf.extend(part)


def _read_line(fd: int, buf: bytearray) -> bytes:
    while True:
        found = _take_line(buf)
        if found is not None:
            return found
        _fill(fd, buf)


def _child(command: str, stdin_fd: int, stdout_fd: int, uid: int, gid: int) -> None:
    try:
        os.setsid()
        os.dup2(stdin_fd, 0)
        os.dup2(stdout_fd, 1)
        null = os.open("/dev/null", os.O_RDWR)
        os.dup2(null, 2)
        os.closerange(3, 64)
        if os.path.isdir("/workspace"):
            os.chdir("/workspace")
        try:
            os.setgroups([])
        except PermissionError:
            if os.getuid() != uid:
                raise
        try:
            os.setgid(gid)
            os.setuid(uid)
        except PermissionError:
            if os.getuid() != uid or os.getgid() != gid:
                raise
        os.execve("/bin/sh", ["sh", "-c", command], {
            "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1",
        })
    finally:
        os._exit(127)


def _request(write_fd: int, read_fd: int, buf: bytearray, method: str, params: dict[str, object], number: int) -> dict[str, object]:
    message = {"jsonrpc": "2.0", "id": number, "method": method, "params": params}
    _write_all(write_fd, (json.dumps(message) + "\n").encode())
    while True:
        body = _mapping(json.loads(_read_line(read_fd, buf)))
        if "id" not in body:
            continue
        if body.get("id") != number or "error" in body or "result" not in body:
            raise SystemExit(125)
        return _mapping(body["result"])


def _notify(write_fd: int, method: str) -> None:
    _write_all(write_fd, (json.dumps({"jsonrpc": "2.0", "method": method}) + "\n").encode())


def _catalog(result: dict[str, object]) -> list[dict[str, str]]:
    tools = _items(result.get("tools"))
    if len(tools) > 64:
        raise SystemExit(125)
    cleaned: list[dict[str, str]] = []
    for entry in tools:
        item = _mapping(entry)
        name = item.get("name")
        if not isinstance(name, str) or not name or len(name) > 64:
            raise SystemExit(125)
        if any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for char in name):
            raise SystemExit(125)
        description = item.get("description", "")
        if not isinstance(description, str):
            description = ""
        cleaned.append({"name": name, "description": description[:200]})
    return cleaned


def _result_text(result: dict[str, object]) -> str:
    content = result.get("content")
    if isinstance(content, list) and content:
        first = _mapping(_items(cast(object, content))[0])
        text = first.get("text")
        if isinstance(text, str):
            return text[:8000]
    return json.dumps(result, ensure_ascii=False)[:8000]


def main() -> int:
    control = bytearray()
    permit_line = _read_line(0, control)
    try:
        permit = _mapping(json.loads(permit_line))
        command, uid, gid = permit["command"], permit["uid"], permit["gid"]
        if (set(permit) != {"op", "command", "uid", "gid"} or permit["op"] != "permit"
                or type(uid) is not int or type(gid) is not int or uid <= 0 or gid < 0
                or not isinstance(command, str) or not command or len(command) > 16000 or "\0" in command):
            raise SystemExit(125)
    except (ValueError, TypeError, KeyError):
        raise SystemExit(125) from None
    child_in_read, child_in_write = os.pipe()
    child_out_read, child_out_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(child_in_write)
        os.close(child_out_read)
        _child(command, child_in_read, child_out_write, uid, gid)
    os.close(child_in_read)
    os.close(child_out_write)
    child_buf = bytearray()
    exit_code: int | None = None
    try:
        started = _request(child_in_write, child_out_read, child_buf, "initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "amazme", "version": "0.1.0"},
        }, 1)
        if not isinstance(started.get("serverInfo"), dict):
            raise SystemExit(125)
        _notify(child_in_write, "notifications/initialized")
        listed = _catalog(_request(child_in_write, child_out_read, child_buf, "tools/list", {}, 2))
        _emit({"op": "catalog", "tools": listed})
        os.set_blocking(0, False)
        os.set_blocking(child_out_read, False)
        seen: dict[str, tuple[str, str]] = {}
        waiting: tuple[str, int, str] | None = None
        number = 3
        while exit_code is None:
            select.select([0, child_out_read], [], [], 0.05)
            try:
                _fill(0, control)
            except BlockingIOError:
                pass
            while True:
                line = _take_line(control)
                if line is None:
                    break
                if not line:
                    continue
                message = _mapping(json.loads(line))
                op = message.get("op")
                if op == "cancel":
                    os.killpg(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
                    exit_code = os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
                    _emit({"op": "exit", "code": exit_code})
                    return exit_code
                if op != "call" or waiting is not None:
                    raise SystemExit(125)
                call_id, name, arguments = message.get("call_id"), message.get("name"), message.get("arguments")
                if (not isinstance(call_id, str) or not isinstance(name, str) or not isinstance(arguments, dict)
                        or not call_id or len(call_id) > 64):
                    raise SystemExit(125)
                canonical = json.dumps({"name": name, "arguments": arguments}, sort_keys=True, ensure_ascii=False)
                previous = seen.get(call_id)
                if previous is not None:
                    if previous[0] != canonical:
                        _emit({"op": "conflict", "call_id": call_id})
                    else:
                        _emit({"op": "result", "call_id": call_id, "text": previous[1], "is_error": False})
                    continue
                _write_all(child_in_write, (json.dumps({
                    "jsonrpc": "2.0", "id": number, "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                }) + "\n").encode())
                waiting = (call_id, number, canonical)
                number += 1
            try:
                _fill(child_out_read, child_buf)
            except BlockingIOError:
                pass
            while waiting is not None and (line := _take_line(child_buf)) is not None:
                body = _mapping(json.loads(line))
                if "id" not in body:
                    continue
                call_id, expected, canonical = waiting
                if body.get("id") != expected or "result" not in body:
                    raise SystemExit(125)
                result = _mapping(body["result"])
                text = _result_text(result)
                seen[call_id] = (canonical, text)
                waiting = None
                _emit({"op": "result", "call_id": call_id, "text": text, "is_error": result.get("isError") is True})
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                exit_code = os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
                _emit({"op": "exit", "code": exit_code})
                return exit_code
        return exit_code or 0
    finally:
        if exit_code is None:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(child_in_write)
        os.close(child_out_read)


if __name__ == "__main__":
    sys.exit(main())
