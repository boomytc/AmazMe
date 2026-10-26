"""Python provider wire contracts against Pi-shaped SSE, without provider accounts."""

import json
from collections.abc import AsyncIterator

import httpx
import pytest
from pydantic import SecretStr

from amazme_backend.ai.providers.anthropic import anthropic, anthropic_body
from amazme_backend.ai.providers.google import google, google_body
from amazme_backend.ai.providers.responses import responses, responses_body
from amazme_backend.ai.types import (
    Auth,
    Completion,
    ModelMessage,
    ModelRequest,
    ModelSpec,
    ModelToolCall,
    RequestTransport,
    ToolDefinition,
)
from amazme_backend.contracts.models import ProviderApi
from amazme_backend.shared.errors import BackendError


def sse(events: list[dict[str, object]]) -> httpx.Response:
    return httpx.Response(200, content=''.join('data: ' + json.dumps(event) + '\n\n' for event in events),
                          headers={'content-type': 'text/event-stream'})


def config(provider: str, api: ProviderApi) -> ModelSpec:
    return ModelSpec(provider=provider, api=api, model='test', base_url='https://provider.example/v1')


def context(messages: list[ModelMessage] | None = None, *, wire_names: dict[str, str] | None = None) -> ModelRequest:
    return ModelRequest(messages=messages if messages is not None else [ModelMessage(role='user', content='hi')],
        system_prompt='Explicit caller system prompt.',
        tools=[ToolDefinition(name='shell', description='Run a command', parameters={'type':'object'})],
        wire_names=wire_names or {})


def auth() -> Auth:
    return Auth(api_key=SecretStr('secret'))


async def collect(stream: AsyncIterator[str | Completion]) -> tuple[str, Completion]:
    result = [item async for item in stream]
    final = [item for item in result if isinstance(item, Completion)]
    assert len(final) == 1
    return ''.join(item for item in result if isinstance(item, str)), final[0]


async def test_responses_retains_tool_ids_reasoning_and_usage() -> None:
    cfg = config('openai', 'openai-responses')
    sent = []
    encrypted = {'type': 'reasoning', 'id': 'rs_1', 'encrypted_content': 'opaque', 'summary': []}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        assert request.headers['authorization'] == 'Bearer secret'
        assert str(request.url) == 'https://provider.example/v1/responses'
        return sse([
            {'type': 'response.output_text.delta', 'delta': 'hello'},
            {'type': 'response.completed', 'response': {'id': 'resp_1', 'output': [encrypted,
                {'type': 'function_call', 'call_id': 'call_1', 'name': 'shell', 'arguments': '{"command":"pwd"}'}],
                'usage': {'input_tokens': 20, 'output_tokens': 8, 'input_tokens_details': {'cached_tokens': 4}}}},
        ])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        text, completed = await collect(responses(cfg, context(), auth(), RequestTransport(), client))
    assert text == 'hello' and completed.message.content == 'hello'
    assert completed.message.tool_calls[0].id == 'call_1'
    assert (completed.input_tokens, completed.output_tokens, completed.cache_read_tokens) == (20, 8, 4)
    followup = responses_body(cfg, context([ModelMessage(role='user', content='hi'), completed.message,
        ModelMessage(role='tool', tool_call_id='call_1', content='result')]))
    assert encrypted in followup['input']
    assert followup['input'][-1] == {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'result'}
    assert sent[0]['store'] is False
    assert sent[0]['instructions'] == 'Explicit caller system prompt.'


