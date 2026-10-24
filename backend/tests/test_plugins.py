"""Real Python extension factories use the native service ownership and call ledger."""

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
import pytest_asyncio

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    CancelPlugin,
    ClosePlugin,
    OpenPlugin,
    PluginCallEnvelope,
    ProcessLease,
    ReloadPlugin,
)
from amazme_backend.processes import exited
from amazme_backend.supervisor import Supervisor

PLUGIN = 'a' * 32
SESSION = 'b' * 32
CALL = 'c' * 32
SOURCE = (Path(__file__).parent / 'helpers/plugin_fixture.py').read_text()


@pytest_asyncio.fixture
async def owner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    private_write(tmp_path / 'config.json', json.dumps({'format':2, 'profile_id':'plugins', 'workspace':str(tmp_path),
        'resources':'unused', 'provider':{'provider':'faux'}}))
    private_write(tmp_path / 'control.token', 'token')
    monkeypatch.setattr('amazme_backend.supervisor.build_id', lambda:'build-one')
    monkeypatch.setenv('OPENAI_API_KEY', 'never-inherit-this')
    monkeypatch.setenv('AMAZME_CONTROL_TOKEN', 'never-inherit-control')
    with sqlite3.connect(tmp_path / 'host.sqlite') as db:
        db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT)')
        db.execute('INSERT INTO sessions VALUES(?,?)', (SESSION,'primary'))
        db.execute('INSERT INTO sessions VALUES(?,?)', ('9'*32,'primary'))
    (tmp_path / 'extension.py').write_text(SOURCE)
    value = Supervisor(Profile(tmp_path), 'plugin-owner')
    await value.initialize()
    value.monitor_task.cancel()
    try:
        yield value
    finally:
        await value.close()
        for path in (tmp_path / 'processes').glob('*.lock'):
            assert exited(ProcessLease.model_validate_json(path.read_bytes())), path


def register(owner):
    return OpenPlugin(host_epoch=owner.host_epoch, build_id=owner.build, plugin_id=PLUGIN, name='greeting', session_id=SESSION,
                      entry=str(owner.profile.path / 'extension.py'), config={'label':'hello'})


def call(owner, *, call_id=CALL, name='Bob', mode=''):
    return PluginCallEnvelope(host_epoch=owner.host_epoch, build_id=owner.build, plugin_id=PLUGIN,
        session_id=SESSION, call_id=call_id, name='hello', arguments={'name':name, 'mode':mode})


def reload(owner, identity='d'*32):
    return ReloadPlugin(host_epoch=owner.host_epoch, build_id=owner.build, plugin_id=PLUGIN,
                        reload_id=identity, session_id=SESSION, config={'label':'hello'})


async def test_factory_registers_tools_commands_and_returns_real_output_once(owner):
    view = await owner.register_plugin(register(owner))
    assert view.phase == 'ready' and view.entry.endswith('extension.py')
    assert [item.name for item in view.tools] == ['hello','hello']
    assert view.tools[0].parameters['type'] == 'object' and view.tools[1].kind == 'command'
    result = await owner.call_plugin(call(owner))
    assert result.phase == 'done' and result.result.content == [{'type':'text','text':'Hello, Bob!'}]
    assert result.result.details == {'count':1,'session':SESSION,'secret_inherited':False}
    assert await owner.call_plugin(call(owner)) == result
    assert (owner.profile.path / 'effects.txt').read_text().count(CALL) == 1
    with pytest.raises(BackendError, match='plugin_call_conflict'):
        await owner.call_plugin(call(owner, name='different'))
    command = call(owner, call_id='e'*32).model_copy(update={'name':'hello','kind':'command','arguments':{'arguments':'user args'}})
    assert (await owner.call_plugin(command)).result.content[0]['text'] == 'user args'
    stopped = await owner.close_plugin(ClosePlugin(host_epoch=owner.host_epoch,build_id=owner.build,session_id=SESSION,plugin_id=PLUGIN))
    assert stopped.phase == 'disconnected'
    assert await owner.call_plugin(call(owner)) == result
    await owner.reload_plugin(reload(owner))
    assert (await owner.call_plugin(call(owner,call_id='f'*32))).result.details['count'] == 1


