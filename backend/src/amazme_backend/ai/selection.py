"""Pi model-resolver's exact, provider, fuzzy and scope ordering in Python."""
import re
from pathlib import PurePosixPath
from typing import get_args

from amazme_backend.contracts.models import (
    CatalogModel,
    ModelScope,
    ModelScopeRequest,
    ScopedModel,
    ThinkingLevel,
)

_LEVELS: dict[str, ThinkingLevel] = {level: level for level in get_args(ThinkingLevel)}


def _suffix(text: str) -> tuple[str, ThinkingLevel] | None:
    base, colon, level = text.rpartition(":")
    return (base, _LEVELS[level]) if colon and level in _LEVELS else None


def _fuzzy(text: str, models: list[CatalogModel]) -> list[CatalogModel]:
    return [model for model in models if text.lower() in model.model.lower() or text.lower() in model.label.removeprefix(model.provider + " · ").lower()]


def _best(models: list[CatalogModel]) -> CatalogModel | None:
    aliases = [model for model in models if model.model.endswith("-latest") or not re.search(r"-\d{8}$", model.model)]
    return max(aliases or models, key=lambda model: model.model, default=None)


def _reference(text: str, models: list[CatalogModel], *, fuzzy: bool) -> list[CatalogModel]:
    raw = [model for model in models if model.model.lower() == text.lower()]
    provider, slash, name = text.partition("/")
    pool = [model for model in models if model.provider.lower() == provider.strip().lower()] if slash else []
    named = next((model for model in pool if model.model.lower() == name.strip().lower()), None)
    if named is None:
        named = next((model for model in raw if model in pool), None)
    if named is None and fuzzy and pool:
        named = _best(_fuzzy(name.strip(), pool))
    if named is not None:
        # Scope receives usable models; an explicit provider wins a raw gateway id.
        return [named]
    if raw:
        return raw
    if not fuzzy:
        return []
    matches = _fuzzy(text, models)
    best = _best(matches)
    return [model for model in matches if best is not None and model.model == best.model]


def _text(text: str, models: list[CatalogModel]) -> tuple[list[CatalogModel], ThinkingLevel | None, str]:
    if not text:
        return [], None, ""
    found = _reference(text, models, fuzzy=True)
    if found:
        return found, None, ""
    split = _suffix(text)
    if split:
        found, _, warning = _text(split[0], models)
        return found, None if warning else split[1], warning
    base, colon, suffix = text.rpartition(":")
    if not colon:
        return [], None, ""
    found, _, _ = _text(base, models)
    return found, None, f'Invalid thinking level "{suffix}" in pattern "{text}". Using default instead.' if found else ""


def resolve_scope(value: ModelScopeRequest, models: list[CatalogModel]) -> ModelScope:
    if value.provider:
        models = [model for model in models if model.provider == value.provider]
    scoped: list[ScopedModel] = []
    seen: set[tuple[str, str]] = set()
    diagnostics: list[str] = []
    for pattern in value.patterns:
        exact = False
        if any(char in pattern for char in "*?["):
            split = _suffix(pattern)
            glob, thinking = split if split else (pattern, None)
            found = _reference(glob, models, fuzzy=False)
            exact = bool(found)
            if not found:
                found = [model for model in models if any(PurePosixPath(text.lower()).full_match(glob.lower())
                    for text in (model.provider + "/" + model.model, model.model))]
        else:
            found, thinking, warning = _text(pattern.strip(), models)
            if warning:
                diagnostics.append(warning)
        if not found:
            diagnostics.append(f'No models match pattern "{pattern}"')
        elif len({model.provider for model in found}) > 1 and (exact or not any(char in pattern for char in "*?[")):
            diagnostics.append(f'Pattern "{pattern}" matches several providers: '
                + ", ".join(sorted({model.provider for model in found})) + ". Use provider/id to choose one.")
        for model in found:
            key = (model.provider, model.model)
            if key not in seen:
                seen.add(key)
                scoped.append(ScopedModel(model=model, thinking=thinking))
    return ModelScope(models=scoped, diagnostics=diagnostics)
