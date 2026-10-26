"""Reasoning fields match the original Pi capability table and protocol branches."""
from pathlib import Path

import pytest

from amazme_backend.agent.model import ProductCompletion, model_request, model_spec
from amazme_backend.agent.prompting import build_system_prompt
from amazme_backend.ai.catalog import INDEX
from amazme_backend.ai.providers.anthropic import anthropic_body
from amazme_backend.ai.providers.completions import provider_messages
from amazme_backend.ai.providers.google import google_body
from amazme_backend.ai.providers.responses import responses_body
from amazme_backend.ai.reasoning import completions_thinking, level_for
from amazme_backend.ai.types import Auth, ModelRequest, ModelSpec, RequestTransport
from amazme_backend.contracts import BackendError, HostFence, ProviderConfig, Submit, ThinkingLevel
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import Continue, ModelInvocation, ModelReturned, Park


def config(provider: str, model: str, thinking: ThinkingLevel = "off") -> ModelSpec:
    return ModelSpec(provider=provider, model=model, thinking=thinking, base_url='https://provider.example/v1')


async def next_action(store: SessionStore):
    for _ in range(30):
        action = await store.advance()
        if not isinstance(action, Continue):
            return action
    pytest.fail('No observable session action')


def test_reasoning_is_clamped_to_pi_supported_levels_and_mapped_once() -> None:
    assert level_for(config("deepseek", "deepseek-flash", "minimal"))[1] == "low"
    assert level_for(config("deepseek", "deepseek-flash", "medium"))[1] == "high"
    assert level_for(config("openai", "gpt-5", "off"))[1] == "minimal"
    assert level_for(config("openai", "gpt-5", "max"))[1] == "high"
    assert completions_thinking(config("deepseek", "deepseek-flash", "max")) == {
        "thinking":{"type":"enabled"}, "reasoning_effort":"max"}
    assert completions_thinking(config("deepseek", "deepseek-flash")) == {"thinking":{"type":"disabled"}}
    assert completions_thinking(config("faux", "faux", "high")) == {}


def test_responses_use_same_model_mapping_and_keep_encrypted_history() -> None:
    for api in ("openai-responses", "openai-codex-responses"):
        value = config("openai", "gpt-5", "max").model_copy(update={"api":api})
        body = responses_body(value, ModelRequest(messages=[]))
        assert body["reasoning"] == {"effort":"high", "summary":"auto"}
        assert body["include"] == ["reasoning.encrypted_content"]


def test_anthropic_budget_preserves_answer_room_and_adaptive_models_use_effort() -> None:
    value = config("anthropic", "claude-haiku-4-5", "high")
    body, _ = anthropic_body(value, ModelRequest(messages=[]), Auth(), RequestTransport())
    assert body["max_tokens"] == 2048 + 16384
    assert body["thinking"] == {"type":"enabled", "budget_tokens":16384, "display":"summarized"}
    adaptive, _ = anthropic_body(config("anthropic", "claude-fable-5", "max"), ModelRequest(messages=[]), Auth(), RequestTransport())
    assert adaptive["thinking"] == {"type":"adaptive", "display":"summarized"}
    assert adaptive["output_config"] == {"effort":"max"}
    disabled, _ = anthropic_body(config("anthropic", "claude-haiku-4-5"), ModelRequest(messages=[]), Auth(), RequestTransport())
    assert disabled["thinking"] == {"type":"disabled"}


def test_google_uses_level_or_budget_with_original_model_off_fallback() -> None:
    budget = google_body(config("google", "gemini-2.5-pro", "high"), ModelRequest(messages=[]))
    assert budget["generationConfig"] == {"maxOutputTokens":2048,"thinkingConfig":{"includeThoughts":True,"thinkingBudget":32768}}
    candidate = next(model for model in INDEX.values() if model.provider == "google" and "gemini-3" in model.id and "pro" in model.id)
    body = google_body(config(candidate.provider, candidate.id, "high"), ModelRequest(messages=[]))
    assert body["generationConfig"] == {"maxOutputTokens":2048,"thinkingConfig":{"includeThoughts":True,"thinkingLevel":"HIGH"}}


