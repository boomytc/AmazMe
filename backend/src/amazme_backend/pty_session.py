"""PTY window codec and the container spec the supervisor launches.

The codec speaks to pty_gate. It does not open a host PTY or a host shell.
"""

from __future__ import annotations

import json
import socket
import struct
import time
from typing import Callable

from .contracts import BackendError
from .pty_gate import CREDIT, EXIT, INPUT, OUT_CREDIT, OUTPUT, PERMIT, RESIZE, WINDOW, WROTE, frame


class PtyClient:
    """Synchronous client used by the supervisor's PTY task and by tests."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.sock.setblocking(False)
        self.buf = bytearray()
        self.credit = 0
        self.written = 0
        self.queued = 0
        self.output = bytearray()
        self.exit_code: int | None = None
        self.pending_output = False

    def permit(self, command: str, uid: int, gid: int, cols: int, rows: int, cwd: str = "") -> None:
        payload: dict[str, object] = {"command": command, "uid": uid, "gid": gid, "cols": cols, "rows": rows}
        if cwd:
            payload["cwd"] = cwd
        body = json.dumps(payload).encode()
        self._send(PERMIT, body)
        self.pump(2, lambda: self.credit > 0)
        if self.credit <= 0:
            raise BackendError("pty_permit_failed", status=503)

    def send_input(self, data: bytes) -> None:
        if not data or len(data) > self.credit:
            raise BackendError("pty_window_full")
        self._send(INPUT, data)
        self.credit -= len(data)

    def resize(self, cols: int, rows: int) -> None:
        self._send(RESIZE, struct.pack("!HH", cols, rows))

    def grant(self, amount: int) -> None:
        if amount <= 0 or amount > WINDOW:
            raise BackendError("pty_window_full")
        self._send(OUT_CREDIT, amount.to_bytes(4, "big"))

    def pump(self, timeout: float, done: Callable[[], bool] | None = None) -> None:
        deadline = time.monotonic() + timeout
        while True:
            self._read()
            if done is not None and done():
                return
            if time.monotonic() >= deadline:
                return
            time.sleep(0.01)

    def _send(self, kind: int, payload: bytes) -> None:
        packet = frame(kind, payload)
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
                raise BackendError("pty_channel_closed", status=503)
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
        while len(self.buf) >= 5:
            length = int.from_bytes(self.buf[1:5], "big")
            if length > WINDOW or len(self.buf) < 5 + length:
                return
            kind = self.buf[0]
            payload = bytes(self.buf[5:5 + length])
            del self.buf[:5 + length]
            self._apply(kind, payload)

    def _apply(self, kind: int, payload: bytes) -> None:
        if kind == CREDIT and len(payload) == 4:
            self.credit = int.from_bytes(payload, "big")
        elif kind == OUTPUT:
            self.output.extend(payload)
        elif kind == WROTE and len(payload) == 12:
            self.written = int.from_bytes(payload[:8], "big")
            self.queued = int.from_bytes(payload[8:], "big")
        elif kind == EXIT and len(payload) == 5:
            self.exit_code = int.from_bytes(payload[:4], "big", signed=True)
            self.pending_output = bool(payload[4])
