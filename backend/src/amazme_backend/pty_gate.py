"""Native PTY protocol gate. User code starts only after the supervisor permit."""

from __future__ import annotations

import errno
import fcntl
import json
import os
import pwd
import select
import signal
import socket
import struct
import sys
import termios

from .native_execution import tool_environment

WINDOW = 32768
PERMIT, INPUT, CREDIT, OUTPUT, WROTE, EXIT, RESIZE, OUT_CREDIT = range(1, 9)


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    offset = 0
    while offset < len(view):
        try:
            count = os.write(fd, view[offset:])
        except BlockingIOError:
            select.select([], [fd], [], 0.05)
            continue
        if count <= 0:
            raise SystemExit(125)
        offset += count


def frame(kind: int, payload: bytes = b"") -> bytes:
    if len(payload) > WINDOW:
        raise SystemExit(125)
    return bytes([kind]) + len(payload).to_bytes(4, "big") + payload


def _send(kind: int, payload: bytes = b"") -> None:
    _write_all(1, frame(kind, payload))


def _allowed_cwd(value: object) -> str:
    if not isinstance(value, str) or not os.path.isabs(value) or len(value) > 4096 or "\0" in value:
        raise SystemExit(125)
    return value


def _child(slave: int, uid: int, gid: int, command: str, cwd: str) -> None:
    try:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.closerange(3, 64)
        if cwd:
            if not os.path.isdir(cwd):
                os._exit(125)
            os.chdir(cwd)
        if (uid, gid) != (os.getuid(), os.getgid()):
            os._exit(125)
        shell = pwd.getpwuid(uid).pw_shell or "/bin/sh"
        os.execve(shell, [shell, "-c", command], {**tool_environment(), "TERM": "xterm-256color"})
    finally:
        os._exit(127)


def _winsize(master: int, cols: int, rows: int) -> None:
    if not 1 <= cols <= 200 or not 1 <= rows <= 80:
        raise SystemExit(125)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    control = socket.socket(fileno=0)
    try:
        control.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, WINDOW)
    except OSError:
        pass
    control.setblocking(False)
    queued = bytearray()
    inbox = bytearray()
    out_credit = WINDOW
    master = -1
    child = 0
    exit_code: int | None = None
    exit_sent = False
    written = 0

    def credit() -> None:
        _send(CREDIT, (WINDOW - len(queued)).to_bytes(4, "big"))

    def note_write() -> None:
        _send(WROTE, written.to_bytes(8, "big") + len(queued).to_bytes(4, "big"))

    def handle(kind: int, payload: bytes) -> None:
        nonlocal out_credit, master, child
        if master < 0:
            if kind != PERMIT:
                raise SystemExit(125)
            try:
                permit = json.loads(payload)
                command, uid, gid = permit["command"], permit["uid"], permit["gid"]
                cols, rows = permit["cols"], permit["rows"]
                cwd = _allowed_cwd(permit["cwd"]) if "cwd" in permit else ""
                if (set(permit) - {"cwd"} != {"command", "uid", "gid", "cols", "rows"}
                        or type(uid) is not int or type(gid) is not int or uid <= 0 or gid < 0
                        or not isinstance(command, str) or not command or len(command) > 16000 or "\0" in command
                        or type(cols) is not int or type(rows) is not int):
                    raise SystemExit(125)
            except (ValueError, TypeError, KeyError):
                raise SystemExit(125) from None
            master, slave = os.openpty()
            os.set_blocking(master, False)
            _winsize(master, cols, rows)
            child = os.fork()
            if child == 0:
                os.close(master)
                _child(slave, uid, gid, command, cwd)
            os.close(slave)
            credit()
            return
        if kind == INPUT:
            if len(queued) + len(payload) > WINDOW:
                raise SystemExit(125)
            queued.extend(payload)
            note_write()
        elif kind == RESIZE:
            if len(payload) != 4:
                raise SystemExit(125)
            cols, rows = struct.unpack("!HH", payload)
            _winsize(master, cols, rows)
        elif kind == OUT_CREDIT:
            if len(payload) != 4:
                raise SystemExit(125)
            out_credit = min(WINDOW, out_credit + int.from_bytes(payload, "big"))
        else:
            raise SystemExit(125)

    def pull() -> None:
        while True:
            if len(inbox) >= 5:
                length = int.from_bytes(inbox[1:5], "big")
                kind = inbox[0]
                if length > WINDOW or kind not in {PERMIT, INPUT, RESIZE, OUT_CREDIT}:
                    raise SystemExit(125)
                if len(inbox) >= 5 + length:
                    if kind == INPUT and len(queued) + length > WINDOW:
                        return
                    payload = bytes(inbox[5:5 + length])
                    del inbox[:5 + length]
                    handle(kind, payload)
                    continue
                need = 5 + length - len(inbox)
            else:
                need = 5 - len(inbox)
            try:
                part = control.recv(need)
            except BlockingIOError:
                return
            if not part:
                raise SystemExit(125)
            inbox.extend(part)

    try:
        while True:
            if child and exit_code is None:
                done, status = os.waitpid(child, os.WNOHANG)
                if done:
                    exit_code = os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
            readers = [control.fileno()]
            writers: list[int] = []
            if master >= 0 and queued:
                writers.append(master)
            if master >= 0 and out_credit:
                readers.append(master)
            select.select(readers, writers, [], 0.05)
            pull()
            if master >= 0 and queued:
                try:
                    count = os.write(master, queued)
                except BlockingIOError:
                    count = 0
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    count = 0
                if count:
                    del queued[:count]
                    written += count
                    note_write()
                    credit()
            if master >= 0 and out_credit:
                try:
                    data = os.read(master, min(4096, out_credit))
                except BlockingIOError:
                    data = b""
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    _send(OUTPUT, data)
                    out_credit -= len(data)
            if exit_code is not None and not exit_sent:
                pending = False
                if master >= 0:
                    pending = bool(select.select([master], [], [], 0)[0])
                _send(EXIT, exit_code.to_bytes(4, "big", signed=True) + bytes([1 if pending else 0]))
                exit_sent = True
                if not pending:
                    return exit_code
            if exit_sent and master >= 0 and not select.select([master], [], [], 0)[0]:
                return exit_code or 0
    finally:
        if child and exit_code is None:
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
        if master >= 0:
            os.close(master)


if __name__ == "__main__":
    sys.exit(main())