@pytest.mark.parametrize('provider,prefix', [('moonshotai', 'kimi-'), ('moonshotai-cn', 'kimi-'), ('kimi-coding', '')])
@pytest.mark.parametrize('suffix', ['k3.1-pro', 'k3.1-pro-highspeed'])
def test_kimi_k3_point_releases_use_effort_without_the_old_thinking_toggle(provider: str, prefix: str, suffix: str) -> None:
    value = config(provider, prefix + suffix, 'max')
    model, level = level_for(value)
    assert model is not None and level == 'max'
    assert model.cost['cacheWrite'] == 0
    assert model.compat['requiresReasoningContentOnAssistantMessages'] is True
    assert completions_thinking(value) == {'reasoning_effort': 'max'}
    assert completions_thinking(config(provider, prefix + suffix, 'off')) == {'reasoning_effort': 'low'}


async def test_reasoning_is_saved_on_accept_and_replay_cannot_change_it(tmp_path: Path) -> None:
    path, fence = tmp_path / "session.sqlite", HostFence(build_id="test-build", host_epoch=1)
    store = SessionStore(path, "session")
    await store.initialize()
    await store.fence(fence)
    try:
        value = Submit(request_id="stable", text="plan", thinking="max")
        receipt = await store.accept(value, fence)
        assert await store.accept(value, fence) == receipt
        with pytest.raises(BackendError, match="request_conflict"):
            await store.accept(value.model_copy(update={"thinking":"off"}), fence)
        await store.close()
        store = SessionStore(path, "session", require_existing=True)
        await store.initialize()
        for _ in range(12):
            action = await store.advance()
            if not isinstance(action, Continue):
                break
        assert isinstance(action, ModelInvocation)
        assert action.config.thinking == "max"
        assert build_system_prompt(action.config).startswith('You are AmazMe.')
        wire = provider_messages(model_spec(action.config), model_request(action.config, action.messages, auth=Auth()))
        assert wire[0]['role'] == 'system'
        assert wire[0]['content'] == build_system_prompt(action.config)
    finally:
        await store.close()


@pytest.mark.parametrize('requested', ['off', 'max'])
async def test_assistant_retains_requested_thinking_across_restart_and_next_turn(tmp_path: Path, requested: ThinkingLevel) -> None:
    from amazme_backend.contracts import Message

    path, fence = tmp_path / 'session.sqlite', HostFence(build_id='thinking-history', host_epoch=1)
    store = SessionStore(path, 'session', build=fence.build_id, config=ProviderConfig(provider='faux'))
    await store.initialize()
    await store.fence(fence)
    try:
        await store.accept(Submit(request_id='first', text='plan', thinking=requested), fence)
        action = await next_action(store)
        assert isinstance(action, ModelInvocation)
        reply = ProductCompletion(response_id='reply', message=Message(role='assistant', content='done', thinking='low'))
        await store.advance(ModelReturned(action, reply))
        assert reply.message.thinking == 'low'
    finally:
        await store.close()

    reopened = SessionStore(path, 'session', build=fence.build_id, config=ProviderConfig(provider='faux'), require_existing=True)
    try:
        await reopened.initialize()
        assert isinstance(await next_action(reopened), Park)
        history = await reopened.messages('first')
        assert [message.thinking for message in history if message.role == 'assistant'] == [requested]
        await reopened.accept(Submit(request_id='next', text='continue', thinking='high'), fence)
        following = await next_action(reopened)
        assert isinstance(following, ModelInvocation) and following.config.thinking == 'high'
        assert [message.thinking for message in following.messages if message.role == 'assistant'] == [requested]
    finally:
        await reopened.close()
