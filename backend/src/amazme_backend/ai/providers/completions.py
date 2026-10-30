"""OpenAI Chat Completions request conversion and stream completion rules."""
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import cast

import httpx2
from openai import APIStatusError, AsyncOpenAI, omit
from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam

from amazme_backend.ai.catalog import INDEX
from amazme_backend.ai.pricing import with_catalog_price
from amazme_backend.ai.providers.headers import base_headers
from amazme_backend.ai.providers.history import (
    reasoning_signature,
    replay_reasoning_details,
    tool_image_messages,
)
from amazme_backend.ai.reasoning import completions_thinking
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


def _model_extra(value: object) -> dict[str, object]:
    extra = getattr(value, "model_extra", None)
    if not isinstance(extra, dict):
        return {}
    return cast(dict[str, object], extra)


def _present_count(value: object) -> int | None:
    """None means the provider omitted the count. Zero is a real count."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise BackendError("invalid_usage")
    return value


def read_stream_usage(usage: object) -> tuple[int, int, int, int]:
    """Split a provider usage object into fresh input, output, cache read, and cache write.

    Cached tokens are not also billed as fresh input. An explicit
    ``prompt_tokens_details.cached_tokens``, including zero, wins over DeepSeek's
    ``prompt_cache_hit_tokens`` and a top-level ``cached_tokens``.
    """
    prompt = _present_count(getattr(usage, "prompt_tokens", None)) or 0
    output = _present_count(getattr(usage, "completion_tokens", None)) or 0
    details = getattr(usage, "prompt_tokens_details", None)
    cached: int | None = None
    written = 0
    if details is not None:
        cached = _present_count(getattr(details, "cached_tokens", None))
        written_count = _present_count(getattr(details, "cache_write_tokens", None))
        written = 0 if written_count is None else written_count
    if cached is None:
        extra = _model_extra(usage)
        for key in ("prompt_cache_hit_tokens", "cached_tokens"):
            if key not in extra:
                continue
            cached = _present_count(extra[key])
            if cached is not None:
                break
    if cached is None:
        cached = 0
    if min(prompt, output, cached, written) < 0 or cached + written > prompt:
        raise BackendError("invalid_usage")
    return prompt - cached - written, output, cached, written


def read_reasoning_details(delta: object) -> list[object]:
    """Return provider reasoning_details unchanged. Encrypted entries are not inspected."""
    extra = _model_extra(delta)
    details = extra.get("reasoning_details")
    if not isinstance(details, list):
        return []
    return cast(list[object], details)


@dataclass
class PendingCall:
    id: str = ""
    name: str = ""
    arguments: str = ""


def provider_messages(config: ModelSpec, request: ModelRequest) -> list[ChatCompletionMessageParam]:
    result: list[ChatCompletionMessageParam] = [{"role": "system", "content": request.system_prompt}]
    for message in tool_image_messages(request.messages):
        if message.role == "user":
            if message.images:
                parts: list[dict[str, object]] = []
                if message.content:
                    parts.append({"type": "text", "text": message.content})
                for image in message.images:
                    parts.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{image.media_type};base64,{image.data_base64}"},
                    })
                result.append({"role": "user", "content": parts})  # type: ignore[arg-type]
            else:
                result.append({"role": "user", "content": message.content})
        elif message.role == "tool":
            result.append({"role": "tool", "content": message.content, "tool_call_id": message.tool_call_id})
        else:
            assistant: dict[str, object] = {"role": "assistant", "content": message.content}
            if message.tool_calls:
                assistant["tool_calls"] = [
                    {"id": call.id, "type": "function", "function": {"name": request.wire_name(call.name), "arguments": call.arguments}}
                    for call in message.tool_calls
                ]
            if message.reasoning_signature:
                assistant["reasoning_details"] = replay_reasoning_details(message.reasoning_signature)
            if config.provider == "deepseek":
                assistant.setdefault("reasoning_content", "")
            result.append(assistant)  # type: ignore[arg-type]
    return result


def tool_parameters(request: ModelRequest) -> list[ChatCompletionToolParam]:
    return [cast(ChatCompletionToolParam, {"type": "function", "function": {
        "name": request.wire_name(tool.name), "description": tool.description, "parameters": tool.parameters,
    }}) for tool in request.tools]


async def stream(config: ModelSpec, request: ModelRequest, auth: Auth,
                 transport: RequestTransport) -> AsyncGenerator[ProviderEvent, None]:
    calls: dict[int, PendingCall] = {}
    text = ""
    response_id = ""
    input_tokens = output_tokens = cache_read_tokens = cache_write_tokens = 0
    signature: list[object] = []
    finished = False
    request_headers = base_headers(config, request, auth, transport)
    http = httpx2.AsyncClient(proxy=transport.proxy or None, trust_env=False, timeout=transport.timeout_seconds)
    try:
        async with AsyncOpenAI(api_key=auth.api_key.get_secret_value(), base_url=config.base_url,
                               max_retries=0, timeout=transport.timeout_seconds, default_headers=request_headers,
                               http_client=http) as client:
            metadata = INDEX.get((config.provider, config.model))
            completion_limit = metadata is not None and metadata.compat.get("maxTokensField") == "max_completion_tokens"
            response = await client.chat.completions.create(
                model=config.model, messages=provider_messages(config, request), tools=tool_parameters(request) or omit,
                max_tokens=omit if completion_limit else config.max_tokens,
                max_completion_tokens=config.max_tokens if completion_limit else omit,
                stream=True, stream_options={"include_usage": True},
                extra_body=completions_thinking(config) or None)
            async with response:
                async for chunk in response:
                    response_id = chunk.id
                    if chunk.usage:
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens = read_stream_usage(chunk.usage)
                    for choice in chunk.choices:
                        details = read_reasoning_details(choice.delta)
                        signature.extend(details)
                        if details or _model_extra(choice.delta).get("reasoning_content"):
                            yield PROGRESS
                        if choice.delta.content:
                            text += choice.delta.content
                            if len(text) > 64000:
                                raise BackendError("model_output_limit")
                            yield choice.delta.content
                        for delta in choice.delta.tool_calls or []:
                            pending_call = calls.setdefault(delta.index, PendingCall())
                            if delta.id:
                                pending_call.id += delta.id
                            if delta.function:
                                pending_call.name += delta.function.name or ""
                                pending_call.arguments += delta.function.arguments or ""
                            if len(calls) > 16 or sum(len(item.arguments) + len(item.id) + len(item.name) for item in calls.values()) > 64000:
                                raise BackendError("tool_argument_limit")
                            if delta.id or (delta.function and (delta.function.name or delta.function.arguments)):
                                yield PROGRESS
                        if choice.finish_reason:
                            if choice.finish_reason not in {"stop", "tool_calls"}:
                                raise BackendError("model_incomplete", choice.finish_reason)
                            finished = True
        if not finished:
            raise BackendError("model_stream_interrupted")
        parsed: list[ModelToolCall] = []
        for index in sorted(calls):
            pending_call = calls[index]
            parsed.append(ModelToolCall.model_validate({"id": pending_call.id, "name": request.internal_name(pending_call.name), "arguments": pending_call.arguments}))
        if any(not call.id for call in parsed) or len({call.id for call in parsed}) != len(parsed):
            raise BackendError("invalid_tool_calls")
        yield with_catalog_price(config, Completion(
            message=ModelMessage(role="assistant", content=text, tool_calls=parsed, reasoning_signature=reasoning_signature(signature)),
            response_id=response_id, input_tokens=input_tokens, output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens, cache_write_tokens=cache_write_tokens))
    except APIStatusError as error:
        if error.status_code == 413:
            raise BackendError("model_http_413", status=503) from error
        raise
    finally:
        await http.aclose()
