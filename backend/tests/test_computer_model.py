"""Computer tools share model approval, generation fencing and unknown-result semantics."""

import json
from pathlib import Path

import pytest

from amazme_backend.contracts import ApprovalDecision, BackendError, ComputerToolRequest, ComputerToolResult, HostFence, ImagePart, Message, Submit, ToolCall
from amazme_backend.ai.providers.anthropic import anthropic_body
from amazme_backend.ai.providers.google import google_body
from amazme_backend.ai.providers.responses import responses_body
from amazme_backend.ai.providers.completions import provider_messages
from amazme_backend.agent.model import ProductCompletion as Completion, model_request, model_spec, model_transport
from amazme_backend.agent.tool_catalog import build_tools
from amazme_backend.ai.types import Auth, ModelMessage
from amazme_backend.sessions.types import ComputerRetrieval, ComputerReturned, Failed, ModelInvocation, ModelReturned, Park
from amazme_backend.sessions.service import SessionStore

FENCE = HostFence(host_epoch=1, build_id='test-build')
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='


async def advance(store):
    for _ in range(20):
        action = await store.advance()
        if action.__class__.__name__ != 'Continue':
            return action
    pytest.fail('no observable progress')


async def propose(store, name, arguments, fence=FENCE):
    await store.accept(Submit(request_id='root', text='帮我观察桌面并点击目标'), fence)
    model = await advance(store)
    assert isinstance(model, ModelInvocation)
    await store.advance(ModelReturned(model, Completion(response_id='model-response', message=Message(role='assistant', content='', tool_calls=[
        ToolCall(id='provider-tool', name=name, arguments=json.dumps(arguments))]))))
    return await advance(store)


async def opened(tmp_path, policy='mutations'):
    store = SessionStore(tmp_path / 'session.sqlite', 'session', approval_policy=policy, instance='worker')
    await store.initialize()
    await store.fence(FENCE)
    return store


