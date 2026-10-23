"""Memories stay inside one workspace and are injected only into that session's model call."""

import json
import shutil
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import CreateSession, HostFence, Message, ProcessLease, ProviderConfig
from amazme_backend.host import Host, application
from amazme_backend.providers import Completion
from amazme_backend.session_domain import ModelInvocation
from amazme_backend.worker import Worker

PRIMARY_SESSION = "a" * 32
DOCS_SESSION = "b" * 32
MEMORY = "c" * 32


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "mem", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def test_model_call_injects_only_the_session_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path)
    other = tmp_path.parent / f"mem-{tmp_path.name}"
    other.mkdir()
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    captured: list[list[Message]] = []

    async def fake_stream(config: ProviderConfig, messages: list[Message]):
        del config
        captured.append(messages)
        yield Completion(message=Message(role="assistant", content="ok"), response_id="faux")

    monkeypatch.setattr("amazme_backend.worker.stream", fake_stream)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.build,
            "x-amazme-epoch": str(host.fence.host_epoch),
        }) as client:
            granted = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(other)})
            assert granted.status_code == 200
            saved = await client.post("/api/v1/memories", json={
                "memory_id": MEMORY, "workspace": "primary", "text": "use alpha"})
            assert saved.status_code == 200
            other_memory = await client.post("/api/v1/memories", json={
                "memory_id": "d" * 32, "workspace": "docs", "text": "use beta"})
            assert other_memory.status_code == 200
            conflict = await client.post("/api/v1/memories", json={
                "memory_id": MEMORY, "workspace": "primary", "text": "use gamma"})
            assert conflict.status_code == 409 and conflict.json()["code"] == "memory_conflict"
            kept = await client.get("/api/v1/memories", params={"workspace": "primary", "q": "alpha"})
            assert [item["text"] for item in kept.json()["memories"]] == ["use alpha"]
            leaked = await client.get("/api/v1/memories", params={"workspace": "docs", "q": "alpha"})
            assert leaked.json()["memories"] == []
            await host.store.create_session(PRIMARY_SESSION, CreateSession(title="主", workspace="primary"))
            await host.store.create_session(DOCS_SESSION, CreateSession(title="文档", workspace="docs"))
            primary_preview = await client.get(f"/api/v1/sessions/{PRIMARY_SESSION}/memories", params={"q": "please use alpha"})
            assert [item["text"] for item in primary_preview.json()["memories"]] == ["use alpha"]
            docs_preview = await client.get(f"/api/v1/sessions/{DOCS_SESSION}/memories", params={"q": "please use beta"})
            assert [item["text"] for item in docs_preview.json()["memories"]] == ["use beta"]
            assert primary_preview.json()["workspace"] == "primary"
        primary = Worker(host.profile, PRIMARY_SESSION, "worker-primary")
        await primary.perform(ModelInvocation(
            "step", "request", 1, [Message(role="user", content="please use alpha")],
            ProviderConfig(provider="faux")))
        docs = Worker(host.profile, DOCS_SESSION, "worker-docs")
        await docs.perform(ModelInvocation(
            "step", "request", 1, [Message(role="user", content="please use beta")],
            ProviderConfig(provider="faux")))
        assert "use alpha" in captured[0][0].content and "use beta" not in captured[0][0].content
        assert captured[0][1].content == "please use alpha"
        assert "use beta" in captured[1][0].content and "use alpha" not in captured[1][0].content
    finally:
        shutil.rmtree(other, ignore_errors=True)
        await host.supervisor.close()
        await host.store.db.close()


def test_browser_saves_and_previews_memory_for_the_selected_session() -> None:
    node = __import__("shutil").which("node")
    if node is None:
        pytest.skip("node unavailable")
    import base64
    import subprocess
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    schema = __import__("amazme_backend.contracts", fromlist=["Stream"]).Stream.model_json_schema()
    contract = "const root = " + json.dumps(schema) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : {};
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(PRIMARY_SESSION) + r''',title:'工作区',archived:false,workspace:'docs'}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(PRIMARY_SESSION) + r''',build_id:'build',host_epoch:1});
          if(path==='/api/v1/memories' && method==='POST') {
            seen.push(body.workspace + ' ' + body.text);
            return response({memory_id:body.memory_id,workspace:body.workspace,text:body.text});
          }
          if(path.startsWith('/api/v1/memories?')) return response({workspace:'docs',memories:[{memory_id:'m',workspace:'docs',text:'use alpha'}]});
          if(path.includes('/memories?q=')) {
            seen.push(path);
            return response({workspace:'docs',memories:[{memory_id:'m',workspace:'docs',text:'use alpha'}]});
          }
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        await until(()=>$('sessions').textContent.includes('工作区'));
        $('memory').open = true;
        $('memory').dispatchEvent(new window.Event('toggle'));
        await until(()=>$('memory-list').textContent==='use alpha');
        $('memory-text').value = 'use alpha';
        $('memory-form').requestSubmit();
        await until(()=>seen.some(item=>item==='docs use alpha'));
        $('prompt').value = 'please use alpha';
        $('memory-preview').click();
        await until(()=>seen.some(item=>item.includes('/memories?q=')));
        assert.ok(seen.some(item=>item.includes('please%20use%20alpha') || item.includes('please+use+alpha')));
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
