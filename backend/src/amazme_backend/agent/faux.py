"""The product's deterministic local provider and command-shaped validation prompts."""
import asyncio
import hashlib
import json
from collections.abc import AsyncIterator

from pydantic import JsonValue, TypeAdapter, ValidationError

from amazme_backend.ai.types import Completion
from amazme_backend.contracts.execution import Shell, WriteFile
from amazme_backend.contracts.models import Message, ToolCall
from amazme_backend.contracts.sessions import DelegateTasks
from amazme_backend.contracts.web import WebFetch, WebSearch
from amazme_backend.shared.errors import BackendError

_FREE_PRICE = {"price_input_micro_per_million": 0, "price_output_micro_per_million": 0,
               "price_cache_read_micro_per_million": 0, "price_cache_write_micro_per_million": 0}


async def stream(messages: list[Message]) -> AsyncIterator[str | Completion[Message]]:
    if not messages or not any(message.role == "user" for message in messages):
        raise BackendError("missing_user_context")
    user_index = max(i for i, message in enumerate(messages) if message.role == "user")
    prompt = messages[user_index].content
    results = [message for message in messages[user_index + 1:] if message.role == "tool"]
    call: ToolCall | None = None
    identity = "faux-" + hashlib.sha256("".join(m.model_dump_json() for m in messages).encode()).hexdigest()[:24]
    if prompt.startswith("/shell ") and not results:
        call = ToolCall(id=identity, name="shell",
                        arguments=Shell(command=prompt[7:], timeout_seconds=120).model_dump_json())
    elif prompt.startswith("/write ") and not results:
        call = ToolCall(id=identity, name="write_file",
                        arguments=WriteFile.model_validate_json(prompt[7:]).model_dump_json())
    elif prompt.startswith("/delegate ") and not results:
        tasks = DelegateTasks(tasks=TypeAdapter(list[str]).validate_json(prompt[10:]))
        call = ToolCall(id=identity, name="delegate_task", arguments=tasks.model_dump_json())
    elif prompt.startswith("/web ") and not results:
        call = ToolCall(id=identity, name="web_search",
                        arguments=WebSearch(query=prompt[5:].strip()).model_dump_json())
    elif prompt.startswith("/fetch ") and not results:
        call = ToolCall(id=identity, name="web_fetch",
                        arguments=WebFetch(url=prompt[7:].strip()).model_dump_json())
    elif prompt.startswith("/mcp ") and not results:
        try:
            body = TypeAdapter(dict[str, JsonValue]).validate_json(prompt[5:])
        except (json.JSONDecodeError, ValidationError):
            raise BackendError("invalid_tool_arguments") from None
        alias, arguments = body.get("alias"), body.get("arguments")
        if not isinstance(alias, str) or not isinstance(arguments, dict):
            raise BackendError("invalid_tool_arguments")
        call = ToolCall(id=identity, name=alias, arguments=json.dumps(arguments, ensure_ascii=False))
    elif prompt.startswith("/sequence "):
        commands = TypeAdapter(list[str]).validate_json(prompt[10:])
        if not commands or len(commands) > 24:
            raise BackendError("invalid_faux_sequence")
        if len(results) < len(commands):
            call = ToolCall(id=identity, name="shell",
                            arguments=Shell(command=commands[len(results)], timeout_seconds=120).model_dump_json())
    if call:
        yield Completion[Message](
            message=Message(role="assistant", content="", tool_calls=[call]),
            response_id=identity, input_tokens=len(prompt), output_tokens=1, **_FREE_PRICE)
        return
    text = results[-1].content if results else "已收到：" + prompt
    for offset in range(0, len(text), 64):
        await asyncio.sleep(0.01)
        yield text[offset:offset + 64]
    yield Completion[Message](
        message=Message(role="assistant", content=text), response_id=identity,
        input_tokens=sum(len(m.content) for m in messages), output_tokens=len(text), **_FREE_PRICE)
    return
