"""Real Python extension factories use the native service ownership and call ledger."""

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
import pytest_asyncio

from amazme_backend.bootstrap.supervisor import create_supervisor
from amazme_backend.contracts import (
    BackendError,
    CancelPlugin,
    ClosePlugin,
    OpenPlugin,
    PluginCallEnvelope,
    ProcessLease,
    ReloadPlugin,
)
from amazme_backend.execution.processes import exited
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile

PLUGIN = 'a' * 32
SESSION = 'b' * 32
CALL = 'c' * 32
SOURCE = (Path(__file__).parent / 'helpers/plugin_fixture.py').read_text()


@pytest_asyncio.fixture
async def owner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    private_write(tmp_path / 'config.json', json.dumps({'format':2, 'profile_id':'plugins', 'workspace':str(tmp_path),
        'resources':'unused', 'provider':{'provider':'faux'}}))
    private_write(tmp_path / 'control.token', 'token')
    monkeypatch.setattr('amazme_backend.execution.supervisor.build_id', lambda:'build-one')
    monkeypatch.setenv('OPENAI_API_KEY', 'never-inherit-this')
    monkeypatch.setenv('AMAZME_CONTROL_TOKEN', 'never-inherit-control')
    with sqlite3.connect(tmp_path / 'host.sqlite') as db:
        db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT, archived INTEGER NOT NULL DEFAULT 0)')
        db.execute('INSERT INTO sessions(id,workspace) VALUES(?,?)', (SESSION,'primary'))
        db.execute('INSERT INTO sessions(id,workspace) VALUES(?,?)', ('9'*32,'primary'))
    (tmp_path / 'extension.py').write_text(SOURCE)
    value = create_supervisor(Profile(tmp_path), 'plugin-owner')
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
    view = await owner.plugins.register(register(owner))
    assert view.phase == 'ready' and view.entry.endswith('extension.py')
    assert [item.name for item in view.tools] == ['hello','hello']
    assert view.tools[0].parameters['type'] == 'object' and view.tools[1].kind == 'command'
    result = await owner.plugins.call(call(owner))
    assert result.phase == 'done' and result.result.content == [{'type':'text','text':'Hello, Bob!'}]
    assert result.result.details == {'count':1,'session':SESSION,'secret_inherited':False}
    assert await owner.plugins.call(call(owner)) == result
    assert (owner.profile.path / 'effects.txt').read_text().count(CALL) == 1
    with pytest.raises(BackendError, match='plugin_call_conflict'):
        await owner.plugins.call(call(owner, name='different'))
    command = call(owner, call_id='e'*32).model_copy(update={'name':'hello','kind':'command','arguments':{'arguments':'user args'}})
    assert (await owner.plugins.call(command)).result.content[0]['text'] == 'user args'
    stopped = await owner.plugins.close(ClosePlugin(host_epoch=owner.host_epoch,build_id=owner.build,session_id=SESSION,plugin_id=PLUGIN))
    assert stopped.phase == 'disconnected'
    assert await owner.plugins.call(call(owner)) == result
    await owner.plugins.reload(reload(owner))
    assert (await owner.plugins.call(call(owner,call_id='f'*32))).result.details['count'] == 1


async def test_parameters_are_validated_before_the_user_function(owner):
    await owner.plugins.register(register(owner))
    bad = call(owner).model_copy(update={'arguments':{'name':42}})
    result = await owner.plugins.call(bad)
    assert result.phase == 'failed' and not (owner.profile.path / 'effects.txt').exists()
    assert (await owner.plugins.call(bad)) == result


async def test_remove_preserves_receipts_and_load_identity_without_resurrecting(owner):
    registered = register(owner)
    await owner.plugins.register(registered)
    original = call(owner)
    result = await owner.plugins.call(original)
    before = await owner.plugins.set_fingerprint(SESSION)
    removal = ClosePlugin(host_epoch=owner.host_epoch, build_id=owner.build, session_id=SESSION, plugin_id=PLUGIN)
    removed = await owner.plugins.remove(removal)
    assert removed.phase == 'removed' and not (await owner.plugins.list(SESSION)).plugins
    assert await owner.plugins.set_fingerprint(SESSION) != before
    assert PLUGIN not in owner.plugins.clients
    assert await owner.plugins.remove(removal) == removed
    assert (await owner.plugins.register(registered)).phase == 'removed'
    assert await owner.plugins.call(original) == result
    with pytest.raises(BackendError, match='plugin_removed'):
        await owner.plugins.call(call(owner, call_id='f'*32))
    with pytest.raises(BackendError, match='plugin_removed'):
        await owner.plugins.reload(reload(owner))
    assert (owner.profile.path / 'effects.txt').read_text().count(CALL) == 1
    assert (owner.profile.path / 'extension.py').exists()


