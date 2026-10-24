"""Python wire translation of Pi's Responses, Anthropic and Gemini chat paths."""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from urllib.parse import quote

import httpx
from pydantic import JsonValue, TypeAdapter

from .contracts import BackendError, Message, PluginOffer, ProviderConfig, ToolCall
from .mcp_session import McpOffer
from .model_catalog import INDEX
from .oauth import COPILOT_HEADERS
from .providers import (
    Completion,
    provider_messages,
    reasoning_signature,
    tool_definitions,
    tool_image_messages,
    with_catalog_price,
)

Record = dict[str, JsonValue]
RECORD = TypeAdapter(Record)
RECORDS = TypeAdapter(list[Record])


def record(value: JsonValue) -> Record:
    if not isinstance(value, dict):
        raise BackendError('model_protocol')
    return value


def items(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise BackendError('model_protocol')
    return value


def number(value: JsonValue) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def text(value: JsonValue) -> str:
    return value if isinstance(value, str) else ''


def tools(offers: list[McpOffer] | None, config: ProviderConfig, plugins: list[PluginOffer] | None = None) -> list[Record]:
    return [record(item['function']) for item in RECORDS.validate_python(tool_definitions(offers, config, plugins))]


def replay(message: Message) -> list[Record]:
    return RECORDS.validate_json(message.reasoning_signature) if message.reasoning_signature else []


async def events(client: httpx.AsyncClient, url: str, headers: dict[str, str], body: Record) -> AsyncIterator[Record]:
    async with client.stream('POST', url, json=body, headers=headers) as response:
        if not response.is_success:
            raise BackendError('model_http_' + str(response.status_code), status=503)
        buf, data = bytearray(), bytearray()
        async for chunk in response.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > 1048576:
                raise BackendError('model_event_limit')
            while b'\n' in buf:
                line, _, rest = buf.partition(b'\n')
                buf[:] = rest
                line = line.rstrip(b'\r')
                if line.startswith(b'data:'):
                    data.extend(line[5:].lstrip() + b'\n')
                    if len(data) > 1048576:
                        raise BackendError('model_event_limit')
                elif not line and data:
                    payload = bytes(data).strip()
                    data.clear()
                    if payload != b'[DONE]':
                        yield RECORD.validate_json(payload)
        if data or buf.strip():
            raise BackendError('model_stream_interrupted')


def base_headers(config: ProviderConfig, messages: list[Message]) -> dict[str, str]:
    metadata = INDEX.get((config.provider, config.model))
    headers = {**(metadata.headers if metadata else {}), **config.headers}
    if config.provider == 'github-copilot':
        headers.update(COPILOT_HEADERS)
        headers.update({'X-Initiator': 'user' if messages[-1].role == 'user' else 'agent',
                        'Openai-Intent': 'conversation-edits'})
        if any(message.images for message in messages):
            headers['Copilot-Vision-Request'] = 'true'
    headers['Authorization'] = 'Bearer ' + config.api_key.get_secret_value()
    return headers


def responses_body(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None, plugins: list[PluginOffer] | None = None) -> Record:
    converted: list[JsonValue] = []
    for message in tool_image_messages(messages):
        if message.role == 'user':
            content: list[JsonValue] = [{'type': 'input_text', 'text': message.content}]
            content.extend([{'type': 'input_image', 'image_url': f'data:{image.media_type};base64,{image.data_base64}'}
                        for image in message.images])
            converted.append({'role': 'user', 'content': content})
        elif message.role == 'tool':
            converted.append({'type': 'function_call_output', 'call_id': message.tool_call_id, 'output': message.content})
        else:
            for item in replay(message):
                if item.get('type') == 'reasoning':
                    converted.append(item)
            if message.content:
                converted.append({'role': 'assistant', 'content': [{'type': 'output_text', 'text': message.content}]})
            converted.extend([{'type': 'function_call', 'call_id': call.id, 'name': call.name, 'arguments': call.arguments}
                          for call in message.tool_calls])
    body: Record = {'model': config.model, 'stream': True, 'store': False, 'input': converted,
        'instructions': text(RECORDS.validate_python(provider_messages([], config.provider, config))[0].get('content')),
        'tools': [{'type': 'function', **tool} for tool in tools(offers, config, plugins)],
        'include': ['reasoning.encrypted_content'], 'tool_choice': 'auto', 'parallel_tool_calls': True}
    if not body['tools']:
        for key in ('tools', 'tool_choice', 'parallel_tool_calls'):
            body.pop(key)
    if config.api == 'openai-codex-responses':
        body['text'] = {'verbosity': 'low'}
    else:
        body['max_output_tokens'] = config.max_tokens
    return body


async def responses(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None,
                    client: httpx.AsyncClient, plugins: list[PluginOffer] | None = None) -> AsyncIterator[str | Completion]:
    headers = base_headers(config, messages)
    endpoint = config.base_url.rstrip('/') + '/responses'
    if config.api == 'openai-codex-responses':
        endpoint = config.base_url.rstrip('/') + '/codex/responses'
        headers.update({'originator': 'pi', 'OpenAI-Beta': 'responses=experimental',
                        'accept': 'text/event-stream', 'content-type': 'application/json'})
        try:
            import base64
            encoded = config.api_key.get_secret_value().split('.')[1]
            claims = RECORD.validate_json(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            headers['chatgpt-account-id'] = text(record(claims['https://api.openai.com/auth'])['chatgpt_account_id'])
        except (ValueError, IndexError, KeyError) as exc:
            raise BackendError('oauth_account_id_missing') from exc
    answer, finished = '', False
    async for event in events(client, endpoint, headers, responses_body(config, messages, offers, plugins)):
        kind = event.get('type')
        if kind in {'response.output_text.delta', 'response.refusal.delta'}:
            delta = text(event.get('delta'))
            answer += delta
            if len(answer) > 64000:
                raise BackendError('model_output_limit')
            yield delta
        elif kind == 'response.completed':
            response = record(event['response'])
            output = [record(item) for item in items(response.get('output', []))]
            calls = [ToolCall(id=text(item.get('call_id')), name=text(item.get('name')),
                              arguments=text(item.get('arguments'))) for item in output if item.get('type') == 'function_call']
            if len(calls) > 16 or len({call.id for call in calls}) != len(calls) or any(not call.id for call in calls) or sum(len(call.arguments) for call in calls) > 64000:
                raise BackendError('invalid_tool_calls')
            signature = [item for item in output if item.get('type') == 'reasoning']
            usage = record(response.get('usage', {}))
            cached = record(usage.get('input_tokens_details', {}))
            finished = True
            yield with_catalog_price(config, Completion(message=Message(role='assistant', content=answer,
                tool_calls=calls, reasoning_signature=reasoning_signature(list(signature))),
                response_id=text(response.get('id')), input_tokens=number(usage.get('input_tokens')),
                output_tokens=number(usage.get('output_tokens')), cache_read_tokens=number(cached.get('cached_tokens'))))
            return
        elif kind in {'response.failed', 'response.incomplete', 'error'}:
            raise BackendError('model_incomplete')
    if not finished:
        raise BackendError('model_stream_interrupted')


_CANONICAL = {'shell': 'Bash', 'read_file': 'Read', 'write_file': 'Write', 'delegate_task': 'Task',
              'web_search': 'WebSearch', 'web_fetch': 'WebFetch'}


def anthropic_body(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None, plugins: list[PluginOffer] | None = None) -> tuple[Record, dict[str, str]]:
    oauth = config.provider == 'anthropic' and (config.auth_type == 'oauth' or config.api_key.get_secret_value().startswith('sk-ant-oat'))
    names = _CANONICAL if oauth else {}
    converted: list[JsonValue] = []
    for message in tool_image_messages(messages):
        if message.role == 'tool':
            converted.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': message.tool_call_id,
                                                         'content': message.content}]})
        elif message.role == 'user':
            content: list[JsonValue] = [{'type': 'text', 'text': message.content}]
            content.extend([{'type': 'image', 'source': {'type': 'base64', 'media_type': image.media_type, 'data': image.data_base64}}
                        for image in message.images])
            converted.append({'role': 'user', 'content': content})
        else:
            parts: list[JsonValue] = [item for item in replay(message) if item.get('type') in {'thinking', 'redacted_thinking'}]
            if message.content:
                parts.append({'type': 'text', 'text': message.content})
            parts.extend([{'type': 'tool_use', 'id': call.id, 'name': names.get(call.name, call.name),
                       'input': RECORD.validate_json(call.arguments)} for call in message.tool_calls])
            converted.append({'role': 'assistant', 'content': parts})
    system = text(RECORDS.validate_python(provider_messages([], config.provider, config))[0].get('content'))
    body: Record = {'model': config.model, 'max_tokens': config.max_tokens, 'stream': True,
        'system': ([{'type': 'text', 'text': "You are Claude Code, Anthropic's official CLI for Claude."},
                    {'type': 'text', 'text': system}] if oauth else system),
        'messages': converted, 'tools': [{'name': names.get(text(tool['name']), tool['name']),
            'description': tool.get('description', ''), 'input_schema': tool['parameters']} for tool in tools(offers, config, plugins)]}
    if not body['tools']:
        body.pop('tools')
    metadata = INDEX.get((config.provider, config.model))
    if metadata is not None and metadata.compat.get('forceAdaptiveThinking') is True:
        body['thinking'] = {'type': 'adaptive'}
    headers = base_headers(config, messages)
    headers['anthropic-version'] = '2023-06-01'
    if oauth:
        headers.update({'user-agent': 'claude-cli/2.1.280', 'x-app': 'cli',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'anthropic-dangerous-direct-browser-access': 'true'})
    elif config.provider != 'github-copilot':
        headers.pop('Authorization', None)
        headers['x-api-key'] = config.api_key.get_secret_value()
    return body, headers


