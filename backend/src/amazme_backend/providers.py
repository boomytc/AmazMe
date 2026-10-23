import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from openai import AsyncOpenAI
from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionToolParam,
)

from .contracts import BackendError, Message, Model, ProviderConfig, ReadFile, Shell, ToolCall, WriteFile


class Completion(Model):
    message: Message
    response_id: str
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class PendingCall:
    id: str = ""
    name: str = ""
    arguments: str = ""


def tool_definitions() -> list[ChatCompletionToolParam]:
    return [
        {"type": "function", "function": {"name": "shell", "description": "Execute a Linux shell command in the granted workspace. Network disabled. Commands may have side effects; never retry an unknown result.", "parameters": Shell.model_json_schema()}},
        {"type": "function", "function": {"name": "read_file", "description": "Read a relative UTF-8 workspace file.", "parameters": ReadFile.model_json_schema()}},
        {"type": "function", "function": {"name": "write_file", "description": "Write a relative UTF-8 workspace file.", "parameters": WriteFile.model_json_schema()}},
    ]


def provider_messages(messages: list[Message]) -> list[ChatCompletionMessageParam]:
    result: list[ChatCompletionMessageParam] = [{"role": "system", "content": (
        "You are AmazMe. Use the provided tools when asked to inspect or modify the workspace. "
        "Commands execute in a Linux container at /workspace, not native macOS. "
        "Only the granted workspace persists. Network is disabled. Report actual tool results. "
        "Never claim a command ran unless a tool result confirms it. Keep answers concise."
    )}]
    for message in messages:
        if message.role == "user":
            result.append({"role": "user", "content": message.content})
        elif message.role == "tool":
            result.append({"role": "tool", "content": message.content, "tool_call_id": message.tool_call_id})
        else:
            assistant: ChatCompletionAssistantMessageParam = {"role": "assistant", "content": message.content}
            if message.tool_calls:
                assistant["tool_calls"] = [
                    {"id": call.id, "type": "function", "function": {"name": call.name, "arguments": call.arguments}}
                    for call in message.tool_calls
                ]
            result.append(assistant)
    return result


async def stream(config: ProviderConfig, messages: list[Message]) -> AsyncIterator[str | Completion]:
    if config.provider == "faux":
        last = messages[-1]
        if last.role == "user" and last.content.startswith("/shell "):
            yield Completion(message=Message(role="assistant", content="", tool_calls=[
                ToolCall(id="faux-" + __import__("secrets").token_hex(8), name="shell",
                         arguments=Shell(command=last.content[7:], timeout_seconds=120).model_dump_json())
            ]), response_id="faux")
            return
        text = last.content if last.role == "tool" else "已收到：" + last.content
        for chunk in [text[i:i+16] for i in range(0, len(text), 16)]:
            await asyncio.sleep(0.01)
            yield chunk
        yield Completion(message=Message(role="assistant", content=text), response_id="faux")
        return
    calls: dict[int, PendingCall] = {}
    text = ""
    response_id = ""
    input_tokens = output_tokens = 0
    finished = False
    async with AsyncOpenAI(api_key=config.api_key.get_secret_value(), base_url=config.base_url,
                           max_retries=0, timeout=60) as client:
        response = await client.chat.completions.create(
            model=config.model, messages=provider_messages(messages), tools=tool_definitions(),
            max_tokens=config.max_tokens, stream=True, stream_options={"include_usage": True},
            extra_body={"thinking": {"type": "disabled"}},
        )
        async with response:
            async for chunk in response:
                response_id = chunk.id
                if chunk.usage:
                    input_tokens, output_tokens = chunk.usage.prompt_tokens, chunk.usage.completion_tokens
                for choice in chunk.choices:
                    if choice.delta.content:
                        text += choice.delta.content
                        if len(text) > 64000:
                            raise BackendError("model_output_limit")
                        yield choice.delta.content
                    for delta in choice.delta.tool_calls or []:
                        call = calls.setdefault(delta.index, PendingCall())
                        if delta.id:
                            call.id += delta.id
                        if delta.function:
                            call.name += delta.function.name or ""
                            call.arguments += delta.function.arguments or ""
                        if len(calls) > 16 or sum(len(c.arguments) + len(c.id) for c in calls.values()) > 64000:
                            raise BackendError("tool_argument_limit")
                    if choice.finish_reason:
                        if choice.finish_reason not in {"stop", "tool_calls"}:
                            raise BackendError("model_incomplete", choice.finish_reason)
                        finished = True
    if not finished:
        raise BackendError("model_stream_interrupted")
    parsed: list[ToolCall] = []
    for index in sorted(calls):
        call = calls[index]
        parsed.append(ToolCall.model_validate({"id": call.id, "name": call.name, "arguments": call.arguments}))
    yield Completion(message=Message(role="assistant", content=text, tool_calls=parsed),
                     response_id=response_id, input_tokens=input_tokens, output_tokens=output_tokens)
