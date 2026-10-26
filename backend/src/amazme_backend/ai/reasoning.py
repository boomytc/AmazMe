"""Pi model-level clamping and reasoning wire fields, without provider retries."""
from __future__ import annotations

import re

from pydantic import JsonValue

from amazme_backend.ai.catalog import INDEX, PiModel
from amazme_backend.ai.types import ModelSpec
from amazme_backend.contracts.models import ThinkingLevel
from amazme_backend.shared.errors import BackendError

LEVELS: list[ThinkingLevel] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
BUDGETS = {"minimal": 1024, "low": 2048, "medium": 8192, "high": 16384, "xhigh": 16384, "max": 16384}


def level_for(config: ModelSpec) -> tuple[PiModel | None, ThinkingLevel]:
    model = INDEX.get((config.provider, config.model))
    if model is None:
        return None, config.thinking or "off"
    available = model.thinking_levels()
    requested = config.thinking or "off"
    if requested in available:
        return model, requested
    index = LEVELS.index(requested)
    ordered = [*LEVELS[index:], *reversed(LEVELS[:index])]
    for candidate in ordered:
        if candidate in available:
            return model, candidate
    return model, "off"


def mapped_level(model: PiModel | None, level: ThinkingLevel) -> str | None:
    return model.thinking_level_map.get(level, level) if model else level


def completions_thinking(config: ModelSpec) -> dict[str, JsonValue]:
    model, level = level_for(config)
    if model is None or not model.reasoning:
        return {}
    compat = model.compat
    format_ = compat.get("thinkingFormat", "openai")
    enabled = level != "off"
    effort = mapped_level(model, level)
    supports_effort = compat.get("supportsReasoningEffort", format_ not in {"zai", "together", "ant-ling"}) is True
    body: dict[str, JsonValue] = {}
    if format_ in {"deepseek", "zai"}:
        if enabled or mapped_level(model, "off") is not None:
            body["thinking"] = {"type":"enabled" if enabled else "disabled"}
        if format_ == "zai" and enabled:
            body["thinking"] = {"type":"enabled", "clear_thinking":False}
    elif format_ == "qwen":
        body["enable_thinking"] = enabled
    elif format_ == "qwen-chat-template":
        body["chat_template_kwargs"] = {"enable_thinking":enabled, "preserve_thinking":True}
    elif format_ == "openrouter":
        if enabled or mapped_level(model, "off") is not None:
            body["reasoning"] = {"effort":effort if enabled else model.thinking_level_map.get("off", "none")}
        supports_effort = False
    elif format_ == "together":
        body["reasoning"] = {"enabled":enabled}
    elif format_ == "string-thinking":
        if enabled or mapped_level(model, "off") is not None:
            body["thinking"] = effort if enabled else model.thinking_level_map.get("off", "none")
        supports_effort = False
    elif format_ == "ant-ling":
        if enabled and level in model.thinking_level_map and effort is not None:
            body["reasoning"] = {"effort":effort}
        supports_effort = False
    budget = min(BUDGETS.get(level, 0), max(0, config.max_tokens - 1024))
    if format_ in {"baseten", "chat-template"}:
        source_key = "chatTemplateArgs" if format_ == "baseten" else "chatTemplateKwargs"
        values = compat.get(source_key)
        resolved: dict[str, JsonValue] = {}
        if isinstance(values, dict):
            for key, value in values.items():
                if isinstance(value, dict):
                    if value.get("omitWhenOff") and not enabled:
                        continue
                    variable = value.get("$var")
                    if variable == "thinking.enabled":
                        value = enabled
                    elif variable == "thinking.budget":
                        value = budget or None
                    else:
                        value = effort
                if value is not None:
                    resolved[key] = value
        if resolved:
            body["chat_template_args" if format_ == "baseten" else "chat_template_kwargs"] = resolved
    if supports_effort and effort is not None and (enabled or "off" in model.thinking_level_map):
        body["reasoning_effort"] = effort
    budget_field = compat.get("thinkingTokenBudgetField") or ("thinking_token_budget" if compat.get("supportsThinkingTokenBudget") else None)
    if isinstance(budget_field, str) and enabled and budget:
        body[budget_field] = budget
    return body


def responses_thinking(config: ModelSpec) -> dict[str, JsonValue]:
    model, level = level_for(config)
    if model is None or not model.reasoning:
        return {}
    if level != "off":
        return {"reasoning":{"effort":mapped_level(model, level), "summary":"auto"}}
    off = model.thinking_level_map.get("off", "none")
    return {"reasoning":{"effort":off}} if off is not None else {}


def anthropic_thinking(config: ModelSpec) -> dict[str, JsonValue]:
    model, level = level_for(config)
    if model is None or not model.reasoning:
        return {}
    if level == "off":
        return {"thinking":{"type":"disabled"}}
    if model.compat.get("forceAdaptiveThinking") is True:
        mapped = mapped_level(model, level)
        effort = mapped if level in model.thinking_level_map else {"minimal":"low", "low":"low", "medium":"medium", "high":"high"}.get(level, "high")
        return {"thinking":{"type":"adaptive", "display":"summarized"}, "output_config":{"effort":effort}}
    maximum = min(config.max_tokens + BUDGETS[level], model.max_tokens)
    budget = min(BUDGETS[level], max(0, maximum - 1024))
    return {"max_tokens":maximum, "thinking":{"type":"enabled", "budget_tokens":budget or 1024, "display":"summarized"}}


def google_thinking(config: ModelSpec) -> dict[str, JsonValue]:
    model, level = level_for(config)
    if model is None or not model.reasoning:
        return {}
    uses_level = bool(re.search(r"gemini-3(?:\.\d+)?-(?:pro|flash)|gemini-(?:[4-9]|[1-9]\d)|gemma-?4", model.id.lower())) or model.id in {"gemini-flash-latest", "gemini-flash-lite-latest"}
    if level == "off":
        return {"thinkingBudget":0}
    mapped = (mapped_level(model, level) or level).lower()
    if mapped not in {"minimal", "low", "medium", "high"}:
        raise BackendError("unsupported_google_thinking_level")
    if uses_level:
        return {"includeThoughts":True, "thinkingLevel":mapped.upper()}
    budgets = {"minimal":128, "low":2048, "medium":8192, "high":32768 if "2.5-pro" in model.id else 24576}
    if "2.5-flash-lite" in model.id:
        budgets["minimal"] = 512
    return {"includeThoughts":True, "thinkingBudget":budgets[mapped] if "2.5-" in model.id else -1}
