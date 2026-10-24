"""Session usage reads tokens stored with finished model calls and does not invent a price."""

import asyncio
import base64
import json
import shutil
import subprocess
from pathlib import Path

import httpx
from pydantic import SecretStr

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    HostFence,
    Message,
    ProcessLease,
    ProviderConfig,
    Receipt,
    Submit,
)
from amazme_backend.host import Host, application
from amazme_backend.providers import (
    Completion,
    catalog_price,
    provider_messages,
    read_stream_usage,
    stream,
    token_cost_micro,
)
from amazme_backend.session_domain import ModelInvocation, ModelReturned
from amazme_backend.storage import SessionStore, session_database

KEY = "sk-test-not-real"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "usage", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": KEY}}))
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


async def _finish_prompt(host: Host, session: str, request_id: str, text: str) -> Receipt:
    path = session_database(host.profile.path, session)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    store = SessionStore(path, session, build=host.build)
    await store.initialize()
    try:
        await store.accept(Submit(request_id=request_id, text=text), HostFence(host_epoch=0, build_id=host.build))
        for _ in range(8):
            snapshot = await store.snapshot()
            receipt = next(item for item in snapshot.requests if item.request_id == request_id)
            if receipt.decision is not None and receipt.decision.answer:
                return receipt
            action = await store.advance()
            if isinstance(action, ModelInvocation):
                async for item in stream(action.config, action.messages):
                    if isinstance(item, Completion):
                        await store.advance(ModelReturned(action, item))
        raise AssertionError("prompt did not finish")
    finally:
        await store.db.close()


