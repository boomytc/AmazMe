"""Bounded, stop-and-wait delivery of complete session transactions."""

from __future__ import annotations

import asyncio
import contextlib
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from urllib.parse import urlencode
from weakref import WeakKeyDictionary

import httpx
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .contracts import BackendError, Replay, Snapshot, Stream, StreamAck, StreamHello

if TYPE_CHECKING:
    from .host import Host

HELLO_TIMEOUT = 5.0
ACK_TIMEOUT = 10.0
SEND_TIMEOUT = 5.0
PEER_TIMEOUT = 30.0
POLL_INTERVAL = 0.25
SNAPSHOT_INTERVAL = 15.0
MAX_INPUT_BYTES = 4096
# Includes the complete pending snapshot, not just the 512 KiB replay window.
# Session admission must also bound cumulative history/effects to this wire budget.
MAX_FRAME_BYTES = 33 * 1024 * 1024
MAX_CONNECTIONS = 128
MAX_BATCHES = 16
_SEQUENCE = re.compile(r"(?:0|[1-9][0-9]{0,17})\Z")


@dataclass
class Connections:
    sockets: set[WebSocket] = field(default_factory=lambda: set[WebSocket]())
    bindings: dict[str, WebSocket] = field(default_factory=lambda: dict[str, WebSocket]())


_connections: WeakKeyDictionary[Host, Connections] = WeakKeyDictionary()


def sequence(value: str) -> int:
    if not _SEQUENCE.fullmatch(value):
        raise BackendError("invalid_stream_sequence")
    return int(value)


def valid_replay(value: Replay, stream_id: str, cursor: int) -> bool:
    """A replay watermark covers exactly the complete transactions delivered."""
    if value.resync or value.stream_id != stream_id or len(value.batches) > MAX_BATCHES:
        return False
    try:
        for batch in value.batches:
            if (batch.stream_id != stream_id or sequence(batch.seq) != cursor + 1
                    or sequence(batch.base_revision) != cursor or sequence(batch.revision) != cursor + 1
                    or not batch.events or any(event.seq != batch.seq for event in batch.events)):
                return False
            cursor += 1
        return sequence(value.seq) == cursor
    except BackendError:
        return False


async def receive(socket: WebSocket) -> str:
    raw = await socket.receive_text()
    if len(raw.encode("utf-8")) > MAX_INPUT_BYTES:
        raise BackendError("stream_input_too_large")
    return raw


async def close(socket: WebSocket, code: int, reason: str) -> None:
    with contextlib.suppress(RuntimeError, WebSocketDisconnect, TimeoutError, OSError):
        await asyncio.wait_for(socket.close(code=code, reason=reason[:100]), SEND_TIMEOUT)


async def serve_stream(owner: Host, socket: WebSocket, session: str) -> None:
    """Host authenticates/accepts the socket; hello binds it before any worker access."""
    connections = _connections.setdefault(owner, Connections())
    if len(connections.sockets) >= MAX_CONNECTIONS:
        await close(socket, 1013, "stream_capacity")
        return
    connections.sockets.add(socket)
    hello: StreamHello | None = None
    incoming: asyncio.Task[str] | None = None
    try:
        hello = StreamHello.model_validate_json(await asyncio.wait_for(receive(socket), HELLO_TIMEOUT))
        if hello.build_id != owner.build:
            raise BackendError("build_mismatch")
        owner.check_attachment(hello.binding_id, session)
        if hello.binding_id in connections.bindings:
            raise BackendError("binding_in_use")
        connections.bindings[hello.binding_id] = socket
        binding = hello.binding_id

        def check() -> None:
            owner.check_attachment(binding, session)
            if connections.bindings.get(binding) is not socket or owner.closing:
                raise BackendError("stale_stream_binding")

        async def snapshot(reason: str) -> Stream:
            check()
            async with asyncio.timeout(PEER_TIMEOUT):
                peer = await owner.reader(session)
                value = await peer.call("GET", "/snapshot", Snapshot)
            check()
            if value.session_id != session or not value.stream_id:
                raise BackendError("snapshot_identity_mismatch")
            sequence(value.seq)
            return Stream(snapshot=value, stream_id=value.stream_id, binding_id=binding,
                          build_id=owner.build, resync=reason)

        async def replay(stream_id: str, cursor: int) -> Replay:
            check()
            async with asyncio.timeout(PEER_TIMEOUT):
                peer = await owner.reader(session)
                value = await peer.call("GET", "/events?" + urlencode({"after": cursor, "stream_id": stream_id}), Replay)
            check()
            return value

        stream_id, cursor = hello.stream_id, sequence(hello.after)
        frame: Stream | None = None
        if stream_id:
            value = await replay(stream_id, cursor)
            if valid_replay(value, stream_id, cursor) and value.batches:
                frame = Stream(batches=value.batches, stream_id=stream_id, binding_id=binding, build_id=owner.build)
            elif not valid_replay(value, stream_id, cursor):
                frame = await snapshot("cursor_unavailable")
        if frame is None:
            frame = await snapshot("initial" if not stream_id else "current")
        incoming = asyncio.create_task(receive(socket))
        snapshot_at = asyncio.get_running_loop().time()
        while True:
            check()
            if frame is not None:
                # One bounded frame in flight. No producer, fan-out queue or history pin.
                payload = frame.model_dump_json()
                if len(payload.encode("utf-8")) > MAX_FRAME_BYTES:
                    await close(socket, 1009, "stream_frame_too_large")
                    return
                check()
                if incoming.done():
                    incoming.result()
                    raise BackendError("unsolicited_ack")
                await asyncio.wait_for(socket.send_text(payload), SEND_TIMEOUT)
                expected = frame.snapshot.seq if frame.snapshot else frame.batches[-1].seq
                ack = StreamAck.model_validate_json(await asyncio.wait_for(incoming, ACK_TIMEOUT))
                check()
                if (ack.binding_id, ack.stream_id, ack.seq) != (binding, frame.stream_id, expected):
                    raise BackendError("invalid_ack")
                stream_id, cursor = frame.stream_id, sequence(expected)
                if frame.snapshot:
                    snapshot_at = asyncio.get_running_loop().time()
                incoming = asyncio.create_task(receive(socket))
                frame = None
            done, _ = await asyncio.wait({incoming}, timeout=POLL_INTERVAL)
            if done:
                incoming.result()
                raise BackendError("unsolicited_ack")
            if asyncio.get_running_loop().time() - snapshot_at >= SNAPSHOT_INTERVAL:
                frame = await snapshot("refresh")
                continue
            value = await replay(stream_id, cursor)
            if not valid_replay(value, stream_id, cursor):
                frame = await snapshot("cursor_unavailable")
            elif value.batches:
                frame = Stream(batches=value.batches, stream_id=stream_id, binding_id=binding, build_id=owner.build)
    except WebSocketDisconnect:
        pass
    except TimeoutError:
        await close(socket, 1013, "stream_timeout")
    except (ValidationError, ValueError, KeyError):
        await close(socket, 1008, "invalid_stream_message")
    except BackendError as error:
        await close(socket, 1008, error.code)
    except (httpx.TransportError, OSError):
        await close(socket, 1012, "runtime_recovering")
    finally:
        if incoming is not None:
            incoming.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, BackendError, ValueError, KeyError):
                await incoming
        if hello and connections.bindings.get(hello.binding_id) is socket:
            connections.bindings.pop(hello.binding_id)
        connections.sockets.discard(socket)
        if not connections.sockets:
            _connections.pop(owner, None)
