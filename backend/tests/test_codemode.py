"""Codemode commits state only when the QuickJS helper succeeds."""

import asyncio
import json
import secrets
import shutil
import sqlite3
import sys
import tempfile
import threading
from pathlib import Path

import pytest

from amazme_backend.bootstrap.supervisor import create_supervisor
from amazme_backend.contracts import BackendError, CancelCode, OpenCode
from amazme_backend.execution.codemode.runtime import CodemodeOutcome, bundled_node, run_codemode
from amazme_backend.execution.codemode.runtime import run_codemode as run_native_codemode
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile

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
def bundled_runtime(codemode_resources: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    profile = tmp_path / "runner-profile"
    profile.mkdir()
    private_write(profile / "config.json",json.dumps({"format":2,"profile_id":"code-tests","workspace":str(tmp_path),
        "resources":str(codemode_resources),"provider":{"provider":"faux"}}))
    private_write(profile / "control.token","test-token")
    def invoke(source,state,**kwargs):
        return run_native_codemode(source,state,profile=profile,run_id=secrets.token_hex(16),**kwargs)
    monkeypatch.setattr(sys.modules[__name__],"run_codemode",invoke)
    monkeypatch.setattr("amazme_backend.execution.codemode.runtime.resource_root", lambda: codemode_resources)
    yield
    from amazme_backend.contracts import ProcessLease
    from amazme_backend.execution.processes import exited
    for path in (profile / "processes").glob("*.lock"):
        assert exited(ProcessLease.model_validate_json(path.read_bytes())), path


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
    monkeypatch.setattr("amazme_backend.execution.codemode.runtime.resource_root", lambda: root)
    with pytest.raises(BackendError, match="codemode_runtime_missing"):
        bundled_node(root)


def test_success_commits_state_and_failure_does_not(tmp_path: Path) -> None:
    def reply(message):
        if message['name']=='mark':
            mark.write_text('x')
            return {'op':'tool_result','id':message['id'],'result':{'ok':True}}
        return {'op':'tool_result','id':message['id'],'result':message['arguments']}
    tools = [{'name':'echo'},{'name':'mark'}]
    mark = tmp_path / "mark.txt"
    ok = run_codemode('store("k", 2); return await tools.echo({text:"hi"});', {"k": 1}, tools=tools,call_tool=reply)
    assert ok.phase == "success" and ok.value == {"text": "hi"} and ok.state == {"k": 2} and ok.committed

    failed = run_codemode('store("k", 9); await tools.mark({}); throw new Error("nope");', {"k": 1}, tools=tools,call_tool=reply)
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
    stopped = run_codemode('while (true) {} store("k", 3); return 1;', {"k": 1}, cancel=cancel, timeout_ms=2000)
    assert stopped.phase == "cancelled" and stopped.state is None
    assert stopped.exit_code is not None


def test_memory_limit_rejects_without_commit() -> None:
    failed = run_codemode('return "x".repeat(3000000);', {"k": 1}, timeout_ms=2000)
    assert failed.phase == "failed" and failed.state is None




async def test_supervisor_commits_only_success_and_does_not_rerun(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, codemode_resources: Path) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "code", "workspace": str(tmp_path), "resources": str(codemode_resources),
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.execution.supervisor.build_id", lambda: "build-one")
    with sqlite3.connect(tmp_path / "host.sqlite") as db:
        db.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT, archived INTEGER NOT NULL DEFAULT 0)")
        db.execute("INSERT INTO sessions(id,workspace) VALUES(?,?)",("a"*32,"primary"))
    owner = create_supervisor(Profile(tmp_path), "supervisor-code")
    await owner.initialize()
    owner.monitor_task.cancel()
    try:
        success = OpenCode(host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32,
                           run_id="b" * 32, source='store("k", 2); return 1;')
        first = await owner.code.run(success)
        assert first.phase == "success" and json.loads(first.state) == {"k": 2} and json.loads(first.value) == 1
        failed = await owner.code.run(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="c" * 32,
            source='store("k", 9); throw new Error("nope");'))
        assert failed.phase == "failed" and failed.state == ""
        saved = await owner.db.call(lambda db: db.execute("SELECT document FROM code_state WHERE session=?", ("a" * 32,)).fetchone())
        assert saved is not None and json.loads(str(saved["document"])) == {"k": 2}
        monkeypatch.setattr("amazme_backend.execution.codemode.operations.run_codemode", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("reran")))
        again = await owner.code.run(success)
        assert again.phase == "success" and json.loads(again.value) == 1
        with pytest.raises(BackendError, match="codemode_conflict"):
            await owner.code.run(OpenCode(host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32,
                                          run_id="b" * 32, source="return 2;"))
        unknown_source = "return 3;"
        monkeypatch.setattr(
            "amazme_backend.execution.codemode.operations.run_codemode", lambda *args, **kwargs: CodemodeOutcome("unknown"))
        unknown = await owner.code.run(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="d" * 32,
            source=unknown_source))
        assert unknown.phase == "unknown" and unknown.state == ""
        kept = await owner.db.call(lambda db: db.execute(
            "SELECT document FROM code_state WHERE session=?", ("a" * 32,)).fetchone())
        assert kept is not None and json.loads(str(kept["document"])) == {"k": 2}
        monkeypatch.setattr(
            "amazme_backend.execution.codemode.operations.run_codemode",
            lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("reran unknown")))
        repeated = await owner.code.run(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="d" * 32,
            source=unknown_source))
        assert repeated.phase == "unknown"
        with pytest.raises(BackendError, match="execution_cleanup_pending"):
            await owner.code.run(OpenCode(
                host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id="e" * 32,
                source="return 4;"))
    finally:
        await owner.close()


