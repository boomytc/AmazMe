"""Reasoning fields match the original Pi capability table and protocol branches."""
from pathlib import Path

import pytest

from amazme_backend.contracts import BackendError, HostFence, ProviderConfig, Submit, ThinkingLevel
from amazme_backend.model_catalog import INDEX
from amazme_backend.provider_wire import anthropic_body, google_body, responses_body
from amazme_backend.providers import provider_messages
from amazme_backend.session_domain import Continue, ModelInvocation
from amazme_backend.storage import SessionStore
from amazme_backend.thinking import completions_thinking, level_for


def config(provider: str, model: str, thinking: ThinkingLevel = "off") -> ProviderConfig:
    return ProviderConfig(provider=provider, model=model, thinking=thinking)


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
        body = responses_body(value, [], None)
        assert body["reasoning"] == {"effort":"high", "summary":"auto"}
        assert body["include"] == ["reasoning.encrypted_content"]


def test_anthropic_budget_preserves_answer_room_and_adaptive_models_use_effort() -> None:
    value = config("anthropic", "claude-haiku-4-5", "high")
    body, _ = anthropic_body(value, [], None)
    assert body["max_tokens"] == 2048 + 16384
    assert body["thinking"] == {"type":"enabled", "budget_tokens":16384, "display":"summarized"}
    adaptive, _ = anthropic_body(config("anthropic", "claude-fable-5", "max"), [], None)
    assert adaptive["thinking"] == {"type":"adaptive", "display":"summarized"}
    assert adaptive["output_config"] == {"effort":"max"}
    disabled, _ = anthropic_body(config("anthropic", "claude-haiku-4-5"), [], None)
    assert disabled["thinking"] == {"type":"disabled"}


def test_google_uses_level_or_budget_with_original_model_off_fallback() -> None:
    budget = google_body(config("google", "gemini-2.5-pro", "high"), [], None)
    assert budget["generationConfig"] == {"maxOutputTokens":2048,"thinkingConfig":{"includeThoughts":True,"thinkingBudget":32768}}
    candidate = next(model for model in INDEX.values() if model.provider == "google" and "gemini-3" in model.id and "pro" in model.id)
    body = google_body(config(candidate.provider, candidate.id, "high"), [], None)
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
        await store.db.close()
        store = SessionStore(path, "session", require_existing=True)
        await store.initialize()
        for _ in range(12):
            action = await store.advance()
            if not isinstance(action, Continue):
                break
        assert isinstance(action, ModelInvocation)
        assert action.config.thinking == "max"
        assert provider_messages([], config=action.config)[0]["role"] == "system"
    finally:
        await store.db.close()


@pytest.mark.parametrize('requested', ['off', 'max'])
async def test_assistant_retains_requested_thinking_across_restart_and_next_turn(tmp_path: Path, requested: ThinkingLevel) -> None:
    from test_session_branch import Driver

    from amazme_backend.contracts import Message
    from amazme_backend.providers import Completion
    from amazme_backend.session_domain import ModelReturned

    path, fence = tmp_path / 'session.sqlite', HostFence(build_id='thinking-history', host_epoch=1)
    store = SessionStore(path, 'session', build=fence.build_id, config=ProviderConfig(provider='faux'))
    await store.initialize()
    await store.fence(fence)
    try:
        await store.accept(Submit(request_id='first', text='plan', thinking=requested), fence)
        action = await Driver(store).until(ModelInvocation)
        assert isinstance(action, ModelInvocation)
        reply = Completion(response_id='reply', message=Message(role='assistant', content='done', thinking='low'))
        await store.advance(ModelReturned(action, reply))
        assert reply.message.thinking == 'low'
    finally:
        await store.db.close()

    reopened = SessionStore(path, 'session', build=fence.build_id, config=ProviderConfig(provider='faux'), require_existing=True)
    try:
        await reopened.initialize()
        await Driver(reopened).drain()
        history = await reopened.messages('first')
        assert [message.thinking for message in history if message.role == 'assistant'] == [requested]
        await reopened.accept(Submit(request_id='next', text='continue', thinking='high'), fence)
        following = await Driver(reopened).until(ModelInvocation)
        assert isinstance(following, ModelInvocation) and following.config.thinking == 'high'
        assert [message.thinking for message in following.messages if message.role == 'assistant'] == [requested]
    finally:
        await reopened.db.close()