async def test_parameters_are_validated_before_the_user_function(owner):
    await owner.register_plugin(register(owner))
    bad = call(owner).model_copy(update={'arguments':{'name':42}})
    result = await owner.call_plugin(bad)
    assert result.phase == 'failed' and not (owner.profile.path / 'effects.txt').exists()
    assert (await owner.call_plugin(bad)) == result


async def test_registration_retry_does_not_load_changed_source_or_reset_state(owner):
    original = register(owner)
    view = await owner.register_plugin(original)
    await owner.call_plugin(call(owner))
    (owner.profile.path / 'extension.py').write_text('raise RuntimeError("changed")')
    assert await owner.register_plugin(original) == view
    result = await owner.call_plugin(call(owner, call_id='e'*32))
    assert result.result.details['count'] == 2
    with pytest.raises(BackendError, match='plugin_conflict'):
        await owner.register_plugin(original.model_copy(update={'config':{'label':'other'}}))
    failed = await owner.reload_plugin(reload(owner))
    assert failed.phase == 'failed' and failed.fingerprint != view.fingerprint
    (owner.profile.path / 'extension.py').write_text(SOURCE)
    # Retrying the same load ID reports its original failure; it never re-imports the file.
    assert await owner.reload_plugin(reload(owner)) == failed
    fresh = await owner.reload_plugin(reload(owner,'f'*32))
    assert fresh.phase == 'ready'
    with pytest.raises(BackendError, match='plugin_reload_conflict'):
        await owner.reload_plugin(reload(owner,'f'*32).model_copy(update={'config':{'changed':'yes'}}))


async def test_unknown_side_effect_is_never_replayed_after_explicit_reload(owner):
    await owner.register_plugin(register(owner))
    original = call(owner, mode='crash')
    result = await owner.call_plugin(original)
    assert result.phase == 'unknown' and result.clean
    assert (await owner.list_plugins()).plugins[0].phase == 'disconnected'
    with pytest.raises(BackendError) as failure:
        await owner.call_plugin(call(owner,call_id='e'*32))
    assert failure.value.code == 'plugin_disconnected'
    await owner.reload_plugin(reload(owner))
    assert (await owner.call_plugin(original)).phase == 'unknown'
    assert (owner.profile.path / 'effects.txt').read_text().count(CALL) == 1
    assert (await owner.call_plugin(call(owner,call_id='f'*32))).phase == 'done'


async def test_cancel_records_identity_before_send_and_waits_for_owned_exit(owner):
    await owner.register_plugin(register(owner))
    cancel = CancelPlugin(host_epoch=owner.host_epoch,build_id=owner.build,plugin_id=PLUGIN,session_id=SESSION,call_id=CALL)
    before = await owner.cancel_plugin(cancel)
    assert before.phase == 'cancelled' and before.clean
    assert (await owner.call_plugin(call(owner))).phase == 'cancelled'
    assert not (owner.profile.path / 'effects.txt').exists()
    original = call(owner,call_id='e'*32,mode='wait')
    pending = asyncio.create_task(owner.call_plugin(original))
    for _ in range(100):
        if (owner.profile.path / 'effects.txt').exists():
            break
        await asyncio.sleep(.02)
    assert (owner.profile.path / 'effects.txt').exists()
    cancel = cancel.model_copy(update={'call_id':'e'*32})
    stopped = await owner.cancel_plugin(cancel)
    assert stopped.cancel_requested and stopped.clean
    assert (await asyncio.wait_for(pending, 2)).phase == 'unknown'
    assert (await owner.call_plugin(original)).phase == 'unknown'
    with pytest.raises(BackendError, match='plugin_session_mismatch'):
        await owner.cancel_plugin(cancel.model_copy(update={'session_id':'f'*32}))


