"""Desktop actions follow the fixed driver: permissions, pixels, freshness, and cleanup."""

import asyncio
import base64
import json
import shutil
import subprocess
from pathlib import Path
from typing import Literal

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import CreateSession, HostFence, ProcessLease
from amazme_backend.host import Host, application
from amazme_backend.storage import session_database

SESSION = "a" * 32
OTHER = "b" * 32


def _host(tmp_path: Path, scenario: Literal["unconfigured", "denied", "granted", "plain", "hold", "drop"]) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "desk", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    host.computer_scenario = scenario
    return host


def _actions(host: Host, session: str) -> list[dict[str, object]]:
    path = session_database(host.profile.path, session).parent / "computer-actions.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


async def _stop(host: Host) -> None:
    for driver in list(host.computer_drivers.values()):
        await asyncio.to_thread(driver.stop)
    host.computer_drivers.clear()
    await host.supervisor.close()
    await host.store.db.close()


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build,
        "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def _open(host: Host, client: httpx.AsyncClient, session: str) -> None:
    await host.store.create_session(session, CreateSession(title="桌面"))
    attached = await client.post(f"/api/v1/sessions/{session}/attachments")
    assert attached.status_code == 201
    client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]


async def test_missing_permission_sends_no_click_and_pixels_follow_the_driver(tmp_path: Path) -> None:
    host = _host(tmp_path, "denied")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            await _open(host, client, SESSION)
            blocked = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "early", "capture_id": "missing", "x": 1, "y": 4})
            assert blocked.status_code == 409 and blocked.json()["code"] == "computer_disabled"
            assert _actions(host, SESSION) == []
            enabled = await client.post(f"/api/v1/sessions/{SESSION}/computer", json={"enabled": True})
            assert enabled.status_code == 200 and enabled.json()["enabled"] is True
            denied = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            assert denied.status_code == 200 and denied.json()["error"] == "permission_required"
            assert denied.json()["permitted"] is False and denied.json()["capture"] is None
            assert denied.json()["identity"] == "fixed-computer-driver"
            stale = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "nope", "capture_id": "missing", "x": 1, "y": 4,
                "accessibility": True})
            assert stale.status_code == 422 and _actions(host, SESSION) == []
            host.computer_scenario = "granted"  # type: ignore[assignment]
            seen = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            assert seen.status_code == 200 and seen.json()["permitted"] is True
            capture = seen.json()["capture"]["capture_id"]
            assert seen.json()["capture"]["width"] == 10 and seen.json()["capture"]["height"] == 20
            acted = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "click", "capture_id": capture, "x": 1, "y": 4})
            assert acted.status_code == 200 and acted.json()["phase"] == "done"
            assert acted.json()["driver_x"] == 8 and acted.json()["driver_y"] == 16
            assert _actions(host, SESSION) == [{"op": "act", "capture_id": capture, "x": 8, "y": 16}]
            again = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "click", "capture_id": capture, "x": 1, "y": 4})
            changed = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "click", "capture_id": capture, "x": 2, "y": 4})
            assert again.json()["driver_x"] == 8 and changed.status_code == 409
            assert changed.json()["code"] == "computer_action_conflict"
            fresh = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            old = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "old", "capture_id": capture, "x": 1, "y": 4})
            assert old.status_code == 409 and old.json()["code"] == "computer_stale"
            assert _actions(host, SESSION) == [{"op": "act", "capture_id": capture, "x": 8, "y": 16}]
            assert fresh.json()["capture"]["capture_id"] != capture
    finally:
        await _stop(host)


async def test_dropped_action_stays_unknown_until_cleanup_proof(tmp_path: Path) -> None:
    host = _host(tmp_path, "drop")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            await _open(host, client, SESSION)
            await client.post(f"/api/v1/sessions/{SESSION}/computer", json={"enabled": True})
            seen = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            capture = seen.json()["capture"]["capture_id"]
            dropped = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "drop", "capture_id": capture, "x": 1, "y": 4})
            assert dropped.status_code == 200 and dropped.json()["phase"] == "unknown"
            assert dropped.json()["driver_x"] is None and _actions(host, SESSION) == []
            retry = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "drop", "capture_id": capture, "x": 1, "y": 4})
            assert retry.json()["phase"] == "unknown" and _actions(host, SESSION) == []
            blocked = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "next", "capture_id": capture, "x": 1, "y": 4})
            assert blocked.status_code == 409 and blocked.json()["code"] == "computer_blocked"
            observe = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            assert observe.status_code == 409 and observe.json()["code"] == "computer_blocked"
            cleaned = await client.post(f"/api/v1/sessions/{SESSION}/computer/cleanup")
            assert cleaned.status_code == 200 and cleaned.json()["cleared"] is True and cleaned.json()["proof"]
            repeat = await client.post(f"/api/v1/sessions/{SESSION}/computer/cleanup")
            assert repeat.json()["proof"] == cleaned.json()["proof"]
            resumed = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            assert resumed.status_code == 200 and resumed.json()["permitted"] is True
            assert resumed.json()["capture"]["capture_id"] != capture
    finally:
        await _stop(host)


