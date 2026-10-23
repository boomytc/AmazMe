"""A prompt image is stored with the user message and sent as an image URL, not as usage text."""

import asyncio
import base64
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from amazme_backend.common import Profile, private_write
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
from amazme_backend.host import Host, application
from amazme_backend.providers import Completion, provider_messages, stream
from amazme_backend.sdk import Client
from amazme_backend.session_domain import ModelInvocation, ModelReturned
from amazme_backend.storage import SessionStore, session_database

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
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build,
        "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def _open(host: Host) -> tuple[str, SessionStore]:
    async with _client(host) as client:
        created = await client.post("/api/v1/sessions", json={"title": "图片"})
        assert created.status_code == 201
        session = created.json()["session_id"]
    path = session_database(host.profile.path, session)
    path.parent.mkdir(parents=True, mode=0o700)
    store = SessionStore(path, session, build=host.build)
    await store.initialize()
    return session, store


async def test_prompt_image_is_stored_sent_and_kept_out_of_usage_and_events(tmp_path: Path) -> None:
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
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        session, store = await _open(host)
        try:
            receipt = await store.accept(
                Submit(request_id="img", text="看图", images=[image]),
                HostFence(host_epoch=0, build_id=host.build))
            assert receipt.image_count == 1
            again = await store.accept(
                Submit(request_id="img", text="看图", images=[image]),
                HostFence(host_epoch=0, build_id=host.build))
            assert again.image_count == 1 and again.revision == receipt.revision
            action: ModelInvocation | None = None
            for _ in range(8):
                step = await store.advance()
                if isinstance(step, ModelInvocation):
                    action = step
                    async for item in stream(step.config, step.messages):
                        if isinstance(item, Completion):
                            await store.advance(ModelReturned(step, item))
                    break
            assert action is not None
            stored = await store.messages("img")
            user = next(item for item in stored if item.role == "user" and item.images)
            assert user.images == [image]
            assert user.content == "看图"
            replay = provider_messages([user], "deepseek")
            sent = next(item for item in replay if item["role"] == "user")
            assert sent["content"] == [
                {"type": "text", "text": "看图"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{PNG}"}},
            ]
            snapshot = await store.snapshot()
            assert PNG not in snapshot.model_dump_json()
            assert all(PNG not in event.text for event in snapshot.events)
            async with _client(host) as client:
                report = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert report["input_tokens"] == len("看图")
            assert PNG not in json.dumps(report)
            await store.accept(Submit(request_id="again", text="再看"),
                               HostFence(host_epoch=0, build_id=host.build))
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
            async for item in stream(config, [user]):
                if isinstance(item, Completion):
                    assert item.message.content == "看到了"
            request = json.loads(seen["body"])
            content = next(item["content"] for item in request["messages"] if item["role"] == "user")
            assert content[1]["image_url"]["url"] == f"data:image/png;base64,{PNG}"
        finally:
            await store.db.close()
    finally:
        server.close()
        await server.wait_closed()
        await host.store.db.close()


async def test_a_different_image_for_the_same_request_keeps_the_first(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        _session, store = await _open(host)
        try:
            first = _image()
            await store.accept(Submit(request_id="img", text="看图", images=[first]),
                               HostFence(host_epoch=0, build_id=host.build))
            other = _image(base64.b64encode(b"second-image").decode())
            with pytest.raises(BackendError) as failure:
                await store.accept(Submit(request_id="img", text="看图", images=[other]),
                                   HostFence(host_epoch=0, build_id=host.build))
            assert failure.value.code == "request_conflict"
            for _ in range(8):
                await store.advance()
                stored = await store.messages("img")
                if any(item.images for item in stored):
                    break
            assert stored[0].images == [first]
        finally:
            await store.db.close()
    finally:
        await host.store.db.close()


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


def test_page_sends_the_selected_image_and_shows_the_count() -> None:
    node = shutil.which("node")
    if node is None:
        raise AssertionError("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    from amazme_backend.contracts import Stream
    schema = Stream.model_json_schema()
    url = "data:text/javascript;base64," + base64.b64encode(
        ("const root = " + json.dumps(schema) + ";\n" + contract).encode()).decode()
    app = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(app.encode()).decode()
    session = "d" * 32
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst png=" + json.dumps(PNG) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=''' + session + r'''&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,FileReader:window.FileReader,WebSocket:class{
          constructor(){ queueMicrotask(()=>this.onopen?.()); }
          send(raw){
            const frame=JSON.parse(raw);
            if(frame.kind==='hello') queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot,batches:[],stream_id:'stream',binding_id:frame.binding_id,build_id:'build',resync:'initial'})}));
          }
          close(){}
        }});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const calls = [];
        const snapshot = {session_id:''' + json.dumps(session) + r''',stream_id:'stream',seq:'1',state:'ready',requests:[{
          request_id:'shown',text:'看图',status:'succeeded',answer:'好',image_count:1,kind:'root',children:[],revision:'1',run_id:'shown'}],
          events:[],approvals:[],effects:[],previews:[],pending:0,next_wake_ms:0,compaction:''};
        globalThis.fetch = async (path, options={}) => {
          calls.push({path, body: options.body});
          if (path === '/api/v1/bootstrap') return response(identity);
          if (path === '/api/v1/health') return response({state:'ready',identity});
          if (path === '/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'图片',workspace:'primary'}]});
          if (path === '/api/v1/models') return response({models:[],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if (path.endsWith('/attachments') && (!options.method || options.method === 'POST')) return response({attachment_id:'bind',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1},201);
          if (path.endsWith('/snapshot')) return response(snapshot);
          if (path.endsWith('/submissions')) return response({request_id:'img',text:'看图',status:'queued',image_count:1},202);
          if (path.includes('/attachments/')) return response({detached:true});
          return response({});
        };
        const $=id=>document.getElementById(id);
        await import(appURL);
        for (let n=0;n<50 && $('connection').textContent!=='已连接';n++) await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal($('connection').textContent,'已连接', $('error').textContent);
        assert.match($('conversation').textContent,/看图 · 1 张图片/);
        const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0));
        const file = new window.File([bytes], 'dot.png', {type:'image/png'});
        const input = $('images');
        Object.defineProperty(input, 'files', {configurable:true, value:[file]});
        input.onchange();
        assert.equal($('image-note').textContent,'dot.png');
        $('prompt').value = '看图';
        await $('composer').onsubmit({preventDefault(){}});
        const submission = calls.find(call => String(call.path).endsWith('/submissions'));
        const body = JSON.parse(submission.body);
        assert.equal(body.text,'看图');
        assert.equal(body.images.length,1);
        assert.equal(body.images[0].media_type,'image/png');
        assert.equal(body.images[0].data_base64,png);
        assert.equal($('image-note').textContent,'');
        process.exit(0);
    '''
    try:
        result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20)
    except subprocess.TimeoutExpired as exc:
        err = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        raise AssertionError(err[-1500:]) from None
    if result.returncode != 0:
        raise AssertionError((result.stderr or result.stdout)[-1500:])
