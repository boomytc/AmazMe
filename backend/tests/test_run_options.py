"""One durable run owns its prompt and tools across retries, steering and delegation."""

import json
import sqlite3
from pathlib import Path

import pytest

from amazme_backend.contracts import BackendError, HostFence, Message, ProviderConfig, Submit, ToolCall
from amazme_backend.provider_wire import anthropic_body, google_body, responses_body
from amazme_backend.providers import Completion, provider_messages, tool_definitions
from amazme_backend.session_domain import Continue, ModelInvocation, ModelReturned, Park
from amazme_backend.storage import SessionStore

FENCE = HostFence(host_epoch=1, build_id='test-build')


async def next_action(store):
    for _ in range(30):
        action = await store.advance()
        if not isinstance(action, Continue):
            return action
    pytest.fail('no progress')


async def opened(path: Path):
    store = SessionStore(path, 'session', approval_policy='auto')
    await store.initialize()
    await store.fence(FENCE)
    return store


def test_prompt_and_disabled_tools_reach_every_wire_protocol() -> None:
    config = ProviderConfig(provider='faux', system_prompt='Only this.', append_system_prompt='And this.', allowed_tools=[])
    expected = 'Only this.\n\nAnd this.'
    assert provider_messages([], config=config)[0]['content'] == expected
    assert tool_definitions(None, config) == []
    for api in ('openai-responses', 'openai-codex-responses'):
        body = responses_body(config.model_copy(update={'api':api}), [], None)
        assert body['instructions'] == expected and 'tools' not in body and 'tool_choice' not in body
    body, _ = anthropic_body(config, [], None)
    assert body['system'] == expected and 'tools' not in body
    body = google_body(config, [], None)
    assert body['systemInstruction'] == {'parts':[{'text':expected}]} and 'tools' not in body
    assert 'You are AmazMe' in str(provider_messages([])[0]['content'])


def test_tool_patterns_and_exclusions_share_the_wire_selection() -> None:
    config = ProviderConfig(provider='faux', allowed_tools=['*'], excluded_tools=['write_*', 'computer_*'])
    names = [item['function']['name'] for item in tool_definitions(None, config)]
    assert 'read_file' in names and 'write_file' not in names and 'computer_act' not in names
    assert config.tool_allowed('mcp_' + 'a'*20)
    config.allowed_tools = ['mcp_*']
    assert tool_definitions(None, config) == [] and not config.tool_allowed('shell')


async def test_options_survive_restart_and_same_id_cannot_change_them(tmp_path: Path) -> None:
    path = tmp_path / 'session.sqlite'
    value = Submit(request_id='root', text='hello', system_prompt='Keep this', append_system_prompt='tail', allowed_tools=[])
    store = await opened(path)
    await store.accept(value, FENCE)
    await store.db.close()
    store = await opened(path)
    try:
        assert (await store.accept(value, FENCE)).request_id == 'root'
        with pytest.raises(BackendError, match='request_conflict'):
            await store.accept(value.model_copy(update={'allowed_tools':['shell']}), FENCE)
        with pytest.raises(BackendError, match='run_options_immutable'):
            await store.accept(Submit(request_id='steer', text='change', mode='steer', target_run_id='root', allowed_tools=['shell']), FENCE)
        model = await next_action(store)
        assert isinstance(model, ModelInvocation)
        assert model.config.system_prompt == 'Keep this' and model.config.append_system_prompt == 'tail'
        assert model.config.allowed_tools == []
    finally:
        await store.db.close()


async def test_forbidden_batch_never_proposes_or_executes_any_tool(tmp_path: Path) -> None:
    store = await opened(tmp_path / 'session.sqlite')
    try:
        await store.accept(Submit(request_id='root', text='read only', allowed_tools=['read_file']), FENCE)
        model = await next_action(store)
        assert isinstance(model, ModelInvocation)
        await store.advance(ModelReturned(model, Completion(response_id='model', message=Message(role='assistant', content='', tool_calls=[
            ToolCall(id='allowed', name='read_file', arguments='{"path":"ok"}'),
            ToolCall(id='forbidden', name='shell', arguments='{"command":"touch forbidden"}')]))))
        assert isinstance(await next_action(store), Park)
        receipt = await store.get('root')
        assert receipt.status == 'failed' and receipt.error == 'tool_not_allowed'
        assert (await store.snapshot()).approvals == []
        with sqlite3.connect(store.db.path) as db:
            assert db.execute("SELECT count(*) FROM steps WHERE json_extract(payload,'$.kind')='tool'").fetchone()[0] == 0
    finally:
        await store.db.close()


async def test_children_inherit_prompt_and_tool_scope(tmp_path: Path) -> None:
    store = await opened(tmp_path / 'session.sqlite')
    try:
        await store.accept(Submit(request_id='root', text='delegate', system_prompt='parent prompt',
                                  allowed_tools=['delegate_task', 'read_file'], excluded_tools=['mcp_*']), FENCE)
        model = await next_action(store)
        assert isinstance(model, ModelInvocation)
        await store.advance(ModelReturned(model, Completion(response_id='model', message=Message(role='assistant', content='', tool_calls=[
            ToolCall(id='child', name='delegate_task', arguments=json.dumps({'tasks':['read something']}))]))))
        child = await next_action(store)
        assert isinstance(child, ModelInvocation) and child.request_id != 'root'
        assert child.config.system_prompt == 'parent prompt'
        assert child.config.allowed_tools == ['delegate_task','read_file'] and child.config.excluded_tools == ['mcp_*']
    finally:
        await store.db.close()


async def test_sdk_and_rpc_preserve_run_options() -> None:
    from unittest.mock import AsyncMock, Mock

    import httpx

    from amazme_backend.contracts import Receipt, Session, SessionList
    from amazme_backend.rpc import RpcHost, RpcParams, _dispatch
    from amazme_backend.sdk import Client

    options = {'system_prompt':'pinned', 'append_system_prompt':'tail', 'allowed_tools':[], 'excluded_tools':['mcp_*']}
    receipt = Receipt(request_id='original', text='hello', status='queued')
    sent = []

    def transport(request: httpx.Request):
        if request.method == 'GET':
            return httpx.Response(200, json={'sessions':[{'session_id':'session', 'title':'test'}]})
        sent.append(Submit.model_validate_json(request.content))
        assert request.headers['x-amazme-attachment'] == 'binding'
        return httpx.Response(200, json=receipt.model_dump())

    client = Client('http://local', 'token')
    await client._http.aclose()
    client._http = httpx.AsyncClient(base_url=client.base_url, transport=httpx.MockTransport(transport))
    try:
        await client.submit(session_id='session', workspace='primary', attachment_id='binding',
                            request_id='original', text='hello', **options)
    finally:
        await client._http.aclose()
    owner = Mock(spec=RpcHost)
    owner.sessions = AsyncMock(return_value=SessionList(sessions=[Session(session_id='session', title='test')]))
    owner.deliver = AsyncMock(return_value=receipt)
    await _dispatch(owner, 'request.submit', RpcParams(session_id='session', workspace='primary',
                    attachment_id='binding', request_id='original', text='hello', **options))
    assert owner.deliver.call_args.args[3] == sent[0]
    assert sent[0].model_dump(include=set(options)) == options