async def anthropic(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None,
                    client: httpx.AsyncClient, plugins: list[PluginOffer] | None = None) -> AsyncIterator[str | Completion]:
    body, headers = anthropic_body(config, messages, offers, plugins)
    base = config.base_url.rstrip('/')
    endpoint = base + ('/messages' if base.endswith('/v1') else '/v1/messages')
    blocks: dict[int, Record] = {}
    input_tokens = output_tokens = cached = written = 0
    response_id, answer, stop = '', '', ''
    finished = False
    async for event in events(client, endpoint, headers, body):
        kind = event.get('type')
        if kind == 'message_start':
            message = record(event['message'])
            response_id = text(message.get('id'))
            usage = record(message.get('usage', {}))
            input_tokens, cached, written = (number(usage.get(field)) for field in
                                            ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
        elif kind == 'content_block_start':
            blocks[number(event.get('index'))] = record(event['content_block'])
        elif kind == 'content_block_delta':
            block = blocks[number(event.get('index'))]
            delta = record(event['delta'])
            if delta.get('type') == 'text_delta':
                value = text(delta.get('text'))
                answer += value
                yield value
            elif delta.get('type') == 'input_json_delta':
                block['partial_json'] = text(block.get('partial_json')) + text(delta.get('partial_json'))
            elif delta.get('type') == 'thinking_delta':
                block['thinking'] = text(block.get('thinking')) + text(delta.get('thinking'))
            elif delta.get('type') == 'signature_delta':
                block['signature'] = text(block.get('signature')) + text(delta.get('signature'))
            if len(answer) > 64000 or len(json.dumps(blocks)) > 131072:
                raise BackendError('model_output_limit')
        elif kind == 'message_delta':
            stop = text(record(event['delta']).get('stop_reason'))
            usage = record(event.get('usage', {}))
            output_tokens = number(usage.get('output_tokens'))
        elif kind == 'message_stop':
            if stop not in {'end_turn', 'tool_use', 'stop_sequence', 'refusal'}:
                raise BackendError('model_incomplete')
            finished = True
        elif kind == 'error':
            raise BackendError('model_stream_interrupted')
    if not finished:
        raise BackendError('model_stream_interrupted')
    is_oauth = config.provider == 'anthropic' and (config.auth_type == 'oauth' or config.api_key.get_secret_value().startswith('sk-ant-oat'))
    reverse = {value: key for key, value in _CANONICAL.items()} if is_oauth else {}
    calls = [ToolCall(id=text(block.get('id')), name=reverse.get(text(block.get('name')), text(block.get('name'))),
        arguments=text(block['partial_json']) if 'partial_json' in block else json.dumps(block.get('input', {})))
        for block in blocks.values() if block.get('type') == 'tool_use']
    if len(calls) > 16 or any(not call.id for call in calls) or len({call.id for call in calls}) != len(calls) or sum(len(call.arguments) for call in calls) > 64000:
        raise BackendError('invalid_tool_calls')
    signature = [block for block in blocks.values() if block.get('type') in {'thinking', 'redacted_thinking'}]
    yield with_catalog_price(config, Completion(message=Message(role='assistant', content=answer, tool_calls=calls,
        reasoning_signature=reasoning_signature(list(signature))), response_id=response_id,
        input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cached, cache_write_tokens=written))


def google_body(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None, plugins: list[PluginOffer] | None = None) -> Record:
    converted: list[JsonValue] = []
    names: dict[str, str] = {}
    for message in tool_image_messages(messages):
        if message.role == 'tool':
            converted.append({'role': 'user', 'parts': [{'functionResponse': {
                'name': names.get(message.tool_call_id, message.tool_call_id), 'response': {'result': message.content}}}]})
            continue
        parts: list[JsonValue] = [{'text': message.content}] if message.content else []
        parts.extend([{'inlineData': {'mimeType': image.media_type, 'data': image.data_base64}} for image in message.images])
        if message.role == 'assistant':
            saved = replay(message)
            for call in message.tool_calls:
                names[call.id] = call.name
                found = next((part for part in saved if part.get('call_id') == call.id), None)
                part: Record = {'functionCall': {'name': call.name, 'args': RECORD.validate_json(call.arguments), 'id': call.id}}
                if found and isinstance(found.get('thoughtSignature'), str):
                    part['thoughtSignature'] = found['thoughtSignature']
                parts.append(part)
        converted.append({'role': 'model' if message.role == 'assistant' else 'user', 'parts': parts})
    body: Record = {'contents': converted, 'systemInstruction': {'parts': [{'text': text(RECORDS.validate_python(provider_messages([], config.provider, config))[0].get('content'))}]},
        'generationConfig': {'maxOutputTokens': config.max_tokens},
        'tools': [{'functionDeclarations': [{'name': tool['name'], 'description': tool.get('description', ''),
                   'parametersJsonSchema': tool['parameters']} for tool in tools(offers, config, plugins)]}]}
    if not tools(offers, config, plugins):
        body.pop('tools')
    return body


async def google(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None,
                 client: httpx.AsyncClient, plugins: list[PluginOffer] | None = None) -> AsyncIterator[str | Completion]:
    endpoint = config.base_url.rstrip('/') + '/models/' + quote(config.model, safe='') + ':streamGenerateContent?alt=sse'
    headers = dict(config.headers)
    headers['x-goog-api-key'] = config.api_key.get_secret_value()
    answer, response_id, finished = '', '', False
    calls: list[ToolCall] = []
    signature: list[object] = []
    usage: Record = {}
    async for event in events(client, endpoint, headers, google_body(config, messages, offers, plugins)):
        response_id = text(event.get('responseId')) or response_id
        usage = record(event.get('usageMetadata', {})) or usage
        for raw in items(event.get('candidates', [])):
            candidate = record(raw)
            for raw_part in items(record(candidate.get('content', {})).get('parts', [])):
                part = record(raw_part)
                if 'functionCall' in part:
                    call = record(part['functionCall'])
                    cid = text(call.get('id')) or hashlib.sha256(f'{response_id}:{len(calls)}:{call.get("name")}'.encode()).hexdigest()[:32]
                    calls.append(ToolCall(id=cid, name=text(call.get('name')), arguments=json.dumps(call.get('args', {}))))
                    if 'thoughtSignature' in part:
                        signature.append({'call_id': cid, 'thoughtSignature': part['thoughtSignature']})
                elif part.get('thought') is not True and isinstance(part.get('text'), str):
                    value = text(part['text'])
                    answer += value
                    yield value
            if candidate.get('finishReason'):
                if candidate['finishReason'] != 'STOP':
                    raise BackendError('model_incomplete')
                finished = True
        if len(answer) > 64000 or len(calls) > 16:
            raise BackendError('model_output_limit')
    if not finished:
        raise BackendError('model_stream_interrupted')
    yield with_catalog_price(config, Completion(message=Message(role='assistant', content=answer, tool_calls=calls,
        reasoning_signature=reasoning_signature(signature)), response_id=response_id,
        input_tokens=number(usage.get('promptTokenCount')), output_tokens=number(usage.get('candidatesTokenCount')),
        cache_read_tokens=number(usage.get('cachedContentTokenCount'))))


async def stream(config: ProviderConfig, messages: list[Message], offers: list[McpOffer] | None, plugins: list[PluginOffer] | None = None) -> AsyncIterator[str | Completion]:
    async with httpx.AsyncClient(proxy=config.proxy or None, trust_env=False, timeout=60) as client:
        if config.api in {'openai-responses', 'openai-codex-responses'}:
            operation = responses(config, messages, offers, client, plugins)
        elif config.api == 'anthropic-messages':
            operation = anthropic(config, messages, offers, client, plugins)
        elif config.api == 'google-generative-ai':
            operation = google(config, messages, offers, client, plugins)
        else:
            raise BackendError('model_api_unknown')
        async for item in operation:
            yield item
