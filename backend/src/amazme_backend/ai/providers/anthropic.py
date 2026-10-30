"""Anthropic model protocol with caller-supplied prompt and tools."""
import json
from collections.abc import AsyncGenerator
from contextlib import aclosing

import httpx
from pydantic import JsonValue

from amazme_backend.ai.pricing import with_catalog_price
from amazme_backend.ai.providers.headers import base_headers
from amazme_backend.ai.providers.history import reasoning_signature, replay_blocks, tool_image_messages
from amazme_backend.ai.providers.sse import RECORD, Record, events, number, record, text
from amazme_backend.ai.providers.tools import tool_records
from amazme_backend.ai.reasoning import anthropic_thinking
from amazme_backend.ai.types import (
    PROGRESS,
    Auth,
    Completion,
    ModelMessage,
    ModelRequest,
    ModelSpec,
    ModelToolCall,
    ProviderEvent,
    RequestTransport,
)
from amazme_backend.shared.errors import BackendError


def anthropic_body(config: ModelSpec, request: ModelRequest, auth: Auth, transport: RequestTransport) -> tuple[Record, dict[str, str]]:
    oauth = config.provider == 'anthropic' and (auth.auth_type == 'oauth' or auth.api_key.get_secret_value().startswith('sk-ant-oat'))
    converted: list[JsonValue] = []
    for message in tool_image_messages(request.messages):
        if message.role == 'tool':
            converted.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': message.tool_call_id,
                                                         'content': message.content}]})
        elif message.role == 'user':
            content: list[JsonValue] = [{'type': 'text', 'text': message.content}]
            content.extend([{'type': 'image', 'source': {'type': 'base64', 'media_type': image.media_type, 'data': image.data_base64}}
                        for image in message.images])
            converted.append({'role': 'user', 'content': content})
        else:
            parts: list[JsonValue] = [item for item in replay_blocks(message) if item.get('type') in {'thinking', 'redacted_thinking'}]
            if message.content:
                parts.append({'type': 'text', 'text': message.content})
            parts.extend([{'type': 'tool_use', 'id': call.id, 'name': request.wire_name(call.name),
                       'input': RECORD.validate_json(call.arguments)} for call in message.tool_calls])
            converted.append({'role': 'assistant', 'content': parts})
    system = request.system_prompt
    body: Record = {'model': config.model, 'max_tokens': config.max_tokens, 'stream': True,
        'system': ([{'type': 'text', 'text': "You are Claude Code, Anthropic's official CLI for Claude."},
                    {'type': 'text', 'text': system}] if oauth else system),
        'messages': converted, 'tools': [{'name': tool['name'],
            'description': tool.get('description', ''), 'input_schema': tool['parameters']} for tool in tool_records(request)]}
    if not body['tools']:
        body.pop('tools')
    body.update(anthropic_thinking(config))
    headers = base_headers(config, request, auth, transport)
    headers['anthropic-version'] = '2023-06-01'
    if oauth:
        headers.update({'user-agent': 'claude-cli/2.1.280', 'x-app': 'cli',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'anthropic-dangerous-direct-browser-access': 'true'})
    elif config.provider != 'github-copilot':
        headers.pop('Authorization', None)
        headers['x-api-key'] = auth.api_key.get_secret_value()
    return body, headers


async def anthropic(config: ModelSpec, request: ModelRequest, auth: Auth, transport: RequestTransport,
                    client: httpx.AsyncClient) -> AsyncGenerator[ProviderEvent, None]:
    body, headers = anthropic_body(config, request, auth, transport)
    base = config.base_url.rstrip('/')
    endpoint = base + ('/messages' if base.endswith('/v1') else '/v1/messages')
    blocks: dict[int, Record] = {}
    input_tokens = output_tokens = cached = written = 0
    response_id, answer, stop = '', '', ''
    finished = False
    async with aclosing(events(client, endpoint, headers, body)) as incoming:
        async for event in incoming:
            kind = event.get('type')
            if kind == 'message_start':
                message = record(event['message'])
                response_id = text(message.get('id'))
                usage = record(message.get('usage', {}))
                input_tokens, cached, written = (number(usage.get(field)) for field in
                                                ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
            elif kind == 'content_block_start':
                block = record(event['content_block'])
                blocks[number(event.get('index'))] = block
                if block.get('type') == 'tool_use' or block.get('thinking') or block.get('data'):
                    yield PROGRESS
            elif kind == 'content_block_delta':
                block = blocks[number(event.get('index'))]
                delta = record(event['delta'])
                if delta.get('type') == 'text_delta':
                    value = text(delta.get('text'))
                    answer += value
                    if value:
                        yield value
                elif delta.get('type') == 'input_json_delta':
                    block['partial_json'] = text(block.get('partial_json')) + text(delta.get('partial_json'))
                elif delta.get('type') == 'thinking_delta':
                    block['thinking'] = text(block.get('thinking')) + text(delta.get('thinking'))
                elif delta.get('type') == 'signature_delta':
                    block['signature'] = text(block.get('signature')) + text(delta.get('signature'))
                if len(answer) > 64000 or len(json.dumps(blocks)) > 131072:
                    raise BackendError('model_output_limit')
                if any(text(delta.get(field)) for field in ('partial_json', 'thinking', 'signature')):
                    yield PROGRESS
            elif kind == 'message_delta':
                stop = text(record(event['delta']).get('stop_reason'))
                usage = record(event.get('usage', {}))
                output_tokens = number(usage.get('output_tokens'))
            elif kind == 'message_stop':
                if stop not in {'end_turn', 'tool_use', 'stop_sequence', 'refusal'}:
                    raise BackendError('model_incomplete')
                finished = True
                break
            elif kind == 'error':
                raise BackendError('model_stream_interrupted')
    if not finished:
        raise BackendError('model_stream_interrupted')
    calls = [ModelToolCall(id=text(block.get('id')), name=request.internal_name(text(block.get('name'))),
        arguments=text(block['partial_json']) if 'partial_json' in block else json.dumps(block.get('input', {})))
        for block in blocks.values() if block.get('type') == 'tool_use']
    if len(calls) > 16 or any(not call.id for call in calls) or len({call.id for call in calls}) != len(calls) or sum(len(call.arguments) for call in calls) > 64000:
        raise BackendError('invalid_tool_calls')
    signature = [block for block in blocks.values() if block.get('type') in {'thinking', 'redacted_thinking'}]
    yield with_catalog_price(config, Completion(message=ModelMessage(role='assistant', content=answer, tool_calls=calls,
        reasoning_signature=reasoning_signature(list(signature))), response_id=response_id,
        input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cached, cache_write_tokens=written))