async def test_usage_totals_follow_visible_answers_and_the_faux_catalog_price(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            missing = await client.get("/api/v1/sessions/" + "e" * 32 + "/usage")
            assert missing.status_code == 404 and missing.json()["code"] == "session_not_found"
            created = await client.post("/api/v1/sessions", json={"title": "用量"})
            assert created.status_code == 201
            session = created.json()["session_id"]
            empty = await client.get(f"/api/v1/sessions/{session}/usage")
            assert empty.status_code == 200
            assert empty.json() == {
                "session_id": session, "model_calls": 0, "input_tokens": 0, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_signatures": 0,
                "priced_calls": 0, "unpriced_calls": 0, "priced": True, "cost_micro_usd": 0}
            first = await _finish_prompt(host, session, "one", "你好")
            assert first.decision is not None and first.decision.answer
            once = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert once["model_calls"] == 1
            assert once["input_tokens"] == len("你好")
            assert once["output_tokens"] == len(first.decision.answer)
            assert once["priced"] is True and once["cost_micro_usd"] == 0
            assert once["cache_read_tokens"] == 0 and once["cache_write_tokens"] == 0
            assert once["reasoning_signatures"] == 0 and once["unpriced_calls"] == 0
            assert KEY not in json.dumps(once)
            second = await _finish_prompt(host, session, "two", "再来")
            assert second.decision is not None and second.decision.answer
            twice = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert twice["model_calls"] == 2
            # The second call sees the first user text, its visible answer, and the new text.
            assert twice["input_tokens"] == once["input_tokens"] + len("你好") + len(first.decision.answer) + len("再来")
            assert twice["output_tokens"] == len(first.decision.answer) + len(second.decision.answer)
            assert twice["priced"] is True and twice["cost_micro_usd"] == 0
    finally:
        await host.store.db.close()


def test_deepseek_prices_match_the_published_catalog() -> None:
    from decimal import Decimal

    from amazme_backend.providers import catalog_price, token_cost_micro

    catalog = json.loads((Path(__file__).parents[2] / "packages/ai/src/providers/data/deepseek.json").read_text())
    published = catalog["openai-completions"]
    assert {item["id"] for item in published.values()} == {"deepseek-flash", "deepseek-v4-pro"}
    for model in published.values():
        rates = model["cost"]
        price = catalog_price("deepseek", model["id"])
        assert price == (
            int(Decimal(str(rates["input"])) * 1_000_000),
            int(Decimal(str(rates["output"])) * 1_000_000),
            int(Decimal(str(rates["cacheRead"])) * 1_000_000),
            int(Decimal(str(rates["cacheWrite"])) * 1_000_000),
        )
        assert token_cost_micro(2, 6, 3, 1, price) == (
            2 * price[0] + 6 * price[1] + 3 * price[2] + 1 * price[3]
        ) // 1_000_000
    price = catalog_price("deepseek", "deepseek-flash")
    assert price is not None
    assert catalog_price("faux", "faux") == (0, 0, 0, 0)
    assert catalog_price("faux", "deepseek-flash") == (0, 0, 0, 0)
    assert catalog_price("deepseek", "custom-endpoint") is None
    assert token_cost_micro(2, 6, 3, 1, price) == (
        2 * price[0] + 6 * price[1] + 3 * price[2] + 1 * price[3]
    ) // 1_000_000


class _Count:
    def __init__(self, **fields: object) -> None:
        self.__dict__.update(fields)


def test_explicit_zero_cache_detail_beats_the_deepseek_hit_field() -> None:
    detailed = _Count(
        prompt_tokens=10, completion_tokens=2,
        prompt_tokens_details=_Count(cached_tokens=0, cache_write_tokens=0),
        model_extra={"prompt_cache_hit_tokens": 9})
    assert read_stream_usage(detailed) == (10, 2, 0, 0)
    hit_only = _Count(
        prompt_tokens=10, completion_tokens=2, prompt_tokens_details=None,
        model_extra={"prompt_cache_hit_tokens": 4})
    assert read_stream_usage(hit_only) == (6, 2, 4, 0)


def test_corrupt_reasoning_signature_is_not_rewritten_for_replay() -> None:
    message = Message(role="assistant", content="已收到", reasoning_signature="{")
    try:
        provider_messages([message], "deepseek")
    except BackendError as exc:
        assert exc.code == "invalid_reasoning_signature"
    else:
        raise AssertionError("corrupt signature was sent")
    sent = provider_messages([Message(role="assistant", content="已收到")], "deepseek")
    assistant = next(item for item in sent if item["role"] == "assistant")
    assert "reasoning_details" not in assistant
    assert assistant["reasoning_content"] == ""


async def test_stream_persists_cache_cost_and_replays_reasoning_signature(tmp_path: Path) -> None:
    signature = [{"type": "reasoning.encrypted", "id": "sig-1", "data": "opaque/sig+="}]
    usage = {
        "prompt_tokens": 10,
        "completion_tokens": 4,
        "total_tokens": 14,
        "prompt_cache_hit_tokens": 9,
        "prompt_tokens_details": {"cached_tokens": 3, "cache_write_tokens": 1},
    }
    chunks = [
        {"id": "resp-1", "object": "chat.completion.chunk", "created": 1, "model": "deepseek-flash",
         "choices": [{"index": 0, "delta": {"role": "assistant", "content": "已收到"}, "finish_reason": None}]},
        {"id": "resp-1", "object": "chat.completion.chunk", "created": 1, "model": "deepseek-flash",
         "choices": [{"index": 0, "delta": {"reasoning_details": signature}, "finish_reason": None}]},
        {"id": "resp-1", "object": "chat.completion.chunk", "created": 1, "model": "deepseek-flash",
         "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage},
    ]
    body = b"".join(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode() for chunk in chunks) + b"data: [DONE]\n\n"

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        header = await reader.readuntil(b"\r\n\r\n")
        length = 0
        for line in header.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1].strip())
        if length:
            await reader.readexactly(length)
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: "
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
        config = ProviderConfig(
            provider="deepseek", model="deepseek-flash", base_url=f"http://127.0.0.1:{port}/v1",
            api_key=SecretStr("test-key"))
        completion: Completion | None = None
        async for item in stream(config, [Message(role="user", content="你好")]):
            if isinstance(item, Completion):
                completion = item
        assert completion is not None
        assert completion.input_tokens == 6
        assert completion.output_tokens == 4
        assert completion.cache_read_tokens == 3 and completion.cache_write_tokens == 1
        assert json.loads(completion.message.reasoning_signature) == signature
        rates = catalog_price("deepseek", "deepseek-flash")
        assert rates is not None
        expected_cost = token_cost_micro(6, 4, 3, 1, rates)
        async with _client(host) as client:
            created = await client.post("/api/v1/sessions", json={"title": "缓存"})
            assert created.status_code == 201
            session = created.json()["session_id"]
            path = session_database(host.profile.path, session)
            path.parent.mkdir(parents=True, mode=0o700)
            store = SessionStore(path, session, build=host.build)
            await store.initialize()
            try:
                await store.accept(Submit(request_id="cached", text="你好"), HostFence(host_epoch=0, build_id=host.build))
                action = None
                for _ in range(8):
                    step = await store.advance()
                    if isinstance(step, ModelInvocation):
                        action = step
                        break
                assert isinstance(action, ModelInvocation)
                await store.advance(ModelReturned(action, completion))
                stored = await store.messages("cached")
                if not any(message.role == "assistant" for message in stored):
                    await store.advance()
                    stored = await store.messages("cached")
            finally:
                await store.db.close()
            report = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert report["input_tokens"] == 6 and report["output_tokens"] == 4
            assert report["cache_read_tokens"] == 3 and report["cache_write_tokens"] == 1
            assert report["reasoning_signatures"] == 1 and report["priced"] is True
            assert report["cost_micro_usd"] == expected_cost
            assert "opaque/sig+=" not in json.dumps(report)
        assistant = next(message for message in stored if message.role == "assistant")
        replay = provider_messages([assistant], "deepseek")
        sent = next(message for message in replay if message["role"] == "assistant")
        assert sent["reasoning_details"] == signature
        assert sent["reasoning_content"] == ""
    finally:
        server.close()
        await server.wait_closed()
        await host.store.db.close()


