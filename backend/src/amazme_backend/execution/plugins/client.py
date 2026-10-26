"""Pinned Python plugin entry and its bounded native service channel."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import JsonValue

from amazme_backend.contracts.plugins import PluginReply, PluginTool
from amazme_backend.execution.services import ServiceProcess
from amazme_backend.shared.errors import BackendError

LIMIT = 8 * 1024 * 1024


def stored_config(value: object) -> dict[str, str]:
    from pydantic import TypeAdapter
    return TypeAdapter(dict[str, str]).validate_python(value)


def validate_config(config: dict[str, str]) -> dict[str, str]:
    if len(config) > 64 or any(len(key) > 64 or len(value) > 4096 or '\x00' in key + value for key, value in config.items()):
        raise BackendError('plugin_config_rejected')
    return dict(sorted(config.items()))


def entry_digest(entry: str) -> tuple[str, str]:
    path = Path(entry).expanduser()
    if not path.is_absolute() or path.suffix != '.py' or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise BackendError('plugin_entry_invalid')
    path = path.resolve(strict=True)
    with path.open("rb") as stream:
        source = stream.read(1024 * 1024 + 1)
    if len(source) > 1024 * 1024:
        raise BackendError("plugin_entry_invalid")
    return str(path), hashlib.sha256(source).hexdigest()


def plugin_fingerprint(plugin_id: str, name: str, config: dict[str, str], *, entry: str,
                       source_digest: str, load_id: str) -> str:
    body = {'config':config, 'id':plugin_id, 'name':name, 'entry':entry, 'source_digest':source_digest, 'load_id':load_id}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def set_fingerprint(fingerprints: list[str]) -> str:
    return hashlib.sha256(json.dumps(sorted(fingerprints), separators=(',', ':')).encode()).hexdigest()


class PluginClient:
    def __init__(self, process: ServiceProcess):
        self.process = process
        self.process.sock.setblocking(False)
        self.buffer = bytearray()
        self.tools: list[PluginTool] = []
        self.pending = ''
        self.ready = False
        self.closed = asyncio.Event()

    async def send(self, value: dict[str, object]) -> None:
        data = (json.dumps(value, ensure_ascii=False) + '\n').encode()
        if len(data) > LIMIT:
            raise BackendError('plugin_protocol_limit')
        await asyncio.wait_for(asyncio.get_running_loop().sock_sendall(self.process.sock, data), 5)

    async def read(self) -> PluginReply:
        while b'\n' not in self.buffer:
            receive = asyncio.create_task(asyncio.get_running_loop().sock_recv(self.process.sock, 65536))
            closed = asyncio.create_task(self.closed.wait())
            try:
                done, _ = await asyncio.wait({receive, closed}, return_when=asyncio.FIRST_COMPLETED)
                if closed in done:
                    raise BackendError('plugin_disconnected')
                chunk = receive.result()
            finally:
                for task in (receive, closed):
                    task.cancel()
                await asyncio.gather(receive, closed, return_exceptions=True)
            if not chunk:
                raise BackendError('plugin_disconnected')
            self.buffer.extend(chunk)
            if len(self.buffer) > LIMIT:
                raise BackendError('plugin_protocol_limit')
        raw, _, remaining = self.buffer.partition(b'\n')
        self.buffer = bytearray(remaining)
        return PluginReply.model_validate_json(raw)

    async def load(self, entry: str, digest: str, config: dict[str, str], session_id: str, workspace: str) -> PluginReply:
        await self.send({'entry':entry, 'digest':digest, 'config':config, 'session_id':session_id, 'workspace':workspace})
        reply = await asyncio.wait_for(self.read(), 15)
        if reply.phase == 'ready':
            self.tools = reply.tools
            self.ready = True
        return reply

    async def call(self, call_id: str, name: str, arguments: dict[str, JsonValue], workspace: str, session_id: str, kind: Literal["tool", "command"] = "tool") -> PluginReply:
        if self.pending or not self.ready:
            raise BackendError('plugin_busy')
        self.pending = call_id
        try:
            await self.send({'op':'call', 'call_id':call_id, 'name':name, 'kind':kind, 'arguments':arguments,
                             'workspace':workspace, 'session_id':session_id})
            reply = await asyncio.wait_for(self.read(), 120)
            if reply.call_id != call_id or reply.phase not in {'done', 'failed'}:
                raise BackendError('plugin_protocol_identity')
            return reply
        finally:
            self.pending = ''

    async def close(self) -> None:
        self.closed.set()
        self.ready = False
        await self.process.close()
