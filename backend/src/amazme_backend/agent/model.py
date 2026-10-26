"""Product-to-model boundary: prompts, tool selection, faux routing and public DTO validation."""
from collections.abc import AsyncIterator, Sequence

from amazme_backend.agent import faux
from amazme_backend.agent.prompting import build_system_prompt, summary_message
from amazme_backend.agent.tool_catalog import build_tools, wire_names
from amazme_backend.ai import client
from amazme_backend.ai.catalog import CATALOG as MODEL_CATALOG
from amazme_backend.ai.types import Auth, Completion, ModelMessage, ModelRequest, ModelSpec, RequestTransport
from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.models import CatalogModel, Message
from amazme_backend.contracts.plugins import PluginOffer
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.shared.errors import BackendError

ProductCompletion = Completion[Message]
CATALOG = [CatalogModel(provider="faux", model="faux", label="本地确定性", endpoint_editable=False), *MODEL_CATALOG]


def model_spec(config: ProviderConfig) -> ModelSpec:
    return ModelSpec(provider=config.provider, model=config.model, api=config.api, base_url=config.base_url,
                     max_tokens=config.max_tokens, thinking=config.thinking)


def model_transport(config: ProviderConfig) -> RequestTransport:
    return RequestTransport(proxy=config.proxy, headers=dict(config.headers))


def model_request(config: ProviderConfig, messages: Sequence[Message], offers: Sequence[McpOffer] | None = None,
                  plugins: Sequence[PluginOffer] | None = None, *, auth: Auth) -> ModelRequest:
    spec = model_spec(config)
    return ModelRequest(system_prompt=build_system_prompt(config),
        messages=[ModelMessage.model_validate(message.model_dump()) for message in messages],
        tools=build_tools(offers, config, plugins), wire_names=wire_names(spec, auth))


async def stream(config: ProviderConfig, messages: list[Message], offers: Sequence[McpOffer] | None = None,
                 plugins: Sequence[PluginOffer] | None = None, *, auth: Auth) -> AsyncIterator[str | Completion[Message]]:
    if config.provider == "faux":
        async for item in faux.stream(messages):
            yield item
        return
    async for item in client.stream(model_spec(config), model_request(config, messages, offers, plugins, auth=auth),
                                  auth, transport=model_transport(config)):
        if isinstance(item, str):
            yield item
        else:
            yield ProductCompletion.model_validate(item.model_dump())


async def summarize(config: ProviderConfig, messages: list[Message], instructions: str = "", *, auth: Auth) -> str:
    """Ask the configured provider for a context summary. Callers commit it only if the basis still matches."""
    prompt = summary_message(messages, instructions)
    summary = ""
    async for item in stream(config, [prompt], auth=auth):
        if isinstance(item, str):
            summary += item
        elif item.message.content:
            summary = item.message.content
    if not summary.strip():
        raise BackendError("compaction_empty")
    return summary.strip()[:16000]
