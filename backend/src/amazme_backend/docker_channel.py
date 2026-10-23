"""Docker hijack connection owned exclusively by the execution supervisor."""

import asyncio
import json
from pathlib import Path

from .contracts import BackendError


class GateChannel:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader, self.writer = reader, writer
        self.stdout, self.stderr = bytearray(), bytearray()
        self.truncated = False
        self.sent = False

    @classmethod
    async def attach(cls, socket: Path, container: str) -> "GateChannel":
        if len(container) != 64 or any(c not in "0123456789abcdef" for c in container):
            raise BackendError("container_identity_mismatch")
        reader, writer = await asyncio.open_unix_connection(socket)
        channel = cls(reader, writer)
        try:
            request = (f"POST /containers/{container}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n"
                       "Host: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n")
            writer.write(request.encode("ascii"))
            await writer.drain()
            async with asyncio.timeout(15):
                header = await reader.readuntil(b"\r\n\r\n")
            status = header.split(b"\r\n", 1)[0].split()
            if len(status) < 2 or status[1] not in {b"101", b"200"}:
                raise BackendError("docker_attach_failed", status=503)
            if b"transfer-encoding:" in header.lower():
                raise BackendError("docker_attach_not_hijacked", status=503)
            return channel
        except BaseException:
            await channel.close()
            raise

    async def permit(self, command: str, uid: int, gid: int) -> None:
        if self.sent:
            raise BackendError("permit_already_sent")
        payload = (json.dumps({"command": command, "uid": uid, "gid": gid}) + "\n").encode()
        if len(payload) > 262144:
            raise BackendError("permit_too_large")
        self.sent = True
        self.writer.write(payload)
        await self.writer.drain()

    async def collect(self) -> tuple[str, str, bool]:
        while True:
            try:
                header = await self.reader.readexactly(8)
            except asyncio.IncompleteReadError as error:
                if error.partial:
                    raise BackendError("docker_truncated_frame", status=503) from error
                break
            if header[0] not in (1, 2) or header[1:4] != b"\0\0\0":
                raise BackendError("docker_invalid_frame", status=503)
            remaining = int.from_bytes(header[4:], "big")
            if remaining > 16 * 1024 * 1024:
                raise BackendError("docker_frame_too_large", status=503)
            target = self.stdout if header[0] == 1 else self.stderr
            while remaining:
                chunk = await self.reader.readexactly(min(remaining, 8192))
                remaining -= len(chunk)
                room = max(0, 65536 - len(target))
                target.extend(chunk[:room])
                self.truncated |= len(chunk) > room
        return self.stdout.decode(errors="replace"), self.stderr.decode(errors="replace"), self.truncated

    async def close(self) -> None:
        self.writer.close()
        try:
            async with asyncio.timeout(1):
                await self.writer.wait_closed()
        except (OSError, TimeoutError):
            pass
