"""Client for the remote daemon. Disconnect is not a stop proof."""

from __future__ import annotations

import json
import socket
import time
from typing import cast

from amazme_backend.contracts import BackendError


class RemoteClient:
    def __init__(self, sock: socket.socket):
        self.leases = []
        self.sock = sock
        self.buf = bytearray()
        self.hello: dict[str, object] = {}

    @classmethod
    def connect(cls, endpoint: str) -> RemoteClient:
        host, _, port = endpoint.rpartition(":")
        sock = socket.create_connection((host, int(port)), timeout=2)
        sock.settimeout(2)
        client = cls(sock)
        client.hello = client._recv()
        return client

    def call(self, call_id: str, command: str) -> dict[str, object]:
        return self._roundtrip({"op": "call", "call_id": call_id, "command": command})

    def query(self, call_id: str) -> dict[str, object]:
        return self._roundtrip({"op": "query", "call_id": call_id})

    def cancel(self, call_id: str) -> dict[str, object]:
        return self._roundtrip({"op": "cancel", "call_id": call_id})

    def close(self) -> None:
        self.sock.close()

    def _roundtrip(self, message: dict[str, object]) -> dict[str, object]:
        self.sock.sendall((json.dumps(message, ensure_ascii=False) + "\n").encode())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            found = self._take()
            if found is not None:
                return found
            try:
                part = self.sock.recv(4096)
            except TimeoutError:
                continue
            if not part:
                raise BackendError("remote_disconnected", status=503)
            self.buf.extend(part)
        raise BackendError("remote_timeout", status=503)

    def _recv(self) -> dict[str, object]:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            part = self.sock.recv(4096)
            if not part:
                raise BackendError("remote_disconnected", status=503)
            self.buf.extend(part)
            found = self._take()
            if found is not None:
                return found
        raise BackendError("remote_timeout", status=503)

    def _take(self) -> dict[str, object] | None:
        if b"\n" not in self.buf:
            return None
        line, _, rest = bytes(self.buf).partition(b"\n")
        self.buf[:] = rest
        if not line:
            return None
        body = json.loads(line)
        if not isinstance(body, dict):
            raise BackendError("remote_protocol", status=503)
        return cast(dict[str, object], body)