async def test_supervisor_cancel_does_not_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, codemode_resources: Path) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "code", "workspace": str(tmp_path), "resources": str(codemode_resources),
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.execution.supervisor.build_id", lambda: "build-one")
    with sqlite3.connect(tmp_path / "host.sqlite") as db:
        db.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT, archived INTEGER NOT NULL DEFAULT 0)")
        db.execute("INSERT INTO sessions(id,workspace) VALUES(?,?)",("a"*32,"primary"))
    owner = create_supervisor(Profile(tmp_path), "supervisor-cancel")
    await owner.initialize()
    owner.monitor_task.cancel()
    run_id = "f" * 32
    try:
        task = asyncio.create_task(owner.code.run(OpenCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id=run_id,
            source='while (true) {} store("k", 4); return 1;')))
        for _ in range(50):
            row = await owner.db.call(lambda db: db.execute("SELECT phase FROM code_runs WHERE id=?", (run_id,)).fetchone())
            if row is not None:
                break
            await asyncio.sleep(0.02)
        view = await owner.code.cancel(CancelCode(
            host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32, run_id=run_id))
        finished = await task
        assert finished.phase == "cancelled" and finished.state == ""
        assert view.phase == "cancelled" and view.state == ""
        saved = await owner.db.call(lambda db: db.execute(
            "SELECT document FROM code_state WHERE session=?", ("a" * 32,)).fetchone())
        assert saved is None
    finally:
        await owner.close()


def test_too_many_parallel_calls_fail_the_script() -> None:
    source = 'await Promise.all([tools.echo({text:"a"}), tools.echo({text:"b"}), tools.echo({text:"c"})]); return 1;'
    failed = run_codemode(source,{"k":1},tools=[{"name":"echo"}],
        call_tool=lambda m:{"op":"tool_result","id":m["id"],"result":m["arguments"]})
    assert failed.phase == "failed" and failed.state is None




