"""A prompt image is stored with the user message and sent as an image URL, not as usage text."""

import asyncio
import base64
import json
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from amazme_backend.agent.model import ProductCompletion as Completion
from amazme_backend.agent.model import model_request, model_spec, stream
from amazme_backend.ai.providers.completions import provider_messages
from amazme_backend.ai.types import Auth
from amazme_backend.contracts import (
    IMAGE_MAX_COUNT,
    BackendError,
    HostFence,
    ImagePart,
    ProcessLease,
    ProviderConfig,
    Session,
    Submit,
    checked_images,
)
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sdk import Client
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import ModelInvocation, ModelReturned

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _image(data: str = PNG) -> ImagePart:
    return ImagePart(media_type="image/png", data_base64=data)


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "images", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": "sk-test-not-real"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:12345"
    return host


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
        "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
    })


async def _open(host: Host) -> tuple[str, SessionStore]:
    async with _client(host) as client:
        created = await client.post("/api/v1/sessions", json={"title": "图片"})
        assert created.status_code == 201
        session = created.json()["session_id"]
    path = session_database(host.lifecycle.profile.path, session)
    path.parent.mkdir(parents=True, mode=0o700)
    store = SessionStore(path, session, build=host.lifecycle.build)
    await store.initialize()
    return session, store


@pytest.mark.parametrize("text", ["看图", ""])
async def test_prompt_image_is_stored_sent_and_kept_out_of_usage_and_events(tmp_path: Path, text: str) -> None:
    image = _image()
    raw = base64.b64decode(image.data_base64)
    assert raw.startswith(b"\x89PNG")
    seen: dict[str, bytes] = {}

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        header = await reader.readuntil(b"\r\n\r\n")
        length = 0
        for line in header.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1].strip())
        seen["body"] = await reader.readexactly(length)
        body = b"data: " + json.dumps({
            "id": "resp-img", "object": "chat.completion.chunk", "created": 1, "model": "deepseek-flash",
            "choices": [{"index": 0, "delta": {"content": "看到了"}, "finish_reason": "stop"}],
        }).encode() + b"\n\ndata: [DONE]\n\n"
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: "
                     + str(len(body)).encode() + b"\r\n\r\n" + body)
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    sockets = server.sockets
    assert sockets is not None
    port = sockets[0].getsockname()[1]
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    try:
        session, store = await _open(host)
        try:
            receipt = await store.accept(
                Submit(request_id="img", text=text, images=[image]),
                HostFence(host_epoch=0, build_id=host.lifecycle.build))
            assert receipt.image_count == 1
            again = await store.accept(
                Submit(request_id="img", text=text, images=[image]),
                HostFence(host_epoch=0, build_id=host.lifecycle.build))
            assert again.image_count == 1 and again.revision == receipt.revision
            action: ModelInvocation | None = None
            for _ in range(8):
                step = await store.advance()
                if isinstance(step, ModelInvocation):
                    action = step
                    async for item in stream(step.config, step.messages, auth=Auth()):
                        if isinstance(item, Completion):
                            await store.advance(ModelReturned(step, item))
                    break
            assert action is not None
            stored = await store.messages("img")
            user = next(item for item in stored if item.role == "user" and item.images)
            assert user.images == [image]
            assert user.content == text
            replay_config = ProviderConfig(provider='deepseek')
            replay = provider_messages(model_spec(replay_config), model_request(replay_config, [user], auth=Auth()))
            sent = next(item for item in replay if item["role"] == "user")
            expected: list[dict[str, object]] = [{"type":"text", "text":text}] if text else []
            expected.append({"type":"image_url", "image_url":{"url":f"data:image/png;base64,{PNG}"}})
            assert sent["content"] == expected
            snapshot = await store.snapshot()
            assert PNG not in snapshot.model_dump_json()
            assert all(PNG not in event.text for event in snapshot.events)
            async with _client(host) as client:
                report = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert report["input_tokens"] == len(text)
            assert PNG not in json.dumps(report)
            await store.accept(Submit(request_id="again", text="再看"),
                               HostFence(host_epoch=0, build_id=host.lifecycle.build))
            follow = None
            for _ in range(8):
                step = await store.advance()
                if isinstance(step, ModelInvocation) and step.request_id == "again":
                    follow = step
                    break
            assert follow is not None
            assert any(item.images == [image] for item in follow.messages)
            config = ProviderConfig(
                provider="deepseek", model="deepseek-flash", base_url=f"http://127.0.0.1:{port}/v1",
                api_key=SecretStr("test-key"))
            async for item in stream(config, [user], auth=Auth(api_key=config.api_key)):
                if isinstance(item, Completion):
                    assert item.message.content == "看到了"
            request = json.loads(seen["body"])
            content = next(item["content"] for item in request["messages"] if item["role"] == "user")
            assert content == expected
        finally:
            await store.close()
    finally:
        server.close()
        await server.wait_closed()
        await host.lifecycle.store.db.close()


async def test_a_different_image_for_the_same_request_keeps_the_first(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    try:
        _session, store = await _open(host)
        try:
            first = _image()
            await store.accept(Submit(request_id="img", text="看图", images=[first]),
                               HostFence(host_epoch=0, build_id=host.lifecycle.build))
            other = _image(base64.b64encode(b"second-image").decode())
            with pytest.raises(BackendError) as failure:
                await store.accept(Submit(request_id="img", text="看图", images=[other]),
                                   HostFence(host_epoch=0, build_id=host.lifecycle.build))
            assert failure.value.code == "request_conflict"
            for _ in range(8):
                await store.advance()
                stored = await store.messages("img")
                if any(item.images for item in stored):
                    break
            assert stored[0].images == [first]
        finally:
            await store.close()
    finally:
        await host.lifecycle.store.db.close()


def test_invalid_or_oversized_images_are_rejected_before_storage() -> None:
    with pytest.raises(BackendError) as invalid:
        checked_images([ImagePart(media_type="image/png", data_base64="!!!!")])
    assert invalid.value.code == "invalid_image"
    with pytest.raises(ValidationError):
        Submit(request_id="img", text="看图", images=[_image() for _ in range(IMAGE_MAX_COUNT + 1)])
    with pytest.raises(ValidationError):
        ImagePart(media_type="image/png", data_base64="A" * 12_000_000)


async def test_sdk_submit_includes_the_image_part() -> None:
    client = Client("http://127.0.0.1:9", "token")
    seen: dict[str, object] = {}

    async def session(session_id: str) -> Session:
        return Session(session_id=session_id, title="图片", workspace="primary")

    async def send(method: str, path: str, *, json_body: object | None = None,
                   headers: dict[str, str] | None = None) -> object:
        del method, path, headers
        seen["body"] = json_body
        return {"request_id": "img", "text": "看图", "status": "queued", "image_count": 1}

    client.session = session  # type: ignore[method-assign]
    client._send = send  # type: ignore[method-assign]
    try:
        image = _image()
        receipt = await client.submit(
            session_id="s" * 32, workspace="primary", attachment_id="bind", request_id="img",
            text="看图", images=[image])
        assert receipt.image_count == 1
        body = seen["body"]
        assert isinstance(body, dict)
        assert body["images"] == [image.model_dump()]
    finally:
        await client._http.aclose()




def test_empty_text_requires_image_context() -> None:
    with pytest.raises(ValidationError, match="missing_user_context"):
        Submit(request_id="empty", text="")
    assert Submit(request_id="image-only", text="", images=[_image()]).images
