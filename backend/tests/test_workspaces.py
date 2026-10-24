"""Extra workspace grants share one host and guest path. HOME is not mounted."""

import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import HostFence, ProcessLease
from amazme_backend.host import Host, application
from amazme_backend.pty_gate import WINDOW
from amazme_backend.pty_session import PtyClient

SESSION = "b" * 32


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "maps", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def _ready(host: Host) -> None:
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(host.profile.path),
                         path=str(host.profile.path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build, "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def test_grant_maps_the_same_absolute_path_for_files_and_tools(tmp_path: Path) -> None:
    host = _host(tmp_path)
    other = tmp_path.parent / f"grant-{tmp_path.name}"
    other.mkdir()
    (other / "note.txt").write_text("from-other\n")
    (tmp_path / "primary" / "note.txt").write_text("from-primary\n")
    await _ready(host)
    try:
        async with _client(host) as client:
            created = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(other)})
            assert created.status_code == 200
            assert created.json()["host_path"] == str(other)
            listed = await client.get("/api/v1/files", params={"path": "grant/docs"})
            assert listed.json()["absolute_path"] == str(other)
            assert any(item["name"] == "note.txt" for item in listed.json()["entries"])
            primary = await client.get("/api/v1/files/content", params={"path": "note.txt"})
            assert primary.json()["content"] == "from-primary\n"
            assert primary.json()["absolute_path"] == str(tmp_path / "primary/note.txt")
            extra = await client.get("/api/v1/files/content", params={"path": "grant/docs/note.txt"})
            assert extra.json()["content"] == "from-other\n"
            assert extra.json()["absolute_path"] == str(other / "note.txt")
            saved = await client.post("/api/v1/files/content", json={
                "path": "grant/docs/note.txt", "content": "changed\n", "expected_digest": extra.json()["digest"]})
            assert saved.status_code == 200
            assert (other / "note.txt").read_text() == "changed\n"
            assert (tmp_path / "primary" / "note.txt").read_text() == "from-primary\n"
            removed = await client.delete("/api/v1/workspaces/docs")
            assert removed.status_code == 200
            missing = await client.get("/api/v1/files/content", params={"path": "grant/docs/note.txt"})
            assert missing.status_code == 404
        assert (other / "note.txt").read_text() == "changed\n"
    finally:
        shutil.rmtree(other, ignore_errors=True)
        await host.supervisor.close()
        await host.store.db.close()


async def test_grant_rejects_home_symlink_profile_and_socket(tmp_path: Path) -> None:
    host = _host(tmp_path)
    await _ready(host)
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path / "primary", target_is_directory=True)
    socket_dir = tmp_path / "docker.sock"
    socket_dir.mkdir()
    try:
        async with _client(host) as client:
            for path in (Path.home(), host.profile.path, linked, socket_dir):
                rejected = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(path)})
                assert rejected.status_code == 409
                assert rejected.json()["code"] in {"workspace_grant_forbidden", "workspace_symlink"}
            again = await client.get("/api/v1/workspaces")
            assert [item["name"] for item in again.json()["workspaces"]] == ["primary"]
    finally:
        await host.supervisor.close()
        await host.store.db.close()


def test_terminal_cwd_rejects_a_host_path() -> None:
    gate = (Path(__file__).parents[1] / "src/amazme_backend/pty_gate.py").read_text()
    left, right = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, "-I", "-c", gate],
        stdin=right.fileno(), stdout=right.fileno(), stderr=subprocess.PIPE, pass_fds=(right.fileno(),))
    right.close()
    client = PtyClient(left)
    try:
        with pytest.raises(Exception):
            client.permit("pwd", os.getuid(), os.getgid(), 80, 24, "/tmp")
        assert WINDOW
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


def test_browser_switches_to_the_granted_absolute_path() -> None:
    node = __import__("shutil").which("node")
    if node is None:
        pytest.skip("node unavailable")
    import base64
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
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(SESSION) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(SESSION) + r''',build_id:'build',host_epoch:1});
          if(path==='/api/v1/workspaces' && method==='GET') return response({workspaces:[
            {name:'primary',host_path:'/work',host_path:'/workspace',primary:true},
            {name:'docs',host_path:'/other',host_path:'/grant/docs',primary:false}]});
          if(path==='/api/v1/files' || path.startsWith('/api/v1/files?')) {
            seen.push(path);
            if(path.includes('grant%2Fdocs') || path.includes('grant/docs')) return response({path:'grant/docs',absolute_path:'/grant/docs',entries:[{name:'note.txt',kind:'file',size:4}],truncated:false});
            return response({path:'',absolute_path:'/workspace',entries:[{name:'keep.txt',kind:'file',size:4}],truncated:false});
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
        await until(()=>$('workspace-location').textContent==='/workspace' && [...$('file-list').children].some(node=>node.textContent==='keep.txt'));
        [...$('workspace-list').children].find(node=>node.textContent==='docs').click();
        await until(()=>$('workspace-location').textContent==='/grant/docs' && [...$('file-list').children].some(node=>node.textContent==='note.txt'));
        assert.ok(seen.some(path=>path.includes('grant')));
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