async def test_live_script_uses_python_approval_and_stable_child_receipts(tmp_path, codemode_resources, monkeypatch):
    from amazme_backend.contracts import CodeRun, PluginDraft
    from amazme_backend.sdk import Client

    monkeypatch.syspath_prepend(str(Path(__file__).parents[1] / 'tools'))
    from verify_runtime import Runtime

    root = tmp_path / 'live'
    root.mkdir()
    provider = root / 'provider.json'
    provider.write_text('{"provider":"faux"}')
    runtime = await asyncio.to_thread(Runtime, [sys.executable,'-m','amazme_backend'],root,provider,approval_policy='mutations')
    config = json.loads((runtime.profile / 'config.json').read_text())
    config['resources'] = str(codemode_resources)
    private_write(runtime.profile / 'config.json',json.dumps(config))
    pending = None
    try:
        await asyncio.to_thread(runtime.start)
        token = (runtime.profile / 'web.token').read_text()
        async with Client(runtime.ready['url'],token) as client:
            session = (await client.create_session(title='Code',workspace='primary')).session_id
            attachment = (await client.attach(session)).attachment_id
            prefix = {'session_id':session,'workspace':'primary','attachment_id':attachment}
            entry = root / 'extension.py'
            entry.write_text((Path(__file__).parent / 'helpers/plugin_fixture.py').read_text())
            plugin = await client.register_plugin(PluginDraft(plugin_id='a'*32,session_id=session,name='Greeting',entry=str(entry)))
            catalog = await client.code_tools(session,'primary')
            alias = next(tool['name'] for tool in catalog.tools if str(tool['name']).startswith('plugin_'))
            value = CodeRun(run_id='1'*32,source='const value = await tools.shell({command:"printf code >> marker; printf done"}); text(value); store("k",1); return 1;')
            pending = asyncio.create_task(client.run_code(**prefix,value=value))
            async def approve_next(decision):
                for _ in range(200):
                    snapshot = await client.snapshot(session)
                    approval = next((a for a in snapshot.approvals if a.state == 'pending'),None)
                    if approval is not None:
                        return await client.decide(session_id=session,attachment_id=attachment,decision_id=decision,
                            approval_id=approval.approval_id,expected_revision=approval.revision,
                            proposal_digest=approval.proposal_digest,approve=True)
                    await asyncio.sleep(.05)
                pytest.fail('approval was not exposed')
            await approve_next('shell')
            view = await pending
            assert view.phase == 'success', view
            assert view.value == '1' and json.loads(view.state) == {'k':1}
            assert view.output and view.calls[0].name == 'shell'
            assert (runtime.workspace / 'marker').read_text() == 'code'
            assert await client.run_code(**prefix,value=value) == view
            image = CodeRun(run_id='2'*32,source=f'const result = await tools.{alias}({{name:"Bob",mode:"image"}}); image(result.images[0]); store("k",2); return result.details.count;')
            pending = asyncio.create_task(client.run_code(**prefix,value=image))
            await approve_next('plugin')
            returned = await pending
            assert returned.phase == 'success' and returned.value == '1', returned
            assert returned.output[0].type == 'image'
            assert json.loads(returned.state) == {'k':2}
            assert await client.run_code(**prefix,value=value) == view
            assert len((runtime.workspace / 'effects.txt').read_text().splitlines()) == 1
            # A direct script tool never creates a model step or invokes the faux provider.
            with sqlite3.connect(runtime.profile / 'sessions' / session / 'session.sqlite') as db:
                assert db.execute("SELECT count(*) FROM steps WHERE json_extract(payload,'$.kind')='model'").fetchone()[0] == 0
            assert plugin.phase == 'ready'
            rpc = await client.rpc('code.run',**prefix,code_run=value.model_dump())
            assert rpc['phase'] == 'success' and rpc['state'] == view.state
            # Script return cancels an unawaited tool using its original child ID.
            unawaited = await client.run_code(**prefix,value=CodeRun(run_id='3'*32,
                source='tools.shell({command:"printf forbidden > unawaited"}); return 3;'))
            assert unawaited.phase == 'success', unawaited
            assert not (runtime.workspace / 'unawaited').exists()
            snapshot = await client.snapshot(session)
            assert not any(a.state == 'pending' for a in snapshot.approvals)
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending,return_exceptions=True)
        await asyncio.to_thread(runtime.close)


