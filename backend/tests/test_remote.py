"""Remote daemon identity and disconnect. EOF is not a stop proof."""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, OpenRemote, RemoteCallRequest
from amazme_backend.remote_session import daemon_identity
from amazme_backend.supervisor import Supervisor

DAEMON = Path(__file__).parents[1] / "src/amazme_backend/remote_daemon.py"
PIN = "correct-host-key"


def start_daemon(state: Path, generation: str = "1") -> tuple[subprocess.Popen[bytes], str]:
    state.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([sys.executable, "-I", str(DAEMON), str(state), PIN, generation], stderr=subprocess.PIPE)
    port = state / "port"
    for _ in range(50):
        if port.exists():
            return process, "127.0.0.1:" + port.read_text().strip()
        time.sleep(0.05)
    raise AssertionError(process.stderr.read() if process.stderr else b"daemon did not listen")


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)




async def supervisor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Supervisor:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "remote", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    owner = Supervisor(Profile(tmp_path), "supervisor-remote")
    await owner.initialize()
    owner.monitor_task.cancel()
    return owner


def opener(owner: Supervisor, endpoint: str, *, key: str = PIN, generation: int = 1) -> OpenRemote:
    return OpenRemote(host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32,
                      remote_id="b" * 32, host="remote-a", host_key=key, daemon_id=daemon_identity(),
                      generation=generation, endpoint=endpoint)


async def test_wrong_host_key_sends_no_work(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    process, endpoint = start_daemon(tmp_path / "daemon")
    owner = await supervisor(tmp_path, monkeypatch)
    try:
        with pytest.raises(BackendError, match="remote_identity_mismatch"):
            await owner.open_remote(opener(owner, endpoint, key="wrong-host-key!!"))
        view = await owner._remote_row("b" * 32)
        assert view is not None and view["phase"] == "blocked"
        assert not (tmp_path / "daemon" / "effects.txt").exists()
    finally:
        stop(process)
        await owner.close()


async def test_disconnect_keeps_the_daemon_and_does_not_replay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = tmp_path / "daemon"
    process, endpoint = start_daemon(state)
    owner = await supervisor(tmp_path, monkeypatch)
    opened = opener(owner, endpoint)
    try:
        assert (await owner.open_remote(opened)).phase == "connected"
        first = await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="drop"))
        assert first.phase == "unknown"
        assert (state / "effects.txt").read_text() == "drop\n"
        assert process.poll() is None
        remote = await owner._remote_row("b" * 32)
        assert remote is not None and remote["phase"] == "disconnected"
        with pytest.raises(BackendError, match="remote_unreachable"):
            await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="drop"))
        assert (state / "effects.txt").read_text() == "drop\n"
        again = await owner.reconnect_remote(opened)
        assert again.phase == "connected"
        stored = await owner.db.call(lambda db: db.execute("SELECT phase,result FROM remote_calls WHERE id=?", ("c" * 32,)).fetchone())
        assert stored is not None and stored["phase"] == "done" and stored["result"] == "ran:drop"
        assert (state / "effects.txt").read_text() == "drop\n"
        with pytest.raises(BackendError, match="remote_call_conflict"):
            await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="other"))
        assert (state / "effects.txt").read_text() == "drop\n"
    finally:
        stop(process)
        await owner.close()


async def test_generation_change_blocks_without_marking_the_call_stopped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = tmp_path / "daemon"
    process, endpoint = start_daemon(state)
    owner = await supervisor(tmp_path, monkeypatch)
    opened = opener(owner, endpoint)
    try:
        await owner.open_remote(opened)
        await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="drop"))
        (state / "generation").write_text("2")
        with pytest.raises(BackendError, match="remote_identity_mismatch"):
            await owner.reconnect_remote(opened)
        remote = await owner._remote_row("b" * 32)
        call = await owner.db.call(lambda db: db.execute("SELECT phase FROM remote_calls WHERE id=?", ("c" * 32,)).fetchone())
        assert remote is not None and remote["phase"] == "blocked"
        assert call is not None and call["phase"] == "unknown"
        assert (state / "effects.txt").read_text() == "drop\n"
        with pytest.raises(BackendError, match="remote_unreachable"):
            await owner.submit_remote(opened, RemoteCallRequest(call_id="d" * 32, command="next"))
        assert (state / "effects.txt").read_text() == "drop\n"
    finally:
        stop(process)
        await owner.close()


def test_browser_shows_disconnect_without_calling_the_remote_stopped() -> None:
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
    session = "d" * 32
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst boundSession=" + json.dumps(session) + ";\n" + r'''
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
          if (method !== 'GET') seen.push(path);
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.endsWith('/remotes') && method==='POST') return response({remote_id:'r',host:'remote-a',phase:'connected',generation:1});
          if(path.endsWith('/disconnect')) return response({remote_id:'r',host:'remote-a',phase:'disconnected',generation:1});
          if(path.endsWith('/reconnect')) return response({remote_id:'r',host:'remote-a',phase:'connected',generation:1});
          if(path==='/api/v1/files') return response({path:'',entries:[],truncated:false});
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        await until(()=>$('sessions').textContent.includes('工作区'));
        $('remote-host').value = 'remote-a';
        $('remote-key').value = 'correct-host-key';
        $('remote-endpoint').value = '127.0.0.1:9';
        $('remote-form').requestSubmit();
        await until(()=>$('remote-state').textContent==='已连接');
        $('remote-drop').click();
        await until(()=>$('remote-state').textContent==='已断开，远端未证明停止');
        assert.ok(seen.some(path=>path.endsWith('/disconnect')));
        $('remote-again').click();
        await until(()=>seen.some(path=>path.endsWith('/reconnect')));
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([__import__("shutil").which("node") or "node", "--input-type=module"], input=script,
                            text=True, capture_output=True, timeout=20, cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
