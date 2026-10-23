"""One scheduler fires a zoned automation once and keeps the receipt."""

import json
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import CreateSession, HostFence, ProcessLease
from amazme_backend.host import Host, application

SESSION = "a" * 32
OTHER = "b" * 32


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "auto", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def _deliveries(host: Host, session: str) -> int:
    row = await host.store.db.call(lambda db: db.execute(
        "SELECT count(*) FROM deliveries WHERE session=?", (session,)).fetchone())
    assert row is not None
    return int(row[0])


async def test_scheduler_fires_each_due_automation_once_and_rejects_dst_guesses(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    await host.store.create_session(SESSION, CreateSession(title="定时"))
    await host.store.create_session(OTHER, CreateSession(title="另一"))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.build,
            "x-amazme-epoch": str(host.fence.host_epoch),
        }) as client:
            gap = await client.post("/api/v1/automations", json={
                "automation_id": "c" * 32, "session_id": SESSION, "text": "gap",
                "zone": "America/New_York", "local": "2026-03-08T02:30"})
            assert gap.status_code == 409 and gap.json()["code"] == "automation_time_gap"
            missing = await client.post("/api/v1/automations", json={
                "automation_id": "d" * 32, "session_id": SESSION, "text": "fold",
                "zone": "America/New_York", "local": "2026-11-01T01:30"})
            assert missing.status_code == 409 and missing.json()["code"] == "automation_time_fold"
            earlier = await client.post("/api/v1/automations", json={
                "automation_id": "e" * 32, "session_id": SESSION, "text": "earlier",
                "zone": "America/New_York", "local": "2026-11-01T01:30", "fold": 0})
            later = await client.post("/api/v1/automations", json={
                "automation_id": "f" * 32, "session_id": SESSION, "text": "later",
                "zone": "America/New_York", "local": "2026-11-01T01:30", "fold": 1})
            assert earlier.status_code == 200 and later.status_code == 200
            assert later.json()["due_ms"] - earlier.json()["due_ms"] == 3_600_000
            first = await client.post("/api/v1/automations", json={
                "automation_id": "3" * 32, "session_id": SESSION, "text": "run once",
                "zone": "America/New_York", "local": "2026-01-15T10:00"})
            again = await client.post("/api/v1/automations", json={
                "automation_id": "3" * 32, "session_id": SESSION, "text": "run once",
                "zone": "America/New_York", "local": "2026-01-15T10:00"})
            changed = await client.post("/api/v1/automations", json={
                "automation_id": "3" * 32, "session_id": SESSION, "text": "different",
                "zone": "America/New_York", "local": "2026-01-15T10:00"})
            assert first.status_code == 200 and again.json()["due_ms"] == first.json()["due_ms"]
            assert changed.status_code == 409 and changed.json()["code"] == "automation_conflict"
            second = await client.post("/api/v1/automations", json={
                "automation_id": "4" * 32, "session_id": OTHER, "text": "second",
                "zone": "America/New_York", "local": "2026-01-16T10:00"})
            assert second.status_code == 200
            fired = []
            for _ in range(3):
                tick = await client.post("/api/v1/automations/tick")
                assert tick.status_code == 200
                if tick.json()["fired"]:
                    fired.append(tick.json()["fired"]["automation_id"])
            assert fired.count("3" * 32) == 1 and fired.count("4" * 32) == 1
            assert await _deliveries(host, SESSION) == 1
            assert await _deliveries(host, OTHER) == 1
            late = await client.post("/api/v1/automations", json={
                "automation_id": "5" * 32, "session_id": SESSION, "text": "after archive",
                "zone": "America/New_York", "local": "2026-02-01T10:00"})
            assert late.status_code == 200
            await host.store.set_archived(SESSION, True)
            skipped = await client.post("/api/v1/automations/tick")
            assert skipped.json()["fired"]["automation_id"] == "5" * 32
            assert skipped.json()["fired"]["phase"] == "unknown"
            assert skipped.json()["fired"]["delivery_id"] == ""
            quiet = await client.post("/api/v1/automations/tick")
            assert quiet.json()["fired"] is None
            assert await _deliveries(host, SESSION) == 1
    finally:
        await host.supervisor.close()
        await host.store.db.close()


def test_browser_schedules_the_selected_session() -> None:
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
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst boundSession=" + json.dumps(SESSION) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session='+boundSession+'&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : {};
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(SESSION) + r''',title:'工作区',archived:false,workspace:'primary'}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(SESSION) + r''',build_id:'build',host_epoch:1});
          if(path==='/api/v1/automations' && method==='POST') {
            seen.push(body.session_id + ' ' + body.zone + ' ' + body.local);
            return response({automation_id:body.automation_id,session_id:body.session_id,workspace:'primary',text:body.text,zone:body.zone,local:body.local,fold:0,due_ms:1768485600000,phase:'scheduled',delivery_id:''});
          }
          if(path==='/api/v1/automations/tick') {
            seen.push('tick');
            return response({fired:{automation_id:'a',session_id:''' + json.dumps(SESSION) + r''',workspace:'primary',text:'run',zone:'America/New_York',local:'2026-01-15T09:00',fold:0,due_ms:1,phase:'done',delivery_id:'receipt'}});
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
        $('automation-text').value = 'run';
        $('automation-local').value = '2026-01-15T09:00';
        $('automation-form').requestSubmit();
        await until(()=>$('automation-state').textContent.includes('scheduled'));
        $('automation-tick').click();
        await until(()=>$('automation-state').textContent.includes('receipt'));
        assert.equal(seen[0], ''' + json.dumps(SESSION + " America/New_York 2026-01-15T09:00") + r''');
        assert.equal(seen[1], 'tick');
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
