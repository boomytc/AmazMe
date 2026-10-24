"""Pi's hydrated model metadata; the runtime reads JSON and never imports TS business code."""

from pathlib import Path

from pydantic import Field, JsonValue, TypeAdapter

from .contracts import CatalogModel, Model, ProviderApi, ThinkingLevel


class PiModel(Model):
    id: str
    provider: str
    name: str
    api: ProviderApi
    base_url: str = Field(alias='baseUrl')
    max_tokens: int = Field(alias='maxTokens')
    reasoning: bool = False
    thinking_level_map: dict[str, str | None] = Field(default_factory=dict, alias='thinkingLevelMap')

    def thinking_levels(self) -> list[ThinkingLevel]:
        if not self.reasoning:
            return ["off"]
        levels: list[ThinkingLevel] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        return [level for level in levels if self.thinking_level_map.get(level, "") is not None
            and (level not in {"xhigh", "max"} or level in self.thinking_level_map)]
    cost: dict[str, JsonValue] = Field(default_factory=dict)
    compat: dict[str, JsonValue] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    input: list[str] = Field(default_factory=lambda: ['text'])


MODELS = TypeAdapter(list[PiModel]).validate_json(Path(__file__).with_name('model_catalog.json').read_bytes())
INDEX = {(model.provider, model.id): model for model in MODELS}
CATALOG = [CatalogModel(provider='faux', model='faux', label='本地确定性', endpoint_editable=False)] + [
    CatalogModel(provider=model.provider, model=model.id, label=f'{model.provider} · {model.name}',
                 api=model.api, base_url=model.base_url, endpoint_editable=True, thinking_levels=model.thinking_levels()) for model in INDEX.values()]
