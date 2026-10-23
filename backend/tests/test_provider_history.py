import json

import pytest

from amazme_backend.contracts import BackendError, Message, ProviderConfig, ToolCall
from amazme_backend.providers import Completion, provider_messages, stream, tool_definitions


def test_plain_assistant_history_omits_empty_tool_calls() -> None:
    history = provider_messages([
        Message(role="user", content="first"),
        Message(role="assistant", content="", tool_calls=[ToolCall(id="c", name="shell", arguments='{"command":"pwd"}')]),
        Message(role="tool", content="/workspace", tool_call_id="c"),
        Message(role="assistant", content="done"),
        Message(role="user", content="continue"),
    ])
    assert "tool_calls" not in history[-2]
    assistant, tool = history[2], history[3]
    assert assistant["role"] == "assistant" and "tool_calls" in assistant and assistant["tool_calls"]
    assert tool["role"] == "tool"
    assert list(assistant["tool_calls"])[0]["id"] == tool["tool_call_id"]


async def completion(messages: list[Message]) -> Completion:
    results = [item async for item in stream(ProviderConfig(provider="faux"), messages) if isinstance(item, Completion)]
    assert len(results) == 1
    return results[0]


async def test_faux_sequence_has_stable_context_bound_ids_and_usage() -> None:
    messages = [Message(role="user", content='/sequence ["echo one", "echo two"]')]
    first = await completion(messages)
    assert first == await completion(messages)
    assert first.input_tokens > 0 and first.output_tokens > 0
    call = first.message.tool_calls[0]
    assert 'echo one' in call.arguments
    messages.extend([first.message, Message(role="tool", content="one", tool_call_id=call.id)])
    second = await completion(messages)
    assert second.response_id != first.response_id and 'echo two' in second.message.tool_calls[0].arguments
    messages.extend([second.message, Message(role="tool", content="two", tool_call_id=second.message.tool_calls[0].id)])
    final = await completion(messages)
    assert not final.message.tool_calls and final.message.content == "two"


async def test_faux_delegate_and_tool_schema_agree() -> None:
    result = await completion([Message(role="user", content='/delegate ["first", "second"]')])
    call = result.message.tool_calls[0]
    assert call.name == "delegate_task" and json.loads(call.arguments) == {"tasks": ["first", "second"]}
    assert any(tool["type"] == "function" and tool["function"]["name"] == "delegate_task"
               for tool in tool_definitions())


async def test_faux_rejects_missing_user_context() -> None:
    with pytest.raises(BackendError, match="missing_user_context"):
        await completion([])


@pytest.mark.parametrize("commands", [[], ["echo"] * 25])
async def test_faux_rejects_out_of_bound_sequences(commands: list[str]) -> None:
    with pytest.raises(BackendError, match="invalid_faux_sequence"):
        await completion([Message(role="user", content="/sequence " + json.dumps(commands))])
