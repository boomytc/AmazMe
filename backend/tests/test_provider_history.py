import json

import pytest

from amazme_backend.agent.model import ProductCompletion as Completion
from amazme_backend.agent.model import model_request, stream, summarize
from amazme_backend.agent.tool_catalog import build_tools
from amazme_backend.ai.providers.completions import provider_messages
from amazme_backend.ai.types import Auth, ModelMessage, ModelRequest, ModelSpec, ModelToolCall
from amazme_backend.contracts import BackendError, Message, ProviderConfig


def test_plain_assistant_history_omits_empty_tool_calls() -> None:
    history = provider_messages(ModelSpec(provider='example', model='test', base_url='https://example.invalid/v1'), ModelRequest(messages=[
        ModelMessage(role="user", content="first"),
        ModelMessage(role="assistant", content="", tool_calls=[ModelToolCall(id="c", name="shell", arguments='{"command":"pwd"}')]),
        ModelMessage(role="tool", content="/workspace", tool_call_id="c"),
        ModelMessage(role="assistant", content="done"),
        ModelMessage(role="user", content="continue"),
    ]))
    assert "tool_calls" not in history[-2]
    assistant, tool = history[2], history[3]
    assert assistant["role"] == "assistant" and "tool_calls" in assistant and assistant["tool_calls"]
    assert tool["role"] == "tool"
    assert list(assistant["tool_calls"])[0]["id"] == tool["tool_call_id"]


async def completion(messages: list[Message]) -> Completion:
    results = [item async for item in stream(ProviderConfig(provider="faux"), messages, auth=Auth()) if isinstance(item, Completion)]
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


async def test_summary_includes_the_custom_focus_after_the_conversation() -> None:
    summary = await summarize(ProviderConfig(provider="faux"), [Message(role="user", content="原对话")], "保留文件位置", auth=Auth())
    assert "user: 原对话" in summary and "用户补充要求：\n保留文件位置" in summary


async def test_faux_web_tools_stop_after_one_result() -> None:
    search = await completion([Message(role="user", content="/web 项目结构")])
    call = search.message.tool_calls[0]
    assert call.name == "web_search" and json.loads(call.arguments)["query"] == "项目结构"
    fetched = await completion([Message(role="user", content="/fetch https://example.com/a")])
    assert fetched.message.tool_calls[0].name == "web_fetch"
    names = [tool.name for tool in build_tools()]
    assert "web_search" in names and "web_fetch" in names
    done = await completion([
        Message(role="user", content="/web 项目结构"), search.message,
        Message(role="tool", content='{"sources":[]}', tool_call_id=call.id),
    ])
    assert not done.message.tool_calls and done.message.content == '{"sources":[]}'


async def test_faux_delegate_and_tool_schema_agree() -> None:
    result = await completion([Message(role="user", content='/delegate ["first", "second"]')])
    call = result.message.tool_calls[0]
    assert call.name == "delegate_task" and json.loads(call.arguments) == {"tasks": ["first", "second"]}
    definition = next(tool for tool in build_tools() if tool.name == "delegate_task")
    assert definition.parameters['required'] == ['tasks']


async def test_faux_rejects_missing_user_context() -> None:
    with pytest.raises(BackendError, match="missing_user_context"):
        await completion([])


@pytest.mark.parametrize("commands", [[], ["echo"] * 25])
async def test_faux_rejects_out_of_bound_sequences(commands: list[str]) -> None:
    with pytest.raises(BackendError, match="invalid_faux_sequence"):
        await completion([Message(role="user", content="/sequence " + json.dumps(commands))])


def test_product_prompt_tool_filter_and_oauth_names_are_assembled_before_protocol_conversion() -> None:
    config = ProviderConfig(provider='anthropic', api='anthropic-messages',
        system_prompt='Custom system', append_system_prompt='Additional instructions', allowed_tools=['shell'])
    request = model_request(config, [Message(role='user', content='inspect')], auth=Auth(auth_type='oauth'))
    assert request.system_prompt == 'Custom system\n\nAdditional instructions'
    assert [tool.name for tool in request.tools] == ['shell']
    assert request.wire_names == {'shell':'Bash', 'read_file':'Read', 'write_file':'Write',
                                 'delegate_task':'Task', 'web_search':'WebSearch', 'web_fetch':'WebFetch'}