async def test_registration_retry_does_not_load_changed_source_or_reset_state(owner):
    original = register(owner)
    view = await owner.plugins.register(original)
    await owner.plugins.call(call(owner))
    (owner.profile.path / 'extension.py').write_text('raise RuntimeError("changed")')
    assert await owner.plugins.register(original) == view
    result = await owner.plugins.call(call(owner, call_id='e'*32))
    assert result.result.details['count'] == 2
    with pytest.raises(BackendError, match='plugin_conflict'):
        await owner.plugins.register(original.model_copy(update={'config':{'label':'other'}}))
    failed = await owner.plugins.reload(reload(owner))
    assert failed.phase == 'failed' and failed.fingerprint != view.fingerprint
    (owner.profile.path / 'extension.py').write_text(SOURCE)
    # Retrying the same load ID reports its original failure; it never re-imports the file.
    assert await owner.plugins.reload(reload(owner)) == failed
    fresh = await owner.plugins.reload(reload(owner,'f'*32))
    assert fresh.phase == 'ready'
    with pytest.raises(BackendError, match='plugin_reload_conflict'):
        await owner.plugins.reload(reload(owner,'f'*32).model_copy(update={'config':{'changed':'yes'}}))


async def test_unknown_side_effect_is_never_replayed_after_explicit_reload(owner):
    await owner.plugins.register(register(owner))
    original = call(owner, mode='crash')
    result = await owner.plugins.call(original)
    assert result.phase == 'unknown' and result.clean
    assert (await owner.plugins.list()).plugins[0].phase == 'disconnected'
    with pytest.raises(BackendError) as failure:
        await owner.plugins.call(call(owner,call_id='e'*32))
    assert failure.value.code == 'plugin_disconnected'
    await owner.plugins.reload(reload(owner))
    assert (await owner.plugins.call(original)).phase == 'unknown'
    assert (owner.profile.path / 'effects.txt').read_text().count(CALL) == 1
    assert (await owner.plugins.call(call(owner,call_id='f'*32))).phase == 'done'


async def test_cancel_records_identity_before_send_and_waits_for_owned_exit(owner):
    await owner.plugins.register(register(owner))
    cancel = CancelPlugin(host_epoch=owner.host_epoch,build_id=owner.build,plugin_id=PLUGIN,session_id=SESSION,call_id=CALL)
    before = await owner.plugins.cancel(cancel)
    assert before.phase == 'cancelled' and before.clean
    assert (await owner.plugins.call(call(owner))).phase == 'cancelled'
    assert not (owner.profile.path / 'effects.txt').exists()
    original = call(owner,call_id='e'*32,mode='wait')
    pending = asyncio.create_task(owner.plugins.call(original))
    for _ in range(100):
        if (owner.profile.path / 'effects.txt').exists():
            break
        await asyncio.sleep(.02)
    assert (owner.profile.path / 'effects.txt').exists()
    cancel = cancel.model_copy(update={'call_id':'e'*32})
    stopped = await owner.plugins.cancel(cancel)
    assert stopped.cancel_requested and stopped.clean
    assert (await asyncio.wait_for(pending, 2)).phase == 'unknown'
    assert (await owner.plugins.call(original)).phase == 'unknown'
    with pytest.raises(BackendError, match='plugin_session_mismatch'):
        await owner.plugins.cancel(cancel.model_copy(update={'session_id':'f'*32}))


