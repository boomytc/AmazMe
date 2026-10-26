from __future__ import annotations

import socket
import sys
from pathlib import Path

import httpx
from pydantic import BaseModel, ValidationError

from amazme_backend.shared.errors import BackendError


def unix_listener(path: Path) -> socket.socket:
    path.unlink(missing_ok=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen(64)
        listener.setblocking(False)
        return listener
    except BaseException:
        listener.close()
        raise


def child_command(*args: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    return [sys.executable, "-m", "amazme_backend", *args]


class Peer:
    def __init__(self, path: Path, token: str):
        self.client = httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(uds=str(path)), base_url="http://ipc",
            headers={"Authorization": "Bearer " + token}, timeout=180, trust_env=False,
        )

    async def call[T: BaseModel](self, method: str, path: str, response: type[T], body: BaseModel | None = None) -> T:
        r = await self.client.request(method, path, content=body.model_dump_json() if body else None,
                                      headers={"Content-Type": "application/json"})
        if r.is_error:
            from amazme_backend.shared.errors import ErrorBody
            try:
                error = ErrorBody.model_validate_json(r.content)
            except ValidationError as exc:
                raise BackendError("ipc_http_error", f"IPC HTTP {r.status_code}", r.status_code) from exc
            raise BackendError(error.code, error.message, r.status_code)
        return response.model_validate_json(r.content)

    async def close(self) -> None:
        await self.client.aclose()
