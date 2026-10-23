"""Plugin identity stays behind the supervisor, and paused work blocks reload."""

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    CreateSession,
    HostFence,
    OpenPlugin,
    PluginCallEnvelope,
    ProcessLease,
    ReloadPlugin,
    Submit,
    WorkerSpec,
)
from amazme_backend.host import Host, application
from amazme_backend.plugin_run import GATE, PluginOutcome, plugin_fingerprint
from amazme_backend.storage import SessionStore, session_database
from amazme_backend.supervisor import Supervisor

PLUGIN = "a" * 32
SESSION = "b" * 32
CALL = "c" * 32


class IdleVM:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.image_id = "sha256:image"
        self.socket = profile.path / "docker.sock"
        self.vm_id = "vm"

    async def close(self) -> None:
        return None


async def supervisor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str) -> Supervisor:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "plugins", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    monkeypatch.setattr("amazme_backend.supervisor.VM", IdleVM)
    owner = Supervisor(Profile(tmp_path), name)
    await owner.initialize()
    owner.monitor_task.cancel()
    return owner


def opened(owner: Supervisor, *, name: str = "notes", label: str = "记事") -> OpenPlugin:
    return OpenPlugin(host_epoch=owner.host_epoch, build_id=owner.build, plugin_id=PLUGIN, name=name,
                      config={"label": label})


def test_gate_refuses_a_capability_it_does_not_implement(tmp_path: Path) -> None:
    source = (Path(__file__).parents[1] / "src/amazme_backend/plugin_gate.py").read_text()
    assert "sqlite" not in source and "subprocess" not in source
    process = __import__("subprocess").Popen(
        [sys.executable, "-I", "-c", GATE], cwd=tmp_path, stdin=__import__("subprocess").PIPE,
        stdout=__import__("subprocess").PIPE, stderr=__import__("subprocess").PIPE, text=True)
    process.communicate(json.dumps({"capability": "shell", "text": "no"}) + "\n", timeout=5)
    assert process.returncode != 0
    assert not (tmp_path / "stamp.txt").exists()


async def test_stamp_is_durable_and_a_live_worker_blocks_replacement(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner = await supervisor(tmp_path, monkeypatch, "plugin-supervisor")
    held: list[int] = []

    async def spawn(*args, **kwargs):
        held.append(os.dup(kwargs["pass_fds"][0]))
        return SimpleNamespace(pid=4242, returncode=None, wait=lambda: None)

    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    try:
        info = await owner.ensure_worker(WorkerSpec(
            build_id=owner.build, host_epoch=owner.host_epoch, session_id=SESSION))
        assert info.plugin_fingerprint == await owner.plugin_set_fingerprint()
        with pytest.raises(BackendError, match="plugin_reload_blocked"):
            await owner.register_plugin(opened(owner))
        os.close(held.pop())
        registered = await owner.register_plugin(opened(owner))
        assert registered.entry == "stamp" and registered.fingerprint == plugin_fingerprint(PLUGIN, "notes", {"label": "记事"})
        first = await owner.call_plugin(PluginCallEnvelope(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN,
            call_id=CALL, text="alpha"))
        stamp = tmp_path / "plugin-work" / PLUGIN / "stamp.txt"
        assert first.phase == "done" and first.result == "alpha" and stamp.read_text() == "alpha\n"
        again = await owner.call_plugin(PluginCallEnvelope(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN,
            call_id=CALL, text="alpha"))
        assert again.result == "alpha" and stamp.read_text() == "alpha\n"
        with pytest.raises(BackendError, match="plugin_call_conflict"):
            await owner.call_plugin(PluginCallEnvelope(
                host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN,
                call_id=CALL, text="beta"))
        assert stamp.read_text() == "alpha\n"
        reloaded = await owner.reload_plugin(ReloadPlugin(
            host_epoch=owner.host_epoch, build_id=owner.build, plugin_id=PLUGIN, config={"label": "改过"}))
        assert reloaded.fingerprint != registered.fingerprint and reloaded.config == {"label": "改过"}
        assert stamp.read_text() == "alpha\n"
        with pytest.raises(BackendError, match="plugin_config_rejected"):
            await owner.register_plugin(OpenPlugin(
                host_epoch=owner.host_epoch, build_id=owner.build, plugin_id="d" * 32, name="other",
                config={"sqlite": "host.sqlite"}))
    finally:
        for fd in held:
            os.close(fd)
        await owner.close()


async def test_unknown_plugin_exit_blocks_the_next_call_and_survives_restart(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner = await supervisor(tmp_path, monkeypatch, "plugin-unknown")
    try:
        await owner.register_plugin(opened(owner))
        monkeypatch.setattr("amazme_backend.supervisor.run_plugin_gate", lambda *args, **kwargs: PluginOutcome("unknown"))
        unknown = await owner.call_plugin(PluginCallEnvelope(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN,
            call_id=CALL, text="alpha"))
        assert unknown.phase == "unknown" and unknown.result == ""
        monkeypatch.setattr(
            "amazme_backend.supervisor.run_plugin_gate",
            lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("reran")))
        repeated = await owner.call_plugin(PluginCallEnvelope(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN,
            call_id=CALL, text="alpha"))
        assert repeated.phase == "unknown"
        with pytest.raises(BackendError, match="execution_cleanup_pending"):
            await owner.call_plugin(PluginCallEnvelope(
                host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN,
                call_id="e" * 32, text="beta"))
    finally:
        await owner.close()
    reopened = await supervisor(tmp_path, monkeypatch, "plugin-again")
    try:
        listed = await reopened.list_plugins()
        assert listed.plugins[0].plugin_id == PLUGIN and listed.plugins[0].config == {"label": "记事"}
    finally:
        await reopened.close()


async def test_waiting_work_blocks_plugin_registration_and_history_remains(tmp_path: Path) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "plugins", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    host.origin = "http://127.0.0.1:12345"
    await host.store.create_session(SESSION, CreateSession(title="等待"))
    path = session_database(tmp_path, SESSION)
    path.parent.mkdir(parents=True, mode=0o700)
    store = SessionStore(path, SESSION, build=host.build, approval_policy="auto", instance="worker")
    await store.initialize()
    await store.fence(host.fence)
    try:
        await store.accept(Submit(request_id="later", text="keep me", not_before_ms=2_000_000_000_000), host.fence)
        app = application(host)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=host.origin,
                                      headers={"Authorization": "Bearer web-only", "x-amazme-build": host.build,
                                               "x-amazme-epoch": str(host.fence.host_epoch)}) as client:
            blocked = await client.post("/api/v1/plugins", json={
                "plugin_id": PLUGIN, "name": "notes", "config": {"label": "记事"}})
            assert blocked.status_code == 409 and blocked.json()["code"] == "plugin_reload_blocked"
            still = await client.post(f"/api/v1/plugins/{PLUGIN}/reload", json={"config": {"label": "改过"}})
            assert still.status_code == 409 and still.json()["code"] == "plugin_reload_blocked"
        assert (await store.get("later")).status == "waiting_time"
        await store.cancel("later", host.fence)
        assert (await store.get("later")).status == "cancelled"
        assert "keep me" in (await store.get("later")).text
    finally:
        await store.db.close()
        await host.supervisor.close()
        await host.store.db.close()


