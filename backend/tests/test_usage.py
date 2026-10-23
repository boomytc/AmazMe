"""Session usage reads tokens stored with finished model calls and does not invent a price."""

import base64
import json
import shutil
import subprocess
from pathlib import Path

import httpx

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import HostFence, ProcessLease, Receipt, Submit
from amazme_backend.host import Host, application
from amazme_backend.providers import Completion, stream
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


async def test_usage_totals_follow_visible_answers_and_have_no_price(tmp_path: Path) -> None:
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
                "session_id": session, "model_calls": 0, "input_tokens": 0, "output_tokens": 0, "priced": False}
            first = await _finish_prompt(host, session, "one", "你好")
            assert first.decision is not None and first.decision.answer
            once = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert once["model_calls"] == 1
            assert once["input_tokens"] == len("你好")
            assert once["output_tokens"] == len(first.decision.answer)
            assert once["priced"] is False and "cost" not in once
            assert KEY not in json.dumps(once)
            second = await _finish_prompt(host, session, "two", "再来")
            assert second.decision is not None and second.decision.answer
            twice = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert twice["model_calls"] == 2
            # The second call sees the first user text, its visible answer, and the new text.
            assert twice["input_tokens"] == once["input_tokens"] + len("你好") + len(first.decision.answer) + len("再来")
            assert twice["output_tokens"] == len(first.decision.answer) + len(second.decision.answer)
            assert twice["priced"] is False
    finally:
        await host.store.db.close()


def test_page_shows_unpriced_usage_for_the_selected_session() -> None:
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
          if(path.endsWith('/usage')) { seen.push(path); return response({session_id:''' + json.dumps(session) + r''',model_calls:2,input_tokens:4,output_tokens:9,priced:false}); }
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
        await until(()=>$('usage-report').textContent.includes('未计价'));
        assert.equal($('usage-report').textContent, '2 次模型调用 · 输入 4 · 输出 9 · 未计价');
        assert.deepEqual(seen, [''' + json.dumps(f"/api/v1/sessions/{session}/usage") + r''']);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