async def test_reload_respects_live_worker_generation(owner, monkeypatch):
    from amazme_backend.contracts import WorkerInfo
    from amazme_backend.execution.processes import ProcessReservation

    view = await owner.plugins.register(register(owner))
    with ProcessReservation(owner.profile.path, 'worker', '1'*32) as reservation:
        worker = WorkerInfo(session_id=SESSION, worker_id='live-boundary', pid=0, socket='', build_id=owner.build,
                            process_lease=reservation.lease, state='ready', plugin_fingerprint=await owner.plugins.set_fingerprint(SESSION))
        async def workers(session=''):
            return [worker] if not session or session == SESSION else []
        with monkeypatch.context() as patch:
            patch.setattr(owner, 'workers', workers)
            with pytest.raises(BackendError, match='plugin_reload_blocked'):
                await owner.plugins.reload(reload(owner))
            assert (await owner.plugins.list(SESSION)).plugins == [view]
            # An unrelated live worker does not own the other session's plugins.
            other = register(owner).model_copy(update={'plugin_id':'8'*32,'session_id':'9'*32})
            assert (await owner.plugins.register(other)).phase == 'ready'
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
    from amazme_backend.host.integrations import IntegrationOperations
    from amazme_backend.host.service import Host
    from amazme_backend.host.sessions import SessionOperations
    from amazme_backend.interfaces.rpc import RpcParams, _dispatch
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
    owner = Mock(spec=Host)
    owner.sessions = Mock(spec=SessionOperations)
    owner.sessions.sessions = AsyncMock(return_value=sessions)
    owner.integrations = Mock(spec=IntegrationOperations)
    owner.integrations.register_plugin = AsyncMock(return_value=view)
    owner.integrations.reload_plugin = AsyncMock(return_value=view)
    owner.integrations.call_plugin = AsyncMock(return_value=result)
    owner.integrations.cancel_plugin = AsyncMock(return_value=stopped)
    owner.integrations.close_plugin = AsyncMock(return_value=view)
    binding = {'session_id':SESSION,'workspace':'primary','attachment_id':'binding','plugin_id':PLUGIN}
    assert await _dispatch(owner,'plugin.register',RpcParams(plugin_draft=draft)) == view
    assert await _dispatch(owner,'plugin.reload',RpcParams(plugin_id=PLUGIN,plugin_reload=public_load)) == view
    assert await _dispatch(owner,'plugin.call',RpcParams(**binding,plugin_call=request)) == result
    assert await _dispatch(owner,'plugin.cancel',RpcParams(**binding,call_id=CALL)) == stopped
    assert await _dispatch(owner,'plugin.close',RpcParams(**binding)) == view
    owner.integrations.call_plugin.assert_awaited_once_with(SESSION,PLUGIN,request)
    owner.integrations.cancel_plugin.assert_awaited_once_with(SESSION,PLUGIN,CALL)


async def test_session_processes_isolate_factory_state_workspaces_and_call_ownership(owner):
    await owner.plugins.register(register(owner))
    assert (await owner.plugins.call(call(owner))).result.details['count'] == 1
    other = owner.profile.path / 'other-workspace'
    other.mkdir()
    with sqlite3.connect(owner.profile.path / 'host.sqlite') as db:
        db.execute('CREATE TABLE workspace_grants(name TEXT, host_path TEXT)')
        db.execute('INSERT INTO workspace_grants VALUES(?,?)', ('other',str(other)))
        db.execute('UPDATE sessions SET workspace=? WHERE id=?', ('other','9'*32))
    second = register(owner).model_copy(update={'plugin_id':'8'*32,'session_id':'9'*32})
    await owner.plugins.register(second)
    same = await owner.plugins.call(call(owner,call_id='6'*32))
    assert same.result.details['count'] == 2
    separate = call(owner,call_id='7'*32).model_copy(update={'plugin_id':'8'*32,'session_id':'9'*32,'workspace':'other'})
    result = await owner.plugins.call(separate)
    assert result.result.details['count'] == 1 and result.result.details['session'] == '9'*32
    assert (other / 'effects.txt').read_text() == '7'*32 + ':Bob\n'
    assert len((owner.profile.path / 'effects.txt').read_text().splitlines()) == 2
    with pytest.raises(BackendError,match='plugin_session_mismatch'):
        await owner.plugins.call(separate.model_copy(update={'plugin_id':PLUGIN,'call_id':'5'*32}))
    with pytest.raises(BackendError,match='workspace_mismatch'):
        await owner.plugins.call(separate.model_copy(update={'workspace':'primary','call_id':'4'*32}))
    with pytest.raises(BackendError,match='plugin_session_mismatch'):
        await owner.plugins.reload(reload(owner).model_copy(update={'session_id':'9'*32}))
    assert [view.plugin_id for view in (await owner.plugins.list(SESSION)).plugins] == [PLUGIN]


