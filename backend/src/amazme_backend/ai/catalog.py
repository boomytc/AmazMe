"""Packaged model metadata from Pi and provider catalogs; the runtime never imports TS business code."""


from pydantic import Field, JsonValue, TypeAdapter

from amazme_backend.contracts.models import CatalogModel, ProviderApi, ProviderDefinition, ThinkingLevel
from amazme_backend.platform.resources import package_resource
from amazme_backend.shared.model import Model


class PiModel(Model):
    id: str
    provider: str
    name: str
    api: ProviderApi
    base_url: str = Field(alias='baseUrl')
    max_tokens: int = Field(alias='maxTokens')
    context_window: int | None = Field(default=None, alias='contextWindow', gt=0)
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


MODELS = [model for resource in ('models', 'command_code_models')
    for model in TypeAdapter(list[PiModel]).validate_json(package_resource(resource).read_bytes())]
PROVIDERS = {"command-code": ProviderDefinition(provider="command-code", name="Command Code",
    base_url="https://api.commandcode.ai/provider/v1", api=None)}
INDEX = {(model.provider, model.id): model for model in MODELS}
CATALOG = [
    CatalogModel(provider=model.provider, model=model.id, label=f'{model.provider} · {model.name}',
                 api=model.api, base_url=model.base_url, endpoint_editable=True, thinking_levels=model.thinking_levels(),
                 context_window=model.context_window) for model in INDEX.values()]

SELECTION_INDEX = {(model.provider, model.model): model for model in CATALOG}