async def test_desktop_mutation_waits_for_bound_approval_and_denial_sends_nothing(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    try:
        assert isinstance(await propose(store, 'computer_act', {'capture_id':'frame', 'delivery_mode':'foreground', 'action':{'action':'click','point':{'x':1,'y':2}}}), Park)
        approval = (await store.snapshot()).approvals[-1]
        assert approval.state == 'pending' and approval.call.name == 'computer_act'
        await store.approve(ApprovalDecision(decision_id='deny', approval_id=approval.approval_id,
            expected_revision=approval.revision, proposal_digest=approval.proposal_digest, approve=False), FENCE)
        assert not isinstance(await advance(store), ComputerRetrieval)
        assert (await store.get('root')).error == 'approval_denied'
    finally:
        await store.close()


async def test_observation_image_reaches_next_model_without_event_base64(tmp_path: Path) -> None:
    store = await opened(tmp_path)
    try:
        action = await propose(store, 'computer_observe', {})
        assert isinstance(action, ComputerRetrieval)
        request = ComputerToolRequest(**FENCE.model_dump(), session_id='session', worker_id='worker',
            step_id=action.step_id, request_id=action.request_id, generation=action.generation, call=action.call)
        await store.check_computer_intent(request)
        with pytest.raises(BackendError, match='computer_intent_mismatch'):
            await store.check_computer_intent(request.model_copy(update={'generation': action.generation + 1}))
        await store.advance(ComputerReturned(action, ComputerToolResult(phase='done', result='capture frame',
            images=[ImagePart(media_type='image/png', data_base64=PNG)])))
        follow = await advance(store)
        assert isinstance(follow, ModelInvocation)
        tool = next(item for item in follow.messages if item.role == 'tool')
        assert tool.images[0].data_base64 == PNG and tool.tool_call_id == 'provider-tool'
        replay = await store.events(0)
        assert PNG not in replay.model_dump_json()
        with pytest.raises(BackendError, match='computer_intent_mismatch'):
            await store.check_computer_intent(request)
    finally:
        await store.close()


@pytest.mark.parametrize('transport_failure', [False, True])
async def test_unknown_click_is_terminal_and_not_automatically_replayed(tmp_path: Path, transport_failure: bool) -> None:
    store = await opened(tmp_path, 'auto')
    try:
        action = await propose(store, 'computer_act', {'capture_id':'frame', 'delivery_mode':'foreground', 'action':{'action':'click','point':{'x':1,'y':2}}})
        assert isinstance(action, ComputerRetrieval)
        observation = Failed(action, 'lost') if transport_failure else ComputerReturned(action, ComputerToolResult(phase='unknown'))
        await store.advance(observation)
        assert not isinstance(await advance(store), ComputerRetrieval)
        assert (await store.get('root')).status == 'unknown'
    finally:
        await store.close()


async def test_cancelled_desktop_intent_settles_without_dispatch(tmp_path: Path) -> None:
    store = await opened(tmp_path, 'auto')
    try:
        action = await propose(store, 'computer_act', {'capture_id':'frame', 'delivery_mode':'foreground', 'action':{'action':'click','point':{'x':1,'y':2}}})
        assert isinstance(action, ComputerRetrieval)
        await store.cancel('root', FENCE)
        assert not isinstance(await advance(store), ComputerRetrieval)
        assert (await store.get('root')).status == 'cancelled'
    finally:
        await store.close()


def test_all_model_wire_paths_include_tool_images() -> None:
    from amazme_backend.contracts import ProviderConfig
    messages = [Message(role='tool', content='capture frame', tool_call_id='call',
                        images=[ImagePart(media_type='image/png', data_base64=PNG)])]
    config = ProviderConfig(provider='openai', model='custom', base_url='https://api.example/v1')
    auth = Auth()
    model, request = model_spec(config), model_request(config, messages, auth=auth)
    bodies = [provider_messages(model, request), responses_body(model, request),
              anthropic_body(model, request, auth, model_transport(config))[0], google_body(model, request)]
    assert all(PNG in json.dumps(body) for body in bodies)
    names = {tool.name for tool in build_tools()}
    assert {'computer_observe', 'computer_act'} <= names


def test_tool_images_follow_the_entire_parallel_tool_batch() -> None:
    from amazme_backend.ai.providers.history import tool_image_messages
    messages = [Message(role='assistant', content='', tool_calls=[
        ToolCall(id='first', name='computer_observe', arguments='{}'),
        ToolCall(id='second', name='read_file', arguments='{"path":"file"}')]),
        Message(role='tool', content='frame', tool_call_id='first', images=[ImagePart(media_type='image/png', data_base64=PNG)]),
        Message(role='tool', content='file', tool_call_id='second')]
    expanded = tool_image_messages([ModelMessage.model_validate(message.model_dump()) for message in messages])
    assert [message.role for message in expanded] == ['assistant', 'tool', 'tool', 'user']
    assert expanded[-1].images[0].data_base64 == PNG


async def test_host_computer_dispatch_requires_live_owner_and_the_exact_session_intent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from helpers.computer_probe import start_driver
    from test_computer_use import _host, _stop

    from amazme_backend.contracts import ComputerPolicy, CreateSession, ProcessLease, ServiceInfo, SupervisorHealth, WorkerInfo
    from amazme_backend.sessions.service import run_session_op
    from amazme_backend.contracts.ipc.worker import SessionOpResult
    from amazme_backend.profiles.layout import session_database
    host = _host(tmp_path, 'granted')
    lease = ProcessLease(instance_id='supervisor', role='supervisor', profile_path=str(tmp_path),
                         path=str(tmp_path / 'lease'), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    await host.lifecycle.store.create_session('a' * 32, CreateSession(title='model desktop'))
    await host.lifecycle.store.save_service(ServiceInfo(instance_id='supervisor', build_id=host.lifecycle.build, process_lease=lease, state='running'))
    directory = session_database(tmp_path, 'a' * 32)
    directory.parent.mkdir(parents=True)
    store = SessionStore(directory, 'a' * 32, build=host.lifecycle.build, instance='worker')
    await store.initialize()
    await store.fence(host.lifecycle.fence)
    await store.save_computer_policy(ComputerPolicy(enabled=True))
    action = await propose(store, 'computer_observe', {}, host.lifecycle.fence)
    assert isinstance(action, ComputerRetrieval)
    health = SupervisorHealth(identity=host.lifecycle.profile.identity('supervisor', host.lifecycle.build, role='supervisor', host_epoch=host.lifecycle.fence.host_epoch),
        registry_revision='1', workers=[WorkerInfo(session_id='a' * 32, worker_id='worker', pid=100, socket='unused',
            build_id=host.lifecycle.build, fingerprint=host.lifecycle.build, host_epoch=host.lifecycle.fence.host_epoch,
            state='ready', process_lease=lease)], epochs=[])

    async def supervisor(*args):
        return health

    class WorkerPeer:
        async def call(self, method, path, response, body):
            assert path == '/session-ops'
            return SessionOpResult(payload=await run_session_op(store, body.name, body.payload))

    async def worker(*args):
        return WorkerPeer()

    monkeypatch.setattr(host.lifecycle.supervisor, 'call', supervisor)
    monkeypatch.setattr(host.access, 'worker', worker)
    monkeypatch.setattr('amazme_backend.host.computer.exited', lambda _: False)
    monkeypatch.setattr('amazme_backend.host.computer.start_driver', lambda directory: start_driver(directory, 'granted'))
    request = ComputerToolRequest(**host.lifecycle.fence.model_dump(), session_id='a' * 32, worker_id='worker',
        step_id=action.step_id, request_id=action.request_id, generation=action.generation, call=action.call)
    try:
        with pytest.raises(BackendError, match='worker_identity_mismatch'):
            await host.computer.computer_model_tool(request.model_copy(update={'worker_id': 'other'}))
        assert host.computer.computer_drivers == {}
        with pytest.raises(BackendError, match='computer_intent_mismatch'):
            await host.computer.computer_model_tool(request.model_copy(update={'generation': action.generation + 1}))
        assert host.computer.computer_drivers == {}
        result = await host.computer.computer_model_tool(request)
        assert result.phase == 'done' and json.loads(result.result)['permitted']
        await store.cancel('root', host.lifecycle.fence)
        with pytest.raises(BackendError, match='computer_intent_mismatch'):
            await host.computer.computer_model_tool(request)
    finally:
        await store.close()
        await _stop(host)


@pytest.mark.parametrize('name,arguments,needs_approval',[
    ('computer_ground',{'target':{'pid':12,'window_id':3},'goal':'Continue','verification':'Success'},True),
    ('computer_locate',{'capture_id':'frame','target':{'pid':12,'window_id':3},'description':'Continue'},False),
])
async def test_grounding_tools_share_the_original_approval_and_generation_gate(tmp_path,name,arguments,needs_approval):
    store = await opened(tmp_path)
    try:
        action = await propose(store,name,arguments)
        if needs_approval:
            assert isinstance(action,Park)
            approval = (await store.snapshot()).approvals[-1]
            assert approval.call.name == name
            await store.approve(ApprovalDecision(decision_id='allow',approval_id=approval.approval_id,
                expected_revision=approval.revision,proposal_digest=approval.proposal_digest,approve=True),FENCE)
            action = await advance(store)
        assert isinstance(action,ComputerRetrieval) and action.call.name == name
        request = ComputerToolRequest(**FENCE.model_dump(),session_id='session',worker_id='worker',step_id=action.step_id,
            request_id=action.request_id,generation=action.generation,call=action.call)
        await store.check_computer_intent(request)
        with pytest.raises(BackendError,match='computer_intent_mismatch'):
            await store.check_computer_intent(request.model_copy(update={'generation':action.generation+1}))
    finally:
        await store.close()