async def test_codex_headers_and_body_keep_pi_identity() -> None:
    import base64
    claims = base64.urlsafe_b64encode(json.dumps({'https://api.openai.com/auth': {'chatgpt_account_id': 'account'}}).encode()).decode().rstrip('=')
    cfg = config('openai-codex', 'openai-codex-responses').model_copy(update={
        'base_url': 'https://chatgpt.com/backend-api'})
    identity = Auth(auth_type='oauth', api_key=SecretStr('x.' + claims + '.x'))

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == 'https://chatgpt.com/backend-api/codex/responses'
        assert request.headers['originator'] == 'pi' and request.headers['chatgpt-account-id'] == 'account'
        body = json.loads(request.content)
        assert body['store'] is False and 'max_output_tokens' not in body
        return sse([{'type': 'response.completed', 'response': {'id': 'r', 'output': [], 'usage': {}}}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await collect(responses(cfg, context(), identity, RequestTransport(), client))


async def test_anthropic_oauth_preserves_canonical_tools_and_thinking_signature() -> None:
    cfg = config('anthropic', 'anthropic-messages')
    identity = auth().model_copy(update={'auth_type': 'oauth'})
    request = context(wire_names={'shell': 'Bash'})
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        assert request.headers['user-agent'] == 'claude-cli/2.1.280'
        assert request.headers['x-app'] == 'cli'
        assert request.headers['authorization'] == 'Bearer secret'
        assert 'oauth-2025-04-20' in request.headers['anthropic-beta']
        assert str(request.url) == 'https://provider.example/v1/messages'
        return sse([
            {'type': 'message_start', 'message': {'id': 'msg_1', 'usage': {'input_tokens': 10, 'cache_read_input_tokens': 3}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'thought'}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': 'sig'}},
            {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'tool_use', 'id': 'tool_1', 'name': 'Bash', 'input': {}}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '{"command":"pwd"}'}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 9}},
            {'type': 'message_stop'},
        ])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        _, completed = await collect(anthropic(cfg, request, identity, RequestTransport(), client))
    assert completed.message.tool_calls == [ModelToolCall(id='tool_1', name='shell', arguments='{"command":"pwd"}')]
    followup = context([completed.message, ModelMessage(role='tool', content='ok', tool_call_id='tool_1')], wire_names=request.wire_names)
    body, _ = anthropic_body(cfg, followup, identity, RequestTransport())
    assert body['messages'][0]['content'][0] == {'type': 'thinking', 'thinking': 'thought', 'signature': 'sig'}
    assert body['messages'][0]['content'][1]['name'] == 'Bash'
    assert body['messages'][1]['content'][0]['tool_use_id'] == 'tool_1'
    assert sent[0]['tools'][0]['name'] == 'Bash'
    assert sent[0]['system'][0]['text'] == "You are Claude Code, Anthropic's official CLI for Claude."
    assert (completed.input_tokens, completed.output_tokens, completed.cache_read_tokens) == (10, 9, 3)


async def test_google_preserves_function_signature_and_links_results_to_names() -> None:
    cfg = config('google', 'google-generative-ai').model_copy(update={'base_url': 'https://generativelanguage.googleapis.com/v1beta'})

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers['x-goog-api-key'] == 'secret'
        assert 'authorization' not in request.headers
        return sse([{'responseId': 'resp', 'candidates': [{'content': {'parts': [
            {'functionCall': {'name': 'shell', 'args': {'command': 'pwd'}}, 'thoughtSignature': 'encrypted'}]},
            'finishReason': 'STOP'}], 'usageMetadata': {'promptTokenCount': 4, 'candidatesTokenCount': 3}}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        _, completed = await collect(google(cfg, context(), auth(), RequestTransport(), client))
    call = completed.message.tool_calls[0]
    body = google_body(cfg, context([completed.message, ModelMessage(role='tool', tool_call_id=call.id, content='out')]))
    assert body['contents'][0]['parts'][0]['thoughtSignature'] == 'encrypted'
    assert body['contents'][1]['parts'][0]['functionResponse']['name'] == 'shell'
    assert (completed.input_tokens, completed.output_tokens) == (4, 3)


@pytest.mark.parametrize('api', ['openai-responses', 'anthropic-messages', 'google-generative-ai'])
async def test_incomplete_stream_never_creates_a_success(api: ProviderApi) -> None:
    cfg = config('custom', api)
    fn = {'openai-responses': responses, 'anthropic-messages': anthropic, 'google-generative-ai': google}[api]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: sse([]))) as client:
        with pytest.raises(BackendError, match='model_stream_interrupted'):
            await collect(fn(cfg, context(), auth(), RequestTransport(), client))


async def test_custom_tool_name_and_explicit_mapping_round_trip_without_product_whitelist() -> None:
    cfg = config('custom', 'openai-responses')
    request = ModelRequest(messages=[ModelMessage(role='user', content='weather')],
        tools=[ToolDefinition(name='weather.lookup', description='Weather', parameters={'type':'object'})],
        wire_names={'weather.lookup':'lookup_weather'})

    def handler(sent: httpx.Request) -> httpx.Response:
        assert sent.headers['authorization'] == 'Bearer secret'
        assert json.loads(sent.content)['tools'][0]['name'] == 'lookup_weather'
        return sse([{'type':'response.completed', 'response':{'id':'custom-response', 'usage':{},
            'output':[{'type':'function_call', 'call_id':'custom-call', 'name':'lookup_weather', 'arguments':'{}'}]}}])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        _, completed = await collect(responses(cfg, request, auth(), RequestTransport(), client))
    assert completed.message.tool_calls == [ModelToolCall(id='custom-call', name='weather.lookup', arguments='{}')]
    history = request.model_copy(update={'messages': [*request.messages, completed.message,
        ModelMessage(role='tool', tool_call_id='custom-call', content='sunny')]})
    replay = responses_body(cfg, history)
    assert next(item['name'] for item in replay['input'] if item.get('type') == 'function_call') == 'lookup_weather'
    assert replay['input'][-1] == {'type':'function_call_output', 'call_id':'custom-call', 'output':'sunny'}
