"""Responses model protocol with caller-supplied prompt and tools."""
import base64
from collections.abc import AsyncIterator

import httpx
from pydantic import JsonValue

from amazme_backend.ai.pricing import with_catalog_price
from amazme_backend.ai.providers.headers import base_headers
from amazme_backend.ai.providers.history import reasoning_signature, replay_blocks, tool_image_messages
from amazme_backend.ai.providers.sse import RECORD, Record, events, items, number, record, text
from amazme_backend.ai.providers.tools import tool_records
from amazme_backend.ai.reasoning import responses_thinking
from amazme_backend.ai.types import (
    Auth,
    Completion,
    ModelMessage,
    ModelRequest,
    ModelSpec,
    ModelToolCall,
    RequestTransport,
)
from amazme_backend.shared.errors import BackendError


def responses_body(config: ModelSpec, request: ModelRequest) -> Record:
    converted: list[JsonValue] = []
    for message in tool_image_messages(request.messages):
        if message.role == 'user':
            content: list[JsonValue] = [{'type': 'input_text', 'text': message.content}]
            content.extend([{'type': 'input_image', 'image_url': f'data:{image.media_type};base64,{image.data_base64}'}
                        for image in message.images])
            converted.append({'role': 'user', 'content': content})
        elif message.role == 'tool':
            converted.append({'type': 'function_call_output', 'call_id': message.tool_call_id, 'output': message.content})
        else:
            for item in replay_blocks(message):
                if item.get('type') == 'reasoning':
                    converted.append(item)
            if message.content:
                converted.append({'role': 'assistant', 'content': [{'type': 'output_text', 'text': message.content}]})
            converted.extend([{'type': 'function_call', 'call_id': call.id, 'name': request.wire_name(call.name), 'arguments': call.arguments}
                          for call in message.tool_calls])
    body: Record = {'model': config.model, 'stream': True, 'store': False, 'input': converted,
        'instructions': request.system_prompt,
        'tools': [{'type': 'function', **tool} for tool in tool_records(request)],
        'include': ['reasoning.encrypted_content'], 'tool_choice': 'auto', 'parallel_tool_calls': True}
    if not body['tools']:
        for key in ('tools', 'tool_choice', 'parallel_tool_calls'):
            body.pop(key)
    body.update(responses_thinking(config))
    if config.api == 'openai-codex-responses':
        body['text'] = {'verbosity': 'low'}
    else:
        body['max_output_tokens'] = config.max_tokens
    return body


async def responses(config: ModelSpec, request: ModelRequest, auth: Auth, transport: RequestTransport,
                    client: httpx.AsyncClient) -> AsyncIterator[str | Completion]:
    headers = base_headers(config, request, auth, transport)
    endpoint = config.base_url.rstrip('/') + '/responses'
    if config.api == 'openai-codex-responses':
        endpoint = config.base_url.rstrip('/') + '/codex/responses'
        headers.update({'originator': 'pi', 'OpenAI-Beta': 'responses=experimental',
                        'accept': 'text/event-stream', 'content-type': 'application/json'})
        try:
            encoded = auth.api_key.get_secret_value().split('.')[1]
            claims = RECORD.validate_json(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            headers['chatgpt-account-id'] = text(record(claims['https://api.openai.com/auth'])['chatgpt_account_id'])
        except (ValueError, IndexError, KeyError) as exc:
            raise BackendError('oauth_account_id_missing') from exc
    answer, finished = '', False
    async for event in events(client, endpoint, headers, responses_body(config, request)):
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
            calls = [ModelToolCall(id=text(item.get('call_id')), name=request.internal_name(text(item.get('name'))),
                              arguments=text(item.get('arguments'))) for item in output if item.get('type') == 'function_call']
            if len(calls) > 16 or len({call.id for call in calls}) != len(calls) or any(not call.id for call in calls) or sum(len(call.arguments) for call in calls) > 64000:
                raise BackendError('invalid_tool_calls')
            signature = [item for item in output if item.get('type') == 'reasoning']
            usage = record(response.get('usage', {}))
            cached = record(usage.get('input_tokens_details', {}))
            finished = True
            yield with_catalog_price(config, Completion(message=ModelMessage(role='assistant', content=answer,
                tool_calls=calls, reasoning_signature=reasoning_signature(list(signature))),
                response_id=text(response.get('id')), input_tokens=number(usage.get('input_tokens')),
                output_tokens=number(usage.get('output_tokens')), cache_read_tokens=number(cached.get('cached_tokens'))))
            return
        elif kind in {'response.failed', 'response.incomplete', 'error'}:
            raise BackendError('model_incomplete')
    if not finished:
        raise BackendError('model_stream_interrupted')