async def test_supervisor_owns_script_after_waiter_cancels_and_close_stops_it(tmp_path, monkeypatch, codemode_resources):
    from amazme_backend.contracts import ProcessLease
    from amazme_backend.execution.processes import exited

    private_write(tmp_path / 'config.json',json.dumps({'format':2,'profile_id':'code','workspace':str(tmp_path),
        'resources':str(codemode_resources),'provider':{'provider':'faux'}}))
    private_write(tmp_path / 'control.token','token')
    monkeypatch.setattr('amazme_backend.execution.supervisor.build_id',lambda:'build-one')
    with sqlite3.connect(tmp_path / 'host.sqlite') as db:
        db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT, archived INTEGER NOT NULL DEFAULT 0)')
        db.executemany('INSERT INTO sessions(id,workspace) VALUES(?,?)',[('a'*32,'primary'),('b'*32,'primary')])
    owner = create_supervisor(Profile(tmp_path),'code-ownership')
    await owner.initialize()
    owner.monitor_task.cancel()
    value = OpenCode(host_epoch=owner.host_epoch,build_id=owner.build,session_id='a'*32,run_id='1'*32,source='while(true){}')
    waiter = asyncio.create_task(owner.code.run(value))
    try:
        for _ in range(100):
            if value.run_id in owner.code.jobs and (tmp_path / 'processes' / ('execution-code-'+value.run_id+'.lock')).exists():
                break
            await asyncio.sleep(.01)
        job = owner.code.jobs[value.run_id]
        waiter.cancel()
        await asyncio.gather(waiter,return_exceptions=True)
        assert not job.done()
        assert (await owner.code.run(value)).phase == 'unknown'
        with pytest.raises(BackendError,match='codemode_conflict'):
            await owner.code.cancel(CancelCode(host_epoch=owner.host_epoch,build_id=owner.build,session_id='b'*32,run_id=value.run_id))
        assert not owner.code.cancels[value.run_id].is_set()
        await owner.code.stop_all()
        assert (await job).phase == 'cancelled'
        # Fault injection: the script service exited, but its result receipt was lost.
        await owner.db.call(lambda db: db.execute("UPDATE code_runs SET phase='unknown' WHERE id=?",(value.run_id,)),write=True)
        await owner.db.call(lambda db: db.execute("UPDATE code_results SET document=? WHERE id=?",
            (json.dumps({'run_id':value.run_id,'phase':'unknown'}),value.run_id)),write=True)
        retired = await owner.code.cancel(CancelCode(host_epoch=owner.host_epoch,build_id=owner.build,session_id='a'*32,run_id=value.run_id))
        assert retired.phase == 'unknown' and retired.clean and retired.cancel_requested
        assert (await owner.code.run(value)).phase == 'unknown'
        early = CancelCode(host_epoch=owner.host_epoch,build_id=owner.build,session_id='a'*32,run_id='2'*32)
        cancelled_before_start = await owner.code.cancel(early)
        assert cancelled_before_start.phase == 'cancelled' and cancelled_before_start.clean and cancelled_before_start.cancel_requested
        with pytest.raises(BackendError,match='codemode_conflict'):
            await owner.code.run(value.model_copy(update={'session_id':'b'*32,'run_id':early.run_id}))
        stopped = await owner.code.run(value.model_copy(update={'run_id':early.run_id,'source':'store("ran",true);'}))
        assert stopped.phase == 'cancelled'
        assert not (tmp_path / 'executions' / ('code-'+early.run_id)).exists()
        for path in (tmp_path / 'processes').glob('*.lock'):
            assert exited(ProcessLease.model_validate_json(path.read_bytes()))
    finally:
        await owner.close()
