from amazme_backend.contracts import Message, ToolCall
from amazme_backend.providers import provider_messages


def test_plain_assistant_history_omits_empty_tool_calls():
    history = provider_messages([
        Message(role="user", content="first"),
        Message(role="assistant", content="", tool_calls=[ToolCall(id="c", name="shell", arguments='{"command":"pwd"}')]),
        Message(role="tool", content="/workspace", tool_call_id="c"),
        Message(role="assistant", content="done"),
        Message(role="user", content="continue"),
    ])
    assert "tool_calls" not in history[-2]
    assert history[2]["tool_calls"][0]["id"] == history[3]["tool_call_id"]
