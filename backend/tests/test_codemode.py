"""Codemode commits state only when the QuickJS helper succeeds."""

import asyncio
import json
import shutil
import tempfile
import threading
from pathlib import Path

import pytest

from amazme_backend.codemode_run import CodemodeOutcome, run_codemode
from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, CancelCode, OpenCode
from amazme_backend.supervisor import Supervisor

OFFICIAL_NODE = Path.home() / "Library/Caches/amazme-release/node-v22.23.3-darwin-arm64/bin/node"


@pytest.fixture(scope="session")
def codemode_resources() -> Path:
    if not OFFICIAL_NODE.is_file():
        raise RuntimeError("official Node binary is missing")
    root = Path(tempfile.mkdtemp(prefix="amazme-node-"))
    dest = root / "node" / "bin" / "node"
    dest.parent.mkdir(parents=True)
    shutil.copy2(OFFICIAL_NODE, dest)
    dest.chmod(0o755)
    try:
        yield root
    finally:
        shutil.rmtree(root)


@pytest.fixture(autouse=True)
def bundled_runtime(codemode_resources: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("amazme_backend.codemode_run.resource_root", lambda: codemode_resources)


def test_path_node_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    marker = tmp_path / "used-path"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake = fake_bin / "node"
    fake.write_text(f"#!/bin/sh\nprintf used > {marker}\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", str(fake_bin))
    outcome = run_codemode("return 1;", {"k": 1})
    assert outcome.phase == "success" and outcome.value == 1
    assert not marker.exists()


def test_symlink_outside_the_bundle_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "resources"
    dest = root / "node" / "bin"
    dest.mkdir(parents=True)
    (dest / "node").symlink_to("/bin/echo")
    monkeypatch.setattr("amazme_backend.codemode_run.resource_root", lambda: root)
    with pytest.raises(BackendError, match="codemode_runtime_missing"):
        run_codemode("return 1;", {"k": 1})


def test_success_commits_state_and_failure_does_not(tmp_path: Path) -> None:
    mark = tmp_path / "mark.txt"
    ok = run_codemode('bridge.state.set("k", 2); return await bridge.call("echo", {text: "hi"});', {"k": 1}, mark_path=mark)
    assert ok.phase == "success" and ok.value == {"text": "hi"} and ok.state == {"k": 2} and ok.committed

    failed = run_codemode('bridge.state.set("k", 9); await bridge.call("mark", {}); throw new Error("nope");', {"k": 1}, mark_path=mark)
    assert failed.phase == "failed" and failed.state is None and not failed.committed
    assert mark.read_text() == "x"


def test_timeout_and_cancel_do_not_commit(tmp_path: Path) -> None:
    timed = run_codemode("while (true) {}", {"k": 1}, timeout_ms=200)
    assert timed.phase == "failed" and timed.state is None

    cancel = threading.Event()

    def trip() -> None:
        import time
        time.sleep(0.3)
        cancel.set()
    threading.Thread(target=trip, daemon=True).start()
    stopped = run_codemode('await bridge.call("block", {}); bridge.state.set("k", 3); return 1;', {"k": 1}, cancel=cancel, timeout_ms=2000)
    assert stopped.phase == "cancelled" and stopped.state is None
    assert stopped.exit_code is not None and stopped.exit_code != 0


def test_memory_limit_rejects_without_commit() -> None:
    failed = run_codemode('return "x".repeat(3000000);', {"k": 1}, timeout_ms=2000)
    assert failed.phase == "failed" and failed.state is None




async def test_supervisor_commits_only_success_and_does_not_rerun(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "code", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    owner = Supervisor(Profile(tmp_path), "supervisor-code")
    await owner.initialize()
    owner.monitor_task.cancel()
    try:
        success = OpenCode(host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32,
                           run_id="b" * 32, source='bridge.state.set("k", 2); return 1;')
        first = await owner.run_code(success)
        assert first.phase == "success" and json.loads(first.state) == {"k": 2} and json.loads(first.value) == 1
        failed = await owner.run_code(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="c" * 32,
            source='bridge.state.set("k", 9); throw new Error("nope");'))
        assert failed.phase == "failed" and failed.state == ""
        saved = await owner.db.call(lambda db: db.execute("SELECT document FROM code_state WHERE session=?", ("a" * 32,)).fetchone())
        assert saved is not None and json.loads(str(saved["document"])) == {"k": 2}
        monkeypatch.setattr("amazme_backend.supervisor.run_codemode", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("reran")))
        again = await owner.run_code(success)
        assert again.phase == "success" and json.loads(again.value) == 1
        with pytest.raises(BackendError, match="codemode_conflict"):
            await owner.run_code(OpenCode(host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32,
                                          run_id="b" * 32, source="return 2;"))
        unknown_source = "return 3;"
        monkeypatch.setattr(
            "amazme_backend.supervisor.run_codemode", lambda *args, **kwargs: CodemodeOutcome("unknown"))
        unknown = await owner.run_code(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="d" * 32,
            source=unknown_source))
        assert unknown.phase == "unknown" and unknown.state == ""
        kept = await owner.db.call(lambda db: db.execute(
            "SELECT document FROM code_state WHERE session=?", ("a" * 32,)).fetchone())
        assert kept is not None and json.loads(str(kept["document"])) == {"k": 2}
        monkeypatch.setattr(
            "amazme_backend.supervisor.run_codemode",
            lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("reran unknown")))
        repeated = await owner.run_code(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="d" * 32,
            source=unknown_source))
        assert repeated.phase == "unknown"
        with pytest.raises(BackendError, match="execution_cleanup_pending"):
            await owner.run_code(OpenCode(
                host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="e" * 32,
                source="return 4;"))
    finally:
        await owner.close()