async def test_a_second_action_does_not_start_while_the_first_is_unanswered(tmp_path: Path) -> None:
    host = _host(tmp_path, "hold")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            await _open(host, client, SESSION)
            await client.post(f"/api/v1/sessions/{SESSION}/computer", json={"enabled": True, "max_age_ms": 55000})
            seen = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe")
            capture = seen.json()["capture"]["capture_id"]
            first = asyncio.create_task(client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "first", "capture_id": capture, "x": 1, "y": 4}))
            for _ in range(50):
                if SESSION in host.computer_held:
                    break
                await asyncio.sleep(0.01)
            assert SESSION in host.computer_held
            second = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "second", "capture_id": capture, "x": 1, "y": 4})
            assert second.status_code == 409 and second.json()["code"] == "computer_busy"
            done = await first
            assert done.status_code == 200 and done.json()["driver_x"] == 8
            assert len(_actions(host, SESSION)) == 1
            await host.store.create_session(OTHER, CreateSession(title="过期"))
            host.computer_scenario = "plain"
            attached = await client.post(f"/api/v1/sessions/{OTHER}/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            await client.post(f"/api/v1/sessions/{OTHER}/computer", json={"enabled": True, "max_age_ms": 1})
            aged = await client.post(f"/api/v1/sessions/{OTHER}/computer/observe")
            old_capture = aged.json()["capture"]["capture_id"]
            await asyncio.sleep(0.05)
            expired = await client.post(f"/api/v1/sessions/{OTHER}/computer/actions", json={
                "action_id": "late", "capture_id": old_capture, "x": 3, "y": 4})
            assert expired.status_code == 409 and expired.json()["code"] == "computer_stale"
            assert _actions(host, OTHER) == []
            await client.post(f"/api/v1/sessions/{OTHER}/computer", json={"enabled": True, "max_age_ms": 55000})
            fresh = await client.post(f"/api/v1/sessions/{OTHER}/computer/observe")
            clicked = await client.post(f"/api/v1/sessions/{OTHER}/computer/actions", json={
                "action_id": "plain", "capture_id": fresh.json()["capture"]["capture_id"], "x": 3, "y": 4})
            assert clicked.json()["driver_x"] == 6 and clicked.json()["driver_y"] == 8
            assert _actions(host, OTHER) == [{
                "op": "act", "capture_id": fresh.json()["capture"]["capture_id"], "x": 6, "y": 8}]
    finally:
        await _stop(host)


def test_browser_clicks_the_selected_session_capture() -> None:
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
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst boundSession=" + json.dumps(SESSION) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session='+boundSession+'&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [];
        const session = ''' + json.dumps(SESSION) + r''';
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : {};
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:session,title:'工作区',archived:false,workspace:'primary'}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:session,build_id:'build',host_epoch:1});
          if(path===`/api/v1/sessions/${session}/computer` && method==='POST') {
            seen.push(path+' '+JSON.stringify(Object.keys(body).sort()));
            return response({enabled:true,max_age_ms:55000});
          }
          if(path===`/api/v1/sessions/${session}/computer/observe` && method==='POST') {
            seen.push(path);
            return response({permitted:true,accessibility:true,screen:true,identity:'fixed-computer-driver',error:'',capture:{capture_id:'cap',width:10,height:20,raw_width:20,raw_height:10,orientation:6,scale:2,observed_ms:1}});
          }
          if(path===`/api/v1/sessions/${session}/computer/actions` && method==='POST') {
            seen.push(path+' '+JSON.stringify(Object.keys(body).sort())+' '+body.capture_id+' '+body.x+','+body.y);
            if(body.y===9) seen.push('id '+body.action_id+' '+body.x+','+body.y);
            const repeat = seen.filter(item=>item==='id '+body.action_id+' '+body.x+','+body.y).length > 1;
            if(body.y===9 && !repeat) return response({action_id:body.action_id,session_id:session,phase:'unknown',error:'',driver_x:null,driver_y:null});
            return response({action_id:body.action_id,session_id:session,phase:'done',error:'',driver_x:8,driver_y:16});
          }
          if(path===`/api/v1/sessions/${session}/computer/cleanup`) {
            seen.push(path);
            return response({cleared:true,proof:'proof'});
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
        $('computer-enabled').checked = true;
        $('computer-form').requestSubmit();
        await until(()=>$('computer-state').textContent.includes('已启用'));
        $('computer-observe').click();
        await until(()=>$('computer-state').textContent.includes('10×20'));
        $('computer-act').requestSubmit();
        await until(()=>$('computer-state').textContent.includes('8,16'));
        $('computer-cleanup').click();
        await until(()=>$('computer-state').textContent.includes('proof'));
        assert.equal(seen[0], `/api/v1/sessions/${session}/computer ["enabled"]`);
        assert.equal(seen[1], `/api/v1/sessions/${session}/computer/observe`);
        assert.equal(seen[2], `/api/v1/sessions/${session}/computer/actions ["action_id","capture_id","x","y"] cap 1,4`);
        assert.equal(seen[3], `/api/v1/sessions/${session}/computer/cleanup`);
        $('computer-y').value = '9';
        $('computer-act').requestSubmit();
        await until(()=>$('computer-state').textContent.startsWith('unknown') && $('error').textContent.includes('同一画面'));
        const held = seen.filter(item=>item.startsWith('id '));
        assert.equal(held.length, 1);
        $('error').textContent = '';
        $('computer-x').value = '2';
        $('computer-act').requestSubmit();
        await until(()=>$('error').textContent.includes('同一画面'));
        assert.equal(seen.filter(item=>item.startsWith('id ')).length, 1);
        $('computer-x').value = '1';
        $('computer-act').requestSubmit();
        await until(()=>$('computer-state').textContent.includes('8,16'));
        const again = seen.filter(item=>item.startsWith('id '));
        assert.equal(again.length, 2);
        assert.equal(again[0], again[1]);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