def test_page_shows_usage_and_diagnostics_for_the_selected_session() -> None:
    node = shutil.which("node")
    if node is None:
        raise AssertionError("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    from amazme_backend.contracts import Stream
    schema = Stream.model_json_schema()
    contract = "const root = " + json.dumps(schema) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    session = "d" * 32
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=''' + session + r'''&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.endsWith('/usage')) { seen.push(path); return response({session_id:''' + json.dumps(session) + r''',model_calls:1,input_tokens:6,output_tokens:4,cache_read_tokens:3,cache_write_tokens:1,reasoning_signatures:1,priced_calls:1,unpriced_calls:0,priced:true,cost_micro_usd:6}); }
          if(path.endsWith('/diagnostics')) { seen.push(path); return response({session_id:''' + json.dumps(session) + r''',present:true,state:'ready',blocked_code:'',failed:0,unknown:0,error_codes:[]}); }
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        await until(()=>$('sessions').textContent.includes('工作区'));
        $('usage-load').click();
        await until(()=>$('usage-report').textContent.includes('美元'));
        assert.equal($('usage-report').textContent, '1 次模型调用 · 输入 6 · 输出 4 · 缓存读 3 · 缓存写 1 · 推理签名 1 · 0.000006 美元');
        $('diagnostic-load').click();
        await until(()=>$('diagnostic-report').textContent.includes('ready'));
        assert.equal($('diagnostic-report').textContent, 'ready · 失败 0 · 未知 0 · 无');
        assert.deepEqual(seen, [''' + json.dumps(f"/api/v1/sessions/{session}/usage") + r''', ''' + json.dumps(f"/api/v1/sessions/{session}/diagnostics") + r''']);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