async def test_supervisor_cancel_does_not_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "code", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    owner = Supervisor(Profile(tmp_path), "supervisor-cancel")
    await owner.initialize()
    owner.monitor_task.cancel()
    run_id = "f" * 32
    try:
        task = asyncio.create_task(owner.run_code(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id=run_id,
            source='await bridge.call("block", {}); bridge.state.set("k", 4); return 1;')))
        for _ in range(50):
            row = await owner.db.call(lambda db: db.execute("SELECT phase FROM code_runs WHERE id=?", (run_id,)).fetchone())
            if row is not None:
                break
            await asyncio.sleep(0.02)
        view = await owner.cancel_code(CancelCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id=run_id))
        finished = await task
        assert finished.phase == "cancelled" and finished.state == ""
        assert view.phase == "cancelled" and view.state == ""
        saved = await owner.db.call(lambda db: db.execute(
            "SELECT document FROM code_state WHERE session=?", ("a" * 32,)).fetchone())
        assert saved is None
    finally:
        await owner.close()


def test_helper_exit_without_a_report_does_not_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    helper = tmp_path / "exit.mjs"
    helper.write_text("process.exit(0)\n")
    monkeypatch.setattr("amazme_backend.codemode_run.HELPER", helper)
    outcome = run_codemode("return 1;", {"k": 1})
    assert outcome.phase == "failed" and outcome.state is None and outcome.exit_code is not None


def test_too_many_parallel_calls_fail_the_script() -> None:
    source = 'await Promise.all([bridge.call("echo", {text:"a"}), bridge.call("echo", {text:"b"}), bridge.call("echo", {text:"c"})]); return 1;'
    failed = run_codemode(source, {"k": 1})
    assert failed.phase == "failed" and failed.state is None


def test_browser_shows_committed_state_and_clears_it_after_failure() -> None:
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
          const body = options.body ? JSON.parse(options.body) : null;
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.endsWith('/code') && method==='POST') {
            seen.push(body.source);
            if (String(body.source).includes('fail')) return response({run_id:body.run_id,phase:'failed',value:'',state:'{"k":9}'});
            return response({run_id:body.run_id,phase:'success',value:'1',state:'{"k":2}'});
          }
          if(path.endsWith('/cancel') && method==='POST') {
            seen.push('cancel');
            return response({run_id:'x',phase:'cancelled',value:'',state:'{"k":2}'});
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
        $('code-source').value = 'return 1;';
        $('code-run').click();
        await until(()=>$('code-result').textContent==='1' && $('code-state').textContent==='{"k":2}');
        assert.deepEqual(seen, ['return 1;']);
        $('code-source').value = 'fail';
        $('code-run').click();
        await until(()=>$('code-result').textContent==='failed' && $('code-state').textContent==='');
        $('code-cancel').click();
        await until(()=>$('code-result').textContent==='cancelled' && $('code-state').textContent==='');
        assert.ok(seen.includes('cancel'));
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True,
                            timeout=20, cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