async def test_waiting_work_blocks_plugin_registration_and_history_remains(tmp_path: Path) -> None:
    import httpx

    from amazme_backend.contracts import CreateSession, HostFence, Submit
    from amazme_backend.host.service import Host
    from amazme_backend.interfaces.http.application import application
    from amazme_backend.profiles.layout import session_database
    from amazme_backend.sessions.service import SessionStore
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "plugins", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    host.origin = "http://127.0.0.1:12345"
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="等待"))
    path = session_database(tmp_path, SESSION)
    path.parent.mkdir(parents=True, mode=0o700)
    store = SessionStore(path, SESSION, build=host.lifecycle.build, approval_policy="auto", instance="worker")
    await store.initialize()
    await store.fence(host.lifecycle.fence)
    try:
        await store.accept(Submit(request_id="later", text="keep me", not_before_ms=2_000_000_000_000), host.lifecycle.fence)
        app = application(host)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=host.origin,
                                      headers={"Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
                                               "x-amazme-epoch": str(host.lifecycle.fence.host_epoch)}) as client:
            blocked = await client.post("/api/v1/plugins", json={
                "session_id":SESSION, "entry":"/user/plugin.py", "plugin_id": PLUGIN, "name": "notes", "config": {"label": "记事"}})
            assert blocked.status_code == 409 and blocked.json()["code"] == "plugin_reload_blocked"
            still = await client.post(f"/api/v1/plugins/{PLUGIN}/reload", json={"session_id":SESSION, "reload_id":"d"*32, "config": {"label": "改过"}})
            assert still.status_code == 409 and still.json()["code"] == "plugin_reload_blocked"
        assert (await store.get("later")).status == "waiting_time"
        await store.cancel("later", host.lifecycle.fence)
        assert (await store.get("later")).status == "cancelled"
        assert "keep me" in (await store.get("later")).text
    finally:
        await store.close()
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


