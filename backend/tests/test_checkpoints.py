"""A file checkpoint previews without writing and restores only that path."""

import json
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import HostFence, ProcessLease
from amazme_backend.host import Host, application


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "checks", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def test_checkpoint_preview_does_not_write_and_restore_is_selective(tmp_path: Path) -> None:
    host = _host(tmp_path)
    root = tmp_path / "primary"
    (root / "note.txt").write_text("alpha\n")
    (root / "other.txt").write_text("leave\n")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.build,
            "x-amazme-epoch": str(host.fence.host_epoch),
        }) as client:
            current = await client.get("/api/v1/files/content", params={"path": "note.txt"})
            saved = await client.post("/api/v1/checkpoints", json={
                "checkpoint_id": "a" * 32, "workspace": "primary", "path": "note.txt"})
            assert saved.status_code == 200 and saved.json()["digest"] == current.json()["digest"]
            changed = await client.post("/api/v1/files/content", json={
                "path": "note.txt", "content": "beta\n", "expected_digest": current.json()["digest"]})
            assert changed.status_code == 200
            assert (root / "note.txt").read_text() == "beta\n"
            preview = await client.get("/api/v1/checkpoints/" + "a" * 32)
            assert preview.status_code == 200
            assert preview.json()["content"] == "alpha\n"
            assert "beta" in preview.json()["diff"]
            assert (root / "note.txt").read_text() == "beta\n"
            conflict = await client.post("/api/v1/checkpoints", json={
                "checkpoint_id": "a" * 32, "workspace": "primary", "path": "note.txt"})
            assert conflict.status_code == 409 and conflict.json()["code"] == "checkpoint_conflict"
            stale = await client.post("/api/v1/checkpoints/" + "a" * 32 + "/restore", json={
                "expected_digest": current.json()["digest"]})
            assert stale.status_code == 409 and stale.json()["code"] == "file_conflict"
            assert (root / "note.txt").read_text() == "beta\n"
            beta = await client.get("/api/v1/files/content", params={"path": "note.txt"})
            restored = await client.post("/api/v1/checkpoints/" + "a" * 32 + "/restore", json={
                "expected_digest": beta.json()["digest"]})
            assert restored.status_code == 200
            assert (root / "note.txt").read_text() == "alpha\n"
            assert (root / "other.txt").read_text() == "leave\n"
            listed = await client.get("/api/v1/checkpoints", params={"workspace": "primary", "path": "note.txt"})
            assert any(item["digest"] == beta.json()["digest"] for item in listed.json()["checkpoints"])
    finally:
        await host.supervisor.close()
        await host.store.db.close()


def test_browser_previews_a_checkpoint_without_replacing_the_editor() -> None:
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
        const checkpointIds = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : {};
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[]});
          if(path==='/api/v1/workspaces') return response({workspaces:[{name:'primary',host_path:'/work',host_path:'/workspace',primary:true}]});
          if(path.startsWith('/api/v1/files/content') && method==='GET') return response({path:'note.txt',digest:'abc',content:'beta\n',truncated:false,absolute_path:'/workspace/note.txt'});
          if(path==='/api/v1/files' || path.startsWith('/api/v1/files?')) return response({path:'',absolute_path:'/workspace',entries:[{name:'note.txt',kind:'file',size:5}],truncated:false});
          if(method==='GET' && path.startsWith('/api/v1/checkpoints?')) return response({checkpoints:[]});
          if(path==='/api/v1/checkpoints' && method==='POST') {
            checkpointIds.push(body.checkpoint_id);
            if(checkpointIds.length === 2) throw new Error('lost');
            seen.push(body.path);
            return response({checkpoint_id:body.checkpoint_id,workspace:body.workspace,path:body.path,digest:'aaa'});
          }
          if(method==='GET' && path.startsWith('/api/v1/checkpoints/')) {
            seen.push('preview');
            return response({checkpoint_id:path.split('/').at(-1),workspace:'primary',path:'note.txt',absolute_path:'/workspace/note.txt',digest:'aaa',content:'alpha\n',current_digest:'abc',diff:'--- alpha\n+++ beta\n'});
          }
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        $('files').open = true;
        $('files').dispatchEvent(new window.Event('toggle'));
        await until(()=>[...$('file-list').children].some(node=>node.textContent==='note.txt'));
        [...$('file-list').children].find(node=>node.textContent==='note.txt').click();
        await until(()=>$('file-content').value==='beta\n');
        $('checkpoint-save').click();
        await until(()=>$('file-diff').textContent.startsWith('已保存'));
        const before = $('file-content').value;
        $('checkpoint-preview').click();
        await until(()=>$('file-diff').textContent.includes('alpha'));
        assert.equal($('file-content').value, before);
        assert.deepEqual(seen, ['note.txt', 'preview']);
        $('checkpoint-save').click();
        await until(()=>$('error').textContent === 'lost');
        $('checkpoint-save').click();
        await until(()=>$('file-diff').textContent.startsWith('已保存') && checkpointIds.length === 3);
        assert.equal(checkpointIds[1], checkpointIds[2]);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
