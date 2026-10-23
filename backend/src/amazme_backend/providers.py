import asyncio
import hashlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from urllib.parse import urlsplit

from openai import AsyncOpenAI
from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionToolParam,
)
from pydantic import TypeAdapter

from .contracts import (
    BackendError,
    CatalogModel,
    DelegateTasks,
    Message,
    Model,
    ModelSettings,
    ProviderConfig,
    ReadFile,
    Shell,
    ToolCall,
    UpdateModelSettings,
    WriteFile,
)

CATALOG = (
    CatalogModel(provider="faux", model="faux", label="本地确定性", endpoint_editable=False),
    CatalogModel(provider="deepseek", model="deepseek-flash", label="DeepSeek Flash", endpoint_editable=True),
)


def public_settings(config: ProviderConfig) -> ModelSettings:
    return ModelSettings(provider=config.provider, model=config.model, base_url=config.base_url,
                         max_tokens=config.max_tokens, key_configured=bool(config.api_key.get_secret_value()))


def choose_model(current: ProviderConfig, requested: UpdateModelSettings) -> ProviderConfig:
    """Return the next provider config. The stored API key is kept and never taken from the request."""
    if requested.provider == "faux":
        if requested.model != "faux":
            raise BackendError("model_not_available")
        return current.model_copy(update={
            "provider": "faux", "model": "faux", "base_url": "", "max_tokens": requested.max_tokens,
        })
    if not current.api_key.get_secret_value():
        raise BackendError("provider_not_configured")
    parts = urlsplit(requested.base_url.strip())
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise BackendError("invalid_model_endpoint")
    return current.model_copy(update={
        "provider": "deepseek", "model": requested.model, "base_url": parts.geturl(),
        "max_tokens": requested.max_tokens,
    })


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
        {"type": "function", "function": {"name": "delegate_task", "description": "Delegate up to eight required independent tasks. Wait for their results before completing.", "parameters": DelegateTasks.model_json_schema()}},
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


async def summarize(config: ProviderConfig, messages: list[Message]) -> str:
    """Ask the configured provider for a context summary. Callers commit it only if the basis still matches."""
    if not messages or not any(message.content for message in messages):
        raise BackendError("compaction_empty")
    source = "\n".join(f"{message.role}: {message.content}" for message in messages if message.content)
    prompt = Message(role="user", content="压缩对话并保留决定与未完成事项：\n" + source[:12000])
    summary = ""
    async for item in stream(config, [prompt]):
        if isinstance(item, str):
            summary += item
        elif item.message.content:
            summary = item.message.content
    if not summary.strip():
        raise BackendError("compaction_empty")
    return summary.strip()[:16000]


async def stream(config: ProviderConfig, messages: list[Message]) -> AsyncIterator[str | Completion]:
    if not messages or not any(message.role == "user" for message in messages):
        raise BackendError("missing_user_context")
    if config.provider == "faux":
        user_index = max(i for i, message in enumerate(messages) if message.role == "user")
        prompt = messages[user_index].content
        results = [message for message in messages[user_index + 1:] if message.role == "tool"]
        call: ToolCall | None = None
        identity = "faux-" + hashlib.sha256("".join(m.model_dump_json() for m in messages).encode()).hexdigest()[:24]
        if prompt.startswith("/shell ") and not results:
            call = ToolCall(id=identity, name="shell",
                            arguments=Shell(command=prompt[7:], timeout_seconds=120).model_dump_json())
        elif prompt.startswith("/delegate ") and not results:
            tasks = DelegateTasks(tasks=TypeAdapter(list[str]).validate_json(prompt[10:]))
            call = ToolCall(id=identity, name="delegate_task", arguments=tasks.model_dump_json())
        elif prompt.startswith("/sequence "):
            commands = TypeAdapter(list[str]).validate_json(prompt[10:])
            if not commands or len(commands) > 24:
                raise BackendError("invalid_faux_sequence")
            if len(results) < len(commands):
                call = ToolCall(id=identity, name="shell",
                                arguments=Shell(command=commands[len(results)], timeout_seconds=120).model_dump_json())
        if call:
            yield Completion(message=Message(role="assistant", content="", tool_calls=[call]),
                             response_id=identity, input_tokens=len(prompt), output_tokens=1)
            return
        text = results[-1].content if results else "已收到：" + prompt
        for offset in range(0, len(text), 64):
            await asyncio.sleep(0.01)
            yield text[offset:offset + 64]
        yield Completion(message=Message(role="assistant", content=text), response_id=identity,
                         input_tokens=sum(len(m.content) for m in messages), output_tokens=len(text))
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
                        pending_call = calls.setdefault(delta.index, PendingCall())
                        if delta.id:
                            pending_call.id += delta.id
                        if delta.function:
                            pending_call.name += delta.function.name or ""
                            pending_call.arguments += delta.function.arguments or ""
                        if len(calls) > 16 or sum(len(c.arguments) + len(c.id) + len(c.name) for c in calls.values()) > 64000:
                            raise BackendError("tool_argument_limit")
                    if choice.finish_reason:
                        if choice.finish_reason not in {"stop", "tool_calls"}:
                            raise BackendError("model_incomplete", choice.finish_reason)
                        finished = True
    if not finished:
        raise BackendError("model_stream_interrupted")
    parsed: list[ToolCall] = []
    for index in sorted(calls):
        pending_call = calls[index]
        parsed.append(ToolCall.model_validate({"id": pending_call.id, "name": pending_call.name, "arguments": pending_call.arguments}))
    if any(not call.id for call in parsed) or len({call.id for call in parsed}) != len(parsed):
        raise BackendError("invalid_tool_calls")
    yield Completion(message=Message(role="assistant", content=text, tool_calls=parsed),
                     response_id=response_id, input_tokens=input_tokens, output_tokens=output_tokens)