async def test_reload_respects_live_worker_generation(owner, monkeypatch):
    from amazme_backend.contracts import WorkerInfo
    from amazme_backend.processes import ProcessReservation

    view = await owner.register_plugin(register(owner))
    with ProcessReservation(owner.profile.path, 'worker', '1'*32) as reservation:
        worker = WorkerInfo(session_id=SESSION, worker_id='live-boundary', pid=0, socket='', build_id=owner.build,
                            process_lease=reservation.lease, state='ready', plugin_fingerprint=await owner.plugin_set_fingerprint(SESSION))
        async def workers(session=''):
            return [worker] if not session or session == SESSION else []
        with monkeypatch.context() as patch:
            patch.setattr(owner, '_workers', workers)
            with pytest.raises(BackendError, match='plugin_reload_blocked'):
                await owner.reload_plugin(reload(owner))
            assert (await owner.list_plugins(SESSION)).plugins == [view]
            # An unrelated live worker does not own the other session's plugins.
            other = register(owner).model_copy(update={'plugin_id':'8'*32,'session_id':'9'*32})
            assert (await owner.register_plugin(other)).phase == 'ready'
    assert exited(reservation.lease)


async def test_sdk_and_rpc_preserve_plugin_binding_and_structured_payloads():
    from unittest.mock import AsyncMock, Mock

    import httpx

    from amazme_backend.contracts import (
        PluginCallRequest,
        PluginCallView,
        PluginDraft,
        PluginList,
        PluginReload,
        PluginResult,
        PluginView,
        Session,
        SessionList,
    )
    from amazme_backend.rpc import RpcHost, RpcParams, _dispatch
    from amazme_backend.sdk import Client

    draft = PluginDraft(plugin_id=PLUGIN, session_id=SESSION, name='greeting', entry='/user/extension.py', config={'label':'user'})
    view = PluginView(**draft.model_dump(), capabilities=['hello'], fingerprint='f'*64, phase='ready')
    request = PluginCallRequest(call_id=CALL, name='hello', arguments={'name':'Bob'})
    result = PluginCallView(call_id=CALL, phase='done', result=PluginResult(content=[{'type':'text','text':'Hello, Bob!'}]))
    stopped = PluginCallView(call_id=CALL, phase='unknown', cancel_requested=True, clean=True)
    sessions = SessionList(sessions=[Session(session_id=SESSION,title='test')])
    writes = []

    def transport(req: httpx.Request):
        if req.method == 'GET':
            return httpx.Response(200, json=(sessions if req.url.path.endswith('/sessions') else PluginList(plugins=[view])).model_dump())
        writes.append((req.url.path,json.loads(req.content)))
        if '/sessions/' in req.url.path:
            assert req.headers['x-amazme-attachment'] == 'binding'
        reply = stopped if req.url.path.endswith('/cancel') else result if req.url.path.endswith('/calls') else view
        return httpx.Response(200, json=reply.model_dump())

    client = Client('http://local','token')
    await client._http.aclose()
    client._http = httpx.AsyncClient(base_url=client.base_url,transport=httpx.MockTransport(transport))
    public_load = PluginReload(session_id=SESSION, reload_id='e'*32)
    try:
        assert await client.plugins() == PluginList(plugins=[view])
        assert await client.register_plugin(draft) == view
        assert await client.reload_plugin(PLUGIN,public_load) == view
        assert await client.call_plugin(SESSION,'primary','binding',PLUGIN,request) == result
        assert await client.cancel_plugin(SESSION,'primary','binding',PLUGIN,CALL) == stopped
        assert await client.close_plugin(SESSION,'primary','binding',PLUGIN) == view
    finally:
        await client._http.aclose()
    assert writes[0] == ('/api/v1/plugins',draft.model_dump())
    assert writes[1][1] == public_load.model_dump()
    assert writes[2][1] == request.model_dump()
    owner = Mock(spec=RpcHost)
    owner.sessions = AsyncMock(return_value=sessions)
    owner.register_plugin = AsyncMock(return_value=view)
    owner.reload_plugin = AsyncMock(return_value=view)
    owner.call_plugin = AsyncMock(return_value=result)
    owner.cancel_plugin = AsyncMock(return_value=stopped)
    owner.close_plugin = AsyncMock(return_value=view)
    binding = {'session_id':SESSION,'workspace':'primary','attachment_id':'binding','plugin_id':PLUGIN}
    assert await _dispatch(owner,'plugin.register',RpcParams(plugin_draft=draft)) == view
    assert await _dispatch(owner,'plugin.reload',RpcParams(plugin_id=PLUGIN,plugin_reload=public_load)) == view
    assert await _dispatch(owner,'plugin.call',RpcParams(**binding,plugin_call=request)) == result
    assert await _dispatch(owner,'plugin.cancel',RpcParams(**binding,call_id=CALL)) == stopped
    assert await _dispatch(owner,'plugin.close',RpcParams(**binding)) == view
    owner.call_plugin.assert_awaited_once_with(SESSION,PLUGIN,request)
    owner.cancel_plugin.assert_awaited_once_with(SESSION,PLUGIN,CALL)