def test_browser_registers_and_runs_the_selected_plugin() -> None:
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
        let pluginPosted = false;
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : {};
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(SESSION) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(SESSION) + r''',build_id:'build',host_epoch:1});
          if(path==='/api/v1/plugins' && method==='GET') {
            seen.push('GET /api/v1/plugins');
            const plugins = pluginPosted
              ? [{plugin_id:'p',name:'记事本',capabilities:['stamp'],config:{},fingerprint:'1111111111111111',entry:'stamp'},{plugin_id:'q',name:'notes',capabilities:['stamp'],config:{},fingerprint:'abcdef1234567890',entry:'stamp'}]
              : [{plugin_id:'p',name:'记事本',capabilities:['stamp'],config:{},fingerprint:'1111111111111111',entry:'stamp'}];
            return response({plugins});
          }
          if(path==='/api/v1/plugins' && method==='POST') {
            pluginPosted = true;
            seen.push(body.name);
            return response({plugin_id:body.plugin_id,name:body.name,capabilities:['stamp'],config:body.config,fingerprint:'abcdef1234567890',entry:'stamp'});
          }
          if(path.includes('/plugins/') && path.endsWith('/calls')) {
            seen.push(path.split('/plugins/')[1].split('/')[0] + ' ' + body.text);
            return response({call_id:body.call_id,phase:'done',result:body.text});
          }
          if(path.endsWith('/reload')) {
            seen.push('reload ' + body.config.label);
            return response({plugin_id:'p',name:'notes',capabilities:['stamp'],config:body.config,fingerprint:'fedcba1234567890',entry:'stamp'});
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
        $('plugins').querySelector('summary').click();
        await until(()=>$('plugin-list').textContent==='记事本');
        $('plugin-name').value = 'notes';
        $('plugin-label').value = '记事';
        $('plugin-form').requestSubmit();
        await until(()=>$('plugin-state').textContent.includes('notes') && $('plugin-state').textContent.includes('stamp'));
        $('plugin-text').value = 'alpha';
        $('plugin-call').requestSubmit();
        await until(()=>$('plugin-result').textContent==='alpha');
        $('plugin-label').value = '改过';
        $('plugin-reload').click();
        await until(()=>$('plugin-state').textContent.startsWith('notes') && $('plugin-state').textContent.includes('fedcba123456'));
        await until(()=>$('plugin-list').textContent==='记事本\nnotes');
        assert.ok(seen.filter(item => item==='GET /api/v1/plugins').length >= 2);
        assert.ok(seen.includes('notes'));
        assert.ok(seen.some(item => item.endsWith(' alpha')));
        assert.equal(seen.includes('reload 改过'), true);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
