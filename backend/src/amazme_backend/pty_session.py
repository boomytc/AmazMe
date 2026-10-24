"""Bounded PTY protocol client owned by the supervisor."""

from __future__ import annotations

import codecs
import json
import socket
import struct
import time
from typing import Callable

from .contracts import BackendError
from .pty_gate import CREDIT, EXIT, INPUT, OUT_CREDIT, OUTPUT, PERMIT, RESIZE, WINDOW, WROTE, frame

# The protocol window stays 32 KiB. Scrollback is the reconnect record, not another window.
SCROLLBACK = 256 * 1024


def utf16_units(text: str) -> int:
    """Match JavaScript string length. A non-BMP code point is two units, not one."""
    return sum(2 if ord(char) > 0xFFFF else 1 for char in text)


def utf16_tail(text: str, limit: int) -> str:
    """Keep the newest units. A code point that does not fit is dropped whole."""
    if limit <= 0:
        return ""
    count = 0
    start = len(text)
    for index in range(len(text) - 1, -1, -1):
        units = 2 if ord(text[index]) > 0xFFFF else 1
        if count + units > limit:
            break
        count += units
        start = index
    return text[start:]


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
        self.received = 0
        self.granted = 0
        self.text = ""
        self.text_seq = 0
        self._text_done = False
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.exit_code: int | None = None
        self.pending_output = False
        self.closed = False

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

    def replenish(self) -> None:
        """Return consumed output credit so a long-lived shell is not stuck at the first window."""
        pending = self.received - self.granted
        while pending > 0:
            amount = min(WINDOW, pending)
            self.grant(amount)
            self.granted += amount
            pending -= amount

    def drain(self) -> None:
        """Read what is already buffered, then return only the credit that was consumed."""
        self.pump(0)
        for _ in range(8):
            before = self.received
            if self.received <= self.granted:
                return
            self.replenish()
            self.pump(0.05)
            if self.received == before:
                return

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
        deadline = time.monotonic() + 2
        while offset < len(view):
            if time.monotonic() >= deadline:
                raise BackendError("pty_channel_backpressure", status=503)
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
                self.closed = True
                self._append_text(b"", final=True)
                break
            self.buf.extend(part)
        while len(self.buf) >= 5:
            length = int.from_bytes(self.buf[1:5], "big")
            if length > WINDOW:
                raise BackendError("pty_frame_invalid", status=503)
            if len(self.buf) < 5 + length:
                return
            kind = self.buf[0]
            payload = bytes(self.buf[5:5 + length])
            del self.buf[:5 + length]
            self._apply(kind, payload)

    def _apply(self, kind: int, payload: bytes) -> None:
        if kind == CREDIT and len(payload) == 4:
            self.credit = int.from_bytes(payload, "big")
        elif kind == OUTPUT:
            self.received += len(payload)
            self.output.extend(payload)
            del self.output[:-WINDOW]
            self._append_text(payload)
        elif kind == WROTE and len(payload) == 12:
            self.written = int.from_bytes(payload[:8], "big")
            self.queued = int.from_bytes(payload[8:], "big")
        elif kind == EXIT and len(payload) == 5:
            self.exit_code = int.from_bytes(payload[:4], "big", signed=True)
            self.pending_output = bool(payload[4])
            if not self.pending_output:
                self._append_text(b"", final=True)

    def _append_text(self, data: bytes, *, final: bool = False) -> None:
        if self._text_done:
            if not data:
                return
            self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
            self._text_done = False
        chunk = self._decoder.decode(data, final)
        self.text_seq += utf16_units(chunk)
        self.text += chunk
        if utf16_units(self.text) > SCROLLBACK:
            self.text = utf16_tail(self.text, SCROLLBACK)
        if final:
            self._text_done = True
