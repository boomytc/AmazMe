"""Bounded JSON SSE parsing shared by the native HTTP provider protocols."""
from collections.abc import AsyncGenerator

import httpx
from pydantic import JsonValue, TypeAdapter

from amazme_backend.shared.errors import BackendError

Record = dict[str, JsonValue]
RECORD = TypeAdapter(Record)
RECORDS = TypeAdapter(list[Record])
def record(value: JsonValue) -> Record:
    if not isinstance(value, dict):
        raise BackendError('model_protocol')
    return value


def items(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise BackendError('model_protocol')
    return value


def number(value: JsonValue) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def text(value: JsonValue) -> str:
    return value if isinstance(value, str) else ''


async def events(client: httpx.AsyncClient, url: str, headers: dict[str, str], body: Record) -> AsyncGenerator[Record, None]:
    async with client.stream('POST', url, json=body, headers=headers) as response:
        if not response.is_success:
            raise BackendError('model_http_' + str(response.status_code), status=503)
        buf, data = bytearray(), bytearray()
        async for chunk in response.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > 1048576:
                raise BackendError('model_event_limit')
            while b'\n' in buf:
                line, _, rest = buf.partition(b'\n')
                buf[:] = rest
                line = line.rstrip(b'\r')
                if line.startswith(b'data:'):
                    data.extend(line[5:].lstrip() + b'\n')
                    if len(data) > 1048576:
                        raise BackendError('model_event_limit')
                elif not line and data:
                    payload = bytes(data).strip()
                    data.clear()
                    if payload != b'[DONE]':
                        yield RECORD.validate_json(payload)
        if data or buf.strip():
            raise BackendError('model_stream_interrupted')
