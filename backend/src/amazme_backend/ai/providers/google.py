"""Google model protocol with caller-supplied prompt and tools."""
import hashlib
import json
from collections.abc import AsyncIterator
from urllib.parse import quote

import httpx
from pydantic import JsonValue

from amazme_backend.ai.pricing import with_catalog_price
from amazme_backend.ai.providers.google_schema import const_as_enum
from amazme_backend.ai.providers.history import reasoning_signature, replay_blocks, tool_image_messages
from amazme_backend.ai.providers.sse import RECORD, Record, events, items, number, record, text
from amazme_backend.ai.providers.tools import tool_records
from amazme_backend.ai.reasoning import google_thinking
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


def google_body(config: ModelSpec, request: ModelRequest) -> Record:
    converted: list[JsonValue] = []
    names: dict[str, str] = {}
    for message in tool_image_messages(request.messages):
        if message.role == 'tool':
            converted.append({'role': 'user', 'parts': [{'functionResponse': {
                'name': names.get(message.tool_call_id, message.tool_call_id), 'response': {'result': message.content}}}]})
            continue
        parts: list[JsonValue] = [{'text': message.content}] if message.content else []
        parts.extend([{'inlineData': {'mimeType': image.media_type, 'data': image.data_base64}} for image in message.images])
        if message.role == 'assistant':
            saved = replay_blocks(message)
            for call in message.tool_calls:
                names[call.id] = request.wire_name(call.name)
                found = next((part for part in saved if part.get('call_id') == call.id), None)
                part: Record = {'functionCall': {'name': request.wire_name(call.name), 'args': RECORD.validate_json(call.arguments), 'id': call.id}}
                if found and isinstance(found.get('thoughtSignature'), str):
                    part['thoughtSignature'] = found['thoughtSignature']
                parts.append(part)
        converted.append({'role': 'model' if message.role == 'assistant' else 'user', 'parts': parts})
    thinking = google_thinking(config)
    body: Record = {'contents': converted, 'systemInstruction': {'parts': [{'text': request.system_prompt}]},
        'generationConfig': {'maxOutputTokens': config.max_tokens, **({'thinkingConfig':thinking} if thinking else {})},
        'tools': [{'functionDeclarations': [{'name': tool['name'], 'description': tool.get('description', ''),
                   'parametersJsonSchema': const_as_enum(tool['parameters'])} for tool in tool_records(request)]}]}
    if not request.tools:
        body.pop('tools')
    return body


async def google(config: ModelSpec, request: ModelRequest, auth: Auth, transport: RequestTransport,
                 client: httpx.AsyncClient) -> AsyncIterator[str | Completion]:
    endpoint = config.base_url.rstrip('/') + '/models/' + quote(config.model, safe='') + ':streamGenerateContent?alt=sse'
    headers = {**transport.headers, **auth.headers}
    headers['x-goog-api-key'] = auth.api_key.get_secret_value()
    answer, response_id, finished = '', '', False
    calls: list[ModelToolCall] = []
    signature: list[object] = []
    usage: Record = {}
    async for event in events(client, endpoint, headers, google_body(config, request)):
        response_id = text(event.get('responseId')) or response_id
        usage = record(event.get('usageMetadata', {})) or usage
        for raw in items(event.get('candidates', [])):
            candidate = record(raw)
            for raw_part in items(record(candidate.get('content', {})).get('parts', [])):
                part = record(raw_part)
                if 'functionCall' in part:
                    call = record(part['functionCall'])
                    cid = text(call.get('id')) or hashlib.sha256(f'{response_id}:{len(calls)}:{call.get("name")}'.encode()).hexdigest()[:32]
                    calls.append(ModelToolCall(id=cid, name=request.internal_name(text(call.get('name'))), arguments=json.dumps(call.get('args', {}))))
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
    yield with_catalog_price(config, Completion(message=ModelMessage(role='assistant', content=answer, tool_calls=calls,
        reasoning_signature=reasoning_signature(signature)), response_id=response_id,
        input_tokens=number(usage.get('promptTokenCount')), output_tokens=number(usage.get('candidatesTokenCount')),
        cache_read_tokens=number(usage.get('cachedContentTokenCount'))))