@pytest_asyncio.fixture
async def model_rig(owner, monkeypatch):
    from types import SimpleNamespace

    from amazme_backend.bootstrap.worker import create_worker
    from amazme_backend.contracts import HostFence, PluginOffer, WorkerInfo
    from amazme_backend.execution.processes import ProcessReservation
    from amazme_backend.profiles.layout import session_database

    view = await owner.plugins.register(register(owner))
    path = session_database(owner.profile.path, SESSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr('amazme_backend.bootstrap.worker.build_id', lambda: owner.build)
    worker = create_worker(owner.profile, SESSION, '2'*32)
    store = worker.store
    await store.initialize()
    fence = HostFence(host_epoch=owner.host_epoch,build_id=owner.build)
    await store.fence(fence)
    class Peer:
        def __init__(self):
            self.lose = False
            self.calls = []
        async def call(self, method, path, model, body=None):
            self.calls.append((path,body))
            if path == '/plugins/call':
                result = await owner.plugins.call(body)
                if self.lose:
                    self.lose = False
                    raise BackendError('peer_unavailable')
                return result
            if path == '/plugins/cancel':
                return await owner.plugins.cancel(body)
            if path == '/effects/resolve':
                return await owner.resolve_effect(body)
            if path == '/health':
                return await owner.health()
            raise AssertionError(path)
    worker.storage_ready = True
    peer = Peer()
    monkeypatch.setattr(worker.supervisor, 'call', peer.call)
    with ProcessReservation(owner.profile.path,'worker',worker.instance) as reservation:
        info = WorkerInfo(session_id=SESSION,worker_id=worker.instance,pid=0,socket='',build_id=owner.build,
            process_lease=reservation.lease,state='ready',plugin_fingerprint=await owner.plugins.set_fingerprint(SESSION))
        try:
            await owner.db.call(lambda db:db.execute("INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
                (info.worker_id,info.session_id,info.model_dump_json())),write=True)
            yield SimpleNamespace(owner=owner,store=store,worker=worker,peer=peer,fence=fence,offer=PluginOffer.from_view(view,'primary')[0])
        finally:
            await worker.supervisor.close()
            await store.close()


async def observable(store):
    from amazme_backend.sessions.types import Continue
    for _ in range(30):
        action = await store.advance()
        if not isinstance(action,Continue):
            return action
    pytest.fail('no observable progress')


async def model_proposal(rig,mode='',approve=True):
    from amazme_backend.contracts import ApprovalDecision, Message, Submit, ToolCall
    from amazme_backend.sessions.types import Completion, ModelInvocation, ModelReturned, Park
    await rig.store.accept(Submit(request_id='root',text='Use the greeting plugin'),rig.fence)
    model = await observable(rig.store)
    assert isinstance(model,ModelInvocation)
    await rig.store.bind_model_tools(model.step_id,model.generation,'[]',json.dumps([rig.offer.model_dump()]))
    await rig.store.advance(ModelReturned(model,Completion(response_id='response',message=Message(role='assistant',content='',tool_calls=[
        ToolCall(id='provider-call',name=rig.offer.alias,arguments=json.dumps({'name':'Bob','mode':mode}))]))))
    assert isinstance(await observable(rig.store),Park)
    if not approve:
        return
    approval = (await rig.store.snapshot()).approvals[-1]
    await rig.store.approve(ApprovalDecision(decision_id='allow',approval_id=approval.approval_id,
        expected_revision=approval.revision,proposal_digest=approval.proposal_digest,approve=True),rig.fence)
    return await observable(rig.store)


async def test_model_plugin_waits_for_approval_and_lost_receipt_reuses_one_effect(model_rig):
    from amazme_backend.contracts import ApprovalDecision
    from amazme_backend.sessions.types import Failed, ModelInvocation, PluginRetrieval
    rig = model_rig
    await model_proposal(rig,approve=False)
    assert not (rig.owner.profile.path/'effects.txt').exists()
    approval = (await rig.store.snapshot()).approvals[-1]
    await rig.store.approve(ApprovalDecision(decision_id='allow',approval_id=approval.approval_id,
        expected_revision=approval.revision,proposal_digest=approval.proposal_digest,approve=True),rig.fence)
    action = await observable(rig.store)
    assert isinstance(action,PluginRetrieval)
    rig.peer.lose = True
    with pytest.raises(BackendError,match='peer_unavailable'):
        await rig.worker.perform(action)
    await rig.store.advance(Failed(action,'peer_unavailable'))
    again = await observable(rig.store)
    assert again == action
    observed = await rig.worker.perform(again)
    await rig.store.advance(observed)
    follow = await observable(rig.store)
    assert isinstance(follow,ModelInvocation)
    assert any(message.role=='tool' and 'Hello, Bob!' in message.content for message in follow.messages)
    assert len((rig.owner.profile.path/'effects.txt').read_text().splitlines()) == 1
    calls = [body.call_id for path,body in rig.peer.calls if path=='/plugins/call']
    assert len(calls)==2 and calls[0]==calls[1]==action.step_id[:32]


async def test_unknown_plugin_uses_shared_effect_resolution_and_blocks_new_writes(model_rig):
    from amazme_backend.contracts import EffectResolution, PluginToolCall
    from amazme_backend.sessions.types import ReconcileEffect
    rig = model_rig
    action = await model_proposal(rig,mode='crash')
    observed = await rig.worker.perform(action)
    assert observed.view.phase=='unknown' and observed.view.clean
    await rig.store.advance(observed)
    await observable(rig.store)
    hold = (await rig.store.snapshot()).effects[0]
    assert hold.call_id==action.step_id and hold.resource_clean and not hold.reconciled
    assert await rig.owner.write_conflict(SESSION)
    args = PluginToolCall.model_validate_json(action.call.arguments)
    original = next(body for path,body in rig.peer.calls if path=='/plugins/call')
    with pytest.raises(BackendError,match='unknown_effect_conflict'):
        await rig.owner.plugins.call(original.model_copy(update={'call_id':'f'*32,'step_id':'f'*64}))
    resolution = EffectResolution(resolution_id='inspect',call_id=action.step_id,outcome='applied',evidence='The workspace effect file contains the original call once')
    await rig.store.resolve(resolution,rig.fence)
    reconcile = await observable(rig.store)
    assert isinstance(reconcile,ReconcileEffect)
    await rig.store.advance(await rig.worker.perform(reconcile))
    assert (await rig.store.snapshot()).effects[0].reconciled
    assert not await rig.owner.write_conflict(SESSION)
    assert (await rig.owner.plugins.call(original)).phase=='unknown'
    assert (rig.owner.profile.path/'effects.txt').read_text() == args.call_id+':Bob\n'


async def test_model_media_uses_private_tool_images_and_late_cleanup_proofs_do_not_reconcile(model_rig):
    from amazme_backend.contracts import EffectHold
    from amazme_backend.sessions.types import ModelInvocation
    rig = model_rig
    action = await model_proposal(rig,mode='image')
    observed = await rig.worker.perform(action)
    assert observed.images and 'Hello, Bob!' in observed.text
    encoded = observed.images[0].data_base64
    await rig.store.advance(observed)
    next_model = await observable(rig.store)
    assert isinstance(next_model,ModelInvocation)
    assert any(message.role=='tool' and message.images[0].data_base64==encoded for message in next_model.messages if message.images)
    assert encoded not in (await rig.store.events(0)).model_dump_json()
    # A proof refresh may establish cleanup, never substitute for the user's evidence.
    hold = EffectHold(call_id='held',session_id=SESSION,request_id='root',reason='plugin_outcome_unknown',resource_clean=False)
    await rig.store._store.database.call(lambda db:db.execute('INSERT INTO effects VALUES(?,?)',('held',hold.model_dump_json())))
    await rig.store.refresh_effect_proofs([hold.model_copy(update={'session_id':'9'*32,'resource_clean':True})])
    assert not (await rig.store.snapshot()).effects[0].resource_clean
    await rig.store.refresh_effect_proofs([hold.model_copy(update={'resource_clean':True,'reconciled':True})])
    saved = (await rig.store.snapshot()).effects[0]
    assert saved.resource_clean and not saved.reconciled


async def test_disconnected_waiter_does_not_cancel_the_supervisor_owned_plugin_job(owner):
    await owner.plugins.register(register(owner))
    original = call(owner,mode='wait')
    waiter = asyncio.create_task(owner.plugins.call(original))
    for _ in range(100):
        if (owner.profile.path/'effects.txt').exists():
            break
        await asyncio.sleep(.01)
    assert (owner.profile.path/'effects.txt').exists()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert CALL in owner.plugins.jobs and not owner.plugins.jobs[CALL].done()
    stopped = await owner.plugins.cancel(CancelPlugin(host_epoch=owner.host_epoch,build_id=owner.build,
        session_id=SESSION,plugin_id=PLUGIN,call_id=CALL))
    assert stopped.clean and stopped.cancel_requested
    assert (await owner.plugins.call(original)).phase=='unknown'
    assert len((owner.profile.path/'effects.txt').read_text().splitlines())==1


async def test_model_denial_or_stale_plugin_catalog_never_runs_the_function(model_rig):
    from amazme_backend.contracts import ApprovalDecision, PluginToolCall
    rig = model_rig
    await model_proposal(rig,approve=False)
    approval = (await rig.store.snapshot()).approvals[-1]
    await rig.store.approve(ApprovalDecision(decision_id='deny',approval_id=approval.approval_id,
        expected_revision=approval.revision,proposal_digest=approval.proposal_digest,approve=False),rig.fence)
    await observable(rig.store)
    assert (await rig.store.get('root')).error=='approval_denied'
    assert not (rig.owner.profile.path/'effects.txt').exists()
    args = PluginToolCall(plugin_id=PLUGIN,call_id='e'*32,workspace='primary',fingerprint=rig.offer.fingerprint,
        load_id=rig.offer.load_id,schema_digest='0'*64,name='hello',arguments={'name':'Bob'})
    envelope = PluginCallEnvelope(**rig.fence.model_dump(),origin='model',worker_id=rig.worker.instance,
        session_id=SESSION,plugin_id=PLUGIN,call_id=args.call_id,name=args.name,arguments=args.arguments,
        step_id='e'*64,request_id='next',expected_fingerprint=args.fingerprint,expected_load_id=args.load_id,
        expected_schema_digest=args.schema_digest)
    with pytest.raises(BackendError,match='plugin_catalog_conflict'):
        await rig.owner.plugins.call(envelope)
    assert not (rig.owner.profile.path/'effects.txt').exists()
    assert await rig.owner.db.call(lambda db:db.execute('SELECT count(*) FROM plugin_calls').fetchone()[0])==0
