"""Projects, settings, feedback, shares, and new-format import do not touch old data or secrets."""

import base64
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import ExportBundle, HostFence, ProcessLease, Submit
from amazme_backend.host import Host, application
from amazme_backend.manage import bundle_digest
from amazme_backend.providers import Completion, stream
from amazme_backend.session_domain import ModelInvocation, ModelReturned
from amazme_backend.storage import SessionStore, session_database

SESSION = "a" * 32
PROJECT = "b" * 32
FEEDBACK = "c" * 32
SHARE = "d" * 32
KEY = "sk-test-not-real"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "manage", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": KEY, "proxy": "http://user:secret@127.0.0.1:9",
                     "headers": {"Authorization": "Bearer leaked"}}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def _message(host: Host, session: str, request_id: str, text: str) -> None:
    path = session_database(host.profile.path, session)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    store = SessionStore(path, session, build=host.build)
    await store.initialize()
    try:
        await store.accept(Submit(request_id=request_id, text=text), HostFence(host_epoch=0, build_id=host.build))
        for _ in range(8):
            if any(content == text for _request, _role, content in await store.transcript()):
                return
            action = await store.advance()
            if isinstance(action, ModelInvocation):
                async for item in stream(action.config, action.messages):
                    if isinstance(item, Completion):
                        await store.advance(ModelReturned(action, item))
    finally:
        await store.db.close()


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build,
        "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def test_management_export_hides_secrets_and_import_does_not_overwrite(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            project = await client.post("/api/v1/projects", json={"project_id": PROJECT, "name": "演示"})
            again = await client.post("/api/v1/projects", json={"project_id": PROJECT, "name": "演示"})
            changed = await client.post("/api/v1/projects", json={"project_id": PROJECT, "name": "另一个"})
            assert project.status_code == 200 and again.json()["name"] == "演示"
            assert changed.status_code == 409 and changed.json()["code"] == "project_conflict"
            listed_projects = await client.get("/api/v1/projects")
            assert listed_projects.status_code == 200
            assert listed_projects.json()["projects"] == [{"project_id": PROJECT, "name": "演示"}]
            missing = await client.post("/api/v1/sessions", json={"title": "孤立", "project_id": "e" * 32})
            assert missing.status_code == 404 and missing.json()["code"] == "project_not_found"
            created = await client.post("/api/v1/sessions", json={"title": "笔记", "project_id": PROJECT})
            assert created.status_code == 201 and created.json()["project_id"] == PROJECT
            session = created.json()["session_id"]
            kept = await client.post("/api/v1/sessions", json={"title": "保留"})
            assert kept.status_code == 201
            await _message(host, session, "hello", "你好")
            settings = await client.get("/api/v1/settings")
            assert settings.json() == {"display_name": "", "revision": 0}
            saved = await client.post("/api/v1/settings", json={"display_name": "甲", "expected_revision": 0})
            stale = await client.post("/api/v1/settings", json={"display_name": "乙", "expected_revision": 0})
            assert saved.json() == {"display_name": "甲", "revision": 1}
            assert stale.status_code == 409 and stale.json()["code"] == "settings_conflict"
            assert (await client.get("/api/v1/settings")).json()["display_name"] == "甲"
            secret = await client.post("/api/v1/feedback", json={
                "feedback_id": FEEDBACK, "session_id": session, "text": f"失败 {KEY}"})
            assert secret.status_code == 409 and secret.json()["code"] == "feedback_secret"
            assert KEY not in secret.text and "leaked" not in secret.text
            note = await client.post("/api/v1/feedback", json={
                "feedback_id": FEEDBACK, "session_id": session, "text": "界面卡住"})
            conflict = await client.post("/api/v1/feedback", json={
                "feedback_id": FEEDBACK, "session_id": session, "text": "另一句"})
            assert note.status_code == 200 and note.json()["session_id"] == session
            assert conflict.status_code == 409 and conflict.json()["code"] == "feedback_conflict"
            attached = await client.post(f"/api/v1/sessions/{session}/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            shared = await client.post(f"/api/v1/sessions/{session}/shares", json={"share_id": SHARE})
            assert shared.status_code == 200 and shared.json()["messages"] == [
                {"request_id": "hello", "role": "user", "content": "你好"}]
            assert KEY not in shared.text and "leaked" not in shared.text and "api_key" not in shared.text
            exported = await client.get("/api/v1/export")
            assert exported.status_code == 200 and exported.json()["format"] == "amazme-export/1"
            assert KEY not in exported.text and "leaked" not in exported.text and "api_key" not in exported.text
            assert bundle_digest(ExportBundle.model_validate(exported.json())) == exported.json()["digest"]
            repeat = await client.post("/api/v1/import", json=exported.json())
            assert repeat.status_code == 200 and repeat.json()["created"] == 0
            listed = await client.get("/api/v1/sessions")
            assert any(item["session_id"] == kept.json()["session_id"] and item["title"] == "保留"
                       for item in listed.json()["sessions"])
            mutated = exported.json()
            mutated["sessions"][0]["title"] = "改掉"
            mutated["digest"] = bundle_digest(ExportBundle.model_validate(mutated))
            refused = await client.post("/api/v1/import", json=mutated)
            assert refused.status_code == 409 and refused.json()["code"] == "import_conflict"
            assert any(item["title"] == "笔记" for item in (await client.get("/api/v1/sessions")).json()["sessions"])
            old = await client.post("/api/v1/import", json={"format": "jsonl", "digest": "", "sessions": []})
            assert old.status_code == 409 and old.json()["code"] == "import_format"
            tampered = exported.json()
            tampered["digest"] = "0" * 64
            assert (await client.post("/api/v1/import", json=tampered)).json()["code"] == "import_digest"
            await _message(host, session, "secret-note", KEY)
            hidden = await client.get("/api/v1/export")
            assert hidden.status_code == 409 and hidden.json()["code"] == "export_secret" and KEY not in hidden.text
            stored = await client.get(f"/api/v1/sessions/{session}/shares/{SHARE}")
            assert stored.json()["messages"] == [{"request_id": "hello", "role": "user", "content": "你好"}]
            blocked = await client.post(f"/api/v1/sessions/{session}/shares", json={"share_id": SHARE})
            assert blocked.status_code == 409 and blocked.json()["code"] == "share_conflict"
    finally:
        await host.supervisor.close()
        await host.store.db.close()


def test_browser_manages_the_selected_session() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
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
        let projectPosted = false;
        const session = ''' + json.dumps(SESSION) + r''';
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : {};
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions' && method==='GET') return response({sessions:[{session_id:session,title:'演示',archived:false,workspace:'primary',project_id:'project'}]});
          if(path==='/api/v1/sessions' && method==='POST') {
            seen.push('session '+body.project_id);
            return response({session_id:session,title:body.title,project_id:body.project_id,parent_id:'',fork_request_id:'',archived:false,workspace:'primary'},201);
          }
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:session,build_id:'build',host_epoch:1});
          if(path==='/api/v1/projects' && method==='GET') {
            seen.push('GET /api/v1/projects');
            const projects = projectPosted
              ? [{project_id:'p', name:'北窗'}, {project_id:'q', name:'演示'}]
              : [{project_id:'p', name:'北窗'}];
            return response({projects});
          }
          if(path==='/api/v1/projects' && method==='POST') {
            projectPosted = true;
            seen.push('project '+body.name);
            return response({project_id:body.project_id,name:body.name});
          }
          if(path==='/api/v1/settings' && method==='GET') return response({display_name:'',revision:0});
          if(path==='/api/v1/settings' && method==='POST') {
            seen.push('settings '+body.display_name+' '+body.expected_revision);
            return response({display_name:body.display_name,revision:body.expected_revision+1});
          }
          if(path==='/api/v1/feedback' && method==='POST') {
            seen.push('feedback '+body.session_id+' '+body.text);
            return response({feedback_id:body.feedback_id,session_id:body.session_id,text:body.text});
          }
          if(path===`/api/v1/sessions/${session}/shares` && method==='POST') {
            seen.push('share '+path);
            return response({share_id:body.share_id,session_id:session,digest:'abcdef1234567890',messages:[]});
          }
          if(path==='/api/v1/export') {
            seen.push('export');
            return response({format:'amazme-export/1',digest:'abc',projects:[],sessions:[],feedback:[],settings:{display_name:'',revision:0}});
          }
          if(path==='/api/v1/import' && method==='POST') {
            seen.push('import '+body.format+' '+String(Object.hasOwn(body,'api_key')));
            return response({format:'amazme-export/1',sessions:0,created:0});
          }
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent+' '+$('manage-state').textContent);
        }
        await import(appURL);
        await until(()=>$('sessions').textContent.includes('演示'));
        $('manage').querySelector('summary').click();
        await until(()=>$('manage-projects').textContent === '北窗');
        $('manage-project-name').value = '演示';
        $('manage-project').requestSubmit();
        await until(()=>$('manage-projects').textContent === '北窗\n演示');
        $('manage-name').value = '甲';
        $('manage-settings').requestSubmit();
        await until(()=>$('manage-state').textContent.includes('甲 · 1'));
        $('manage-feedback-text').value = '界面卡住';
        $('manage-feedback').requestSubmit();
        await until(()=>$('manage-state').textContent===session);
        $('manage-share').click();
        await until(()=>$('manage-state').textContent.includes('abcdef12'));
        $('manage-export').click();
        await until(()=>$('manage-state').textContent.includes('amazme-export/1'));
        $('manage-import').requestSubmit();
        await until(()=>$('manage-state').textContent.includes('amazme-export/1 · 0'));
        assert.equal(seen.filter(item => item==='GET /api/v1/projects').length >= 2, true);
        assert.equal(seen.includes('project 演示'), true);
        assert.equal(seen.some(item => /^session [a-f0-9]{32}$/.test(item)), true);
        assert.equal(seen.includes('settings 甲 0'), true);
        assert.equal(seen.includes('feedback '+session+' 界面卡住'), true);
        assert.equal(seen.includes('share /api/v1/sessions/'+session+'/shares'), true);
        assert.equal(seen.includes('export'), true);
        assert.equal(seen.includes('import amazme-export/1 false'), true);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
