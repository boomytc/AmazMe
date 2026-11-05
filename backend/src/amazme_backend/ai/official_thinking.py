"""Command Code thinking levels follow the vendor catalog for the same model.

The gateway model list only says whether reasoning exists. Levels and the wire
spelling come from that model's vendor entry in the Pi catalog. Chat Completions
on this gateway accept ``off|low|medium|high|xhigh|max``; ``none`` is sent as
``off``, and a level whose spelling is outside that set is left unavailable.
"""

from __future__ import annotations

import json
import re

from amazme_backend.platform.resources import package_resource

_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
_COMPLETIONS_EFFORT = {"off", "low", "medium", "high", "xhigh", "max"}
_SUFFIXES = ("-vision-exp", "-ultraspeed", "-highspeed", "-fast")
_VENDORS = {
    "deepseek": "deepseek",
    "google": "google",
    "xai": "xai",
    "moonshotai": "moonshotai",
    "z-ai": "zai",
    "zai-org": "zai",
    "minimaxai": "minimax",
    "minimax": "minimax",
    "meta": "meta",
    "xiaomi": "xiaomi",
    "qwen": "qwen-token-plan",
    "nvidia": "nvidia",
}


def align_command_code_models(records: list[dict[str, object]]) -> None:
    grouped: dict[str, list[dict[str, object]]] = {}
    for model in json.loads(package_resource("models").read_bytes()):
        provider = model.get("provider")
        if isinstance(provider, str):
            grouped.setdefault(provider, []).append(model)
    for record in records:
        official = _match(record, grouped)
        if official is not None:
            _apply(record, official)


def _apply(record: dict[str, object], official: dict[str, object]) -> None:
    official_map = official.get("thinkingLevelMap")
    mapping = official_map if isinstance(official_map, dict) else {}
    compat = official.get("compat")
    official_compat = compat if isinstance(compat, dict) else {}
    effort_disabled = official_compat.get("supportsReasoningEffort") is False
    adaptive = official_compat.get("forceAdaptiveThinking") is True
    if not mapping and not effort_disabled and not adaptive:
        return
    cc_api = record.get("api")
    official_api = official.get("api")
    record_compat = record.get("compat")
    merged = dict(record_compat) if isinstance(record_compat, dict) else {}
    if cc_api == official_api == "anthropic-messages":
        if mapping:
            record["thinkingLevelMap"] = dict(mapping)
        if adaptive:
            merged["forceAdaptiveThinking"] = True
            record["compat"] = merged
        return
    if cc_api == official_api == "openai-responses" and mapping:
        record["thinkingLevelMap"] = dict(mapping)
        return
    if cc_api != "openai-completions":
        return
    # A false effort flag with no wire spelling means the vendor does not accept
    # reasoning_effort. A mapped spelling still has to be sent on this gateway.
    mapped_effort = any(isinstance(value, str) for value in mapping.values())
    if mapping and effort_disabled and not mapped_effort:
        record["thinkingLevelMap"] = dict(mapping)
    elif mapping:
        record["thinkingLevelMap"] = _completions_map(official)
    if effort_disabled and not mapped_effort:
        thinking_format = official_compat.get("thinkingFormat")
        if cc_api == official_api and isinstance(thinking_format, str):
            merged["thinkingFormat"] = thinking_format
        merged["supportsReasoningEffort"] = False
        record["compat"] = merged


def _completions_map(official: dict[str, object]) -> dict[str, str | None]:
    raw = official.get("thinkingLevelMap")
    mapping = raw if isinstance(raw, dict) else {}
    available = set(_levels(official))
    resolved: dict[str, str | None] = {}
    for level in _LEVELS:
        if level not in available:
            resolved[level] = None
            continue
        wire = mapping.get(level, level)
        if wire == "none":
            wire = "off"
        resolved[level] = wire if isinstance(wire, str) and wire in _COMPLETIONS_EFFORT else None
    return resolved


def _levels(record: dict[str, object]) -> list[str]:
    if not record.get("reasoning"):
        return ["off"]
    raw = record.get("thinkingLevelMap")
    mapping = raw if isinstance(raw, dict) else {}
    return [level for level in _LEVELS if mapping.get(level, "") is not None
            and (level not in {"xhigh", "max"} or level in mapping)]


def _match(record: dict[str, object], grouped: dict[str, list[dict[str, object]]]) -> dict[str, object] | None:
    model_id = record.get("id")
    if not isinstance(model_id, str):
        return None
    provider = _vendor(model_id)
    if provider is None:
        return None
    pool = grouped.get(provider, [])
    by_id: dict[str, list[dict[str, object]]] = {}
    by_name: dict[str, list[dict[str, object]]] = {}
    for model in pool:
        _index(by_id, model.get("id"), model)
        _index(by_name, model.get("name"), model)
    found = _one(by_id, _normalize(model_id))
    if found is not None:
        return found
    name = record.get("name")
    if isinstance(name, str):
        found = _one(by_name, _normalize(name))
        if found is not None:
            return found
    for raw in (model_id, name if isinstance(name, str) else ""):
        key = _normalize(raw)
        for suffix in _SUFFIXES:
            if key.endswith(suffix):
                base = key[: -len(suffix)]
                found = _one(by_id, base) or _one(by_name, base)
                if found is not None:
                    return found
    return None


def _index(table: dict[str, list[dict[str, object]]], value: object, model: dict[str, object]) -> None:
    if isinstance(value, str):
        table.setdefault(_normalize(value), []).append(model)


def _one(table: dict[str, list[dict[str, object]]], key: str) -> dict[str, object] | None:
    hits = table.get(key, [])
    chosen = {str(item.get("id")) for item in hits}
    if len(chosen) == 1:
        return hits[0]
    return None


def _vendor(model_id: str) -> str | None:
    leaf = model_id.rsplit("/", 1)[-1].lower()
    prefix = model_id.split("/", 1)[0].lower() if "/" in model_id else ""
    if leaf.startswith("claude"):
        return "anthropic"
    if leaf.startswith("gpt-"):
        return "openai"
    if prefix in _VENDORS:
        return _VENDORS[prefix]
    if leaf.startswith("grok"):
        return "xai"
    if leaf.startswith("gemini"):
        return "google"
    return None


def _normalize(value: str) -> str:
    text = re.sub(r"\([^)]*\)", "", value.lower())
    text = text.split(":", 1)[0]
    text = text.rsplit("/", 1)[-1]
    text = text.replace("_", "-").replace(".", "-").replace(" ", "-")
    text = re.sub(r"[^a-z0-9-]+", "-", text)
    return re.sub(r"-+", "-", text).strip("-")
