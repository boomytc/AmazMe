"""A session artifact is stored once, read back from disk, and not replaced by a conflicting retry."""

import base64
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import httpx

from amazme_backend.artifacts import ArtifactView
from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import HostFence, ProcessLease, Session
from amazme_backend.host import Host, application
from amazme_backend.sdk import Client
from amazme_backend.storage import session_database

KEY = "sk-test-not-real"
BODY = b"hello artifact"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "artifacts", "workspace": str(tmp_path / "primary"), "resources": "unused",
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


def _payload(data: bytes, *, name: str = "记录.txt", media_type: str = "text/plain") -> dict[str, str]:
    return {
        "artifact_id": "note1", "name": name, "media_type": media_type,
        "data_base64": base64.b64encode(data).decode(),
    }


async def test_artifact_is_stored_once_and_a_conflict_keeps_the_original(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            missing = await client.get("/api/v1/sessions/" + "e" * 32 + "/artifacts")
            assert missing.status_code == 404 and missing.json()["code"] == "session_not_found"
            created = await client.post("/api/v1/sessions", json={"title": "产物"})
            assert created.status_code == 201
            session = created.json()["session_id"]
            path = f"/api/v1/sessions/{session}/artifacts"
            unattached = await client.post(path, json=_payload(BODY))
            assert unattached.status_code == 409 and unattached.json()["code"] == "stale_client_binding"
            attached = await client.post(f"/api/v1/sessions/{session}/attachments")
            assert attached.status_code == 201
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            secret = await client.post(path, json=_payload(KEY.encode(), name="key.txt"))
            assert secret.status_code == 409 and secret.json()["code"] == "artifact_secret"
            assert KEY not in secret.text
            saved = await client.post(path, json=_payload(BODY))
            assert saved.status_code == 201
            view = saved.json()
            assert view["name"] == "记录.txt" and view["size"] == len(BODY)
            assert view["digest"] == hashlib.sha256(BODY).hexdigest()
            again = await client.post(path, json=_payload(BODY))
            assert again.status_code == 201 and again.json()["digest"] == view["digest"]
            conflict = await client.post(path, json=_payload(b"other bytes"))
            assert conflict.status_code == 409 and conflict.json()["code"] == "artifact_conflict"
            renamed = await client.post(path, json=_payload(BODY, name="另一份.txt"))
            assert renamed.status_code == 409 and renamed.json()["code"] == "artifact_conflict"
            listed = await client.get(path)
            assert listed.status_code == 200
            assert [item["artifact_id"] for item in listed.json()["artifacts"]] == ["note1"]
            fetched = await client.get(path + "/note1")
            assert fetched.status_code == 200
            assert base64.b64decode(fetched.json()["data_base64"]) == BODY
            assert KEY not in fetched.text
            binary = session_database(host.profile.path, session).parent / "artifacts" / "note1.bin"
            assert binary.read_bytes() == BODY
            assert list(binary.parent.glob("*.bin")) == [binary]
            other = tmp_path / "other.txt"
            other.write_text("secret-neighbor")
            meta = binary.with_suffix(".json")
            meta.unlink()
            meta.symlink_to(other)
            refused = await client.get(path)
            assert refused.status_code == 409 and refused.json()["code"] == "artifact_refused"
            assert "secret-neighbor" not in refused.text
    finally:
        await host.store.db.close()


async def test_sdk_put_artifact_sends_the_bytes() -> None:
    client = Client("http://127.0.0.1:9", "token")
    seen: dict[str, object] = {}

    async def session(session_id: str) -> Session:
        return Session(session_id=session_id, title="产物", workspace="primary")

    async def send(method: str, path: str, *, json_body: object | None = None,
                   headers: dict[str, str] | None = None) -> object:
        del method, path, headers
        seen["body"] = json_body
        return {"artifact_id": "note1", "name": "记录.txt", "media_type": "text/plain",
                "size": len(BODY), "digest": "abc"}

    client.session = session  # type: ignore[method-assign]
    client._send = send  # type: ignore[method-assign]
    try:
        view = await client.put_artifact(
            session_id="s" * 32, workspace="primary", attachment_id="bind",
            artifact_id="note1", name="记录.txt", data=BODY, media_type="text/plain")
        assert isinstance(view, ArtifactView)
        body = seen["body"]
        assert isinstance(body, dict)
        assert base64.b64decode(str(body["data_base64"])) == BODY
    finally:
        await client._http.aclose()


def test_page_saves_an_artifact_and_reads_it_back() -> None:
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
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session=''' + session + r'''&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,FileReader:window.FileReader,atob,WebSocket:class{
          constructor(){ queueMicrotask(()=>this.onopen?.()); }
          send(raw){
            const frame=JSON.parse(raw);
            if(frame.kind==='hello') queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot,batches:[],stream_id:'stream',binding_id:frame.binding_id,build_id:'build',resync:'initial'})}));
          }
          close(){}
        }});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const stored = new Map();
        const snapshot = {session_id:''' + json.dumps(session) + r''',stream_id:'stream',seq:'1',state:'ready',requests:[],events:[],approvals:[],effects:[],previews:[],pending:0,next_wake_ms:0,compaction:''};
        globalThis.fetch = async (path, options={}) => {
          const method = options.method || 'GET';
          if (path === '/api/v1/bootstrap') return response(identity);
          if (path === '/api/v1/health') return response({state:'ready',identity});
          if (path === '/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'产物',workspace:'primary'}]});
          if (path === '/api/v1/models') return response({models:[],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if (path.endsWith('/attachments') && method === 'POST') return response({attachment_id:'bind',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1},201);
          if (path.endsWith('/snapshot')) return response(snapshot);
          if (path.endsWith('/artifacts') && method === 'POST') {
            const body = JSON.parse(options.body);
            stored.set(body.artifact_id, body);
            return response({artifact_id:body.artifact_id,name:body.name,media_type:body.media_type,size:atob(body.data_base64).length,digest:'abc'},201);
          }
          if (path.endsWith('/artifacts') && method === 'GET') {
            return response({artifacts:[...stored.values()].map(body => ({artifact_id:body.artifact_id,name:body.name,media_type:body.media_type,size:atob(body.data_base64).length,digest:'abc'}))});
          }
          const id = path.split('/').pop();
          if (path.includes('/artifacts/') && stored.has(id)) {
            const body = stored.get(id);
            return response({artifact_id:id,name:body.name,media_type:body.media_type,size:atob(body.data_base64).length,digest:'abc',data_base64:body.data_base64});
          }
          if (path.includes('/attachments/')) return response({detached:true});
          return response({});
        };
        const $=id=>document.getElementById(id);
        await import(appURL);
        for (let n=0;n<50 && $('connection').textContent!=='已连接';n++) await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal($('connection').textContent,'已连接', $('error').textContent);
        $('artifact-name').value = '记录.txt';
        const file = new window.File([new TextEncoder().encode('hello artifact')], '记录.txt', {type:'text/plain'});
        Object.defineProperty($('artifact-file'), 'files', {configurable:true, value:[file]});
        await $('artifact-form').onsubmit({preventDefault(){}});
        assert.equal($('error').textContent,'');
        assert.match($('artifact-list').textContent,/记录\.txt · 14/);
        $('artifact-list').querySelector('button').click();
        for (let n=0;n<20 && !$('artifact-body').textContent.includes('hello artifact');n++) await new Promise(resolve=>setTimeout(resolve,10));
        assert.match($('artifact-body').textContent,/hello artifact/);
        process.exit(0);
    '''
    try:
        result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20)
    except subprocess.TimeoutExpired as exc:
        err = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        raise AssertionError(err[-1500:]) from None
    if result.returncode != 0:
        raise AssertionError((result.stderr or result.stdout)[-1500:])