async def test_session_processes_isolate_factory_state_workspaces_and_call_ownership(owner):
    await owner.register_plugin(register(owner))
    assert (await owner.call_plugin(call(owner))).result.details['count'] == 1
    other = owner.profile.path / 'other-workspace'
    other.mkdir()
    with sqlite3.connect(owner.profile.path / 'host.sqlite') as db:
        db.execute('CREATE TABLE workspace_grants(name TEXT, host_path TEXT)')
        db.execute('INSERT INTO workspace_grants VALUES(?,?)', ('other',str(other)))
        db.execute('UPDATE sessions SET workspace=? WHERE id=?', ('other','9'*32))
    second = register(owner).model_copy(update={'plugin_id':'8'*32,'session_id':'9'*32})
    await owner.register_plugin(second)
    same = await owner.call_plugin(call(owner,call_id='6'*32))
    assert same.result.details['count'] == 2
    separate = call(owner,call_id='7'*32).model_copy(update={'plugin_id':'8'*32,'session_id':'9'*32,'workspace':'other'})
    result = await owner.call_plugin(separate)
    assert result.result.details['count'] == 1 and result.result.details['session'] == '9'*32
    assert (other / 'effects.txt').read_text() == '7'*32 + ':Bob\n'
    assert len((owner.profile.path / 'effects.txt').read_text().splitlines()) == 2
    with pytest.raises(BackendError,match='plugin_session_mismatch'):
        await owner.call_plugin(separate.model_copy(update={'plugin_id':PLUGIN,'call_id':'5'*32}))
    with pytest.raises(BackendError,match='workspace_mismatch'):
        await owner.call_plugin(separate.model_copy(update={'workspace':'primary','call_id':'4'*32}))
    with pytest.raises(BackendError,match='plugin_session_mismatch'):
        await owner.reload_plugin(reload(owner).model_copy(update={'session_id':'9'*32}))
    assert [view.plugin_id for view in (await owner.list_plugins(SESSION)).plugins] == [PLUGIN]


async def test_waiting_work_blocks_plugin_registration_and_history_remains(tmp_path: Path) -> None:
    import httpx

    from amazme_backend.contracts import CreateSession, HostFence, Submit
    from amazme_backend.host import Host, application
    from amazme_backend.storage import SessionStore, session_database
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
                "session_id":SESSION, "entry":"/user/plugin.py", "plugin_id": PLUGIN, "name": "notes", "config": {"label": "记事"}})
            assert blocked.status_code == 409 and blocked.json()["code"] == "plugin_reload_blocked"
            still = await client.post(f"/api/v1/plugins/{PLUGIN}/reload", json={"session_id":SESSION, "reload_id":"d"*32, "config": {"label": "改过"}})
            assert still.status_code == 409 and still.json()["code"] == "plugin_reload_blocked"
        assert (await store.get("later")).status == "waiting_time"
        await store.cancel("later", host.fence)
        assert (await store.get("later")).status == "cancelled"
        assert "keep me" in (await store.get("later")).text
    finally:
        await store.db.close()
        await host.supervisor.close()
        await host.store.db.close()
