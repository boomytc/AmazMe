"""Product-to-model boundary: prompts, tool selection, faux routing and public DTO validation."""
import time
from collections.abc import AsyncGenerator, Sequence
from contextlib import aclosing
from dataclasses import dataclass

from amazme_backend.agent import faux
from amazme_backend.agent.prompting import build_system_prompt, summary_message
from amazme_backend.agent.tool_catalog import build_tools, wire_names
from amazme_backend.ai import client
from amazme_backend.ai.catalog import CATALOG as MODEL_CATALOG
from amazme_backend.ai.types import Auth, Completion, ModelMessage, ModelRequest, ModelSpec, RequestTransport
from amazme_backend.ai.usage import call_usage
from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.models import CatalogModel, Message, ModelCallUsage
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
                  plugins: Sequence[PluginOffer] | None = None, *, auth: Auth, context: str = "") -> ModelRequest:
    spec = model_spec(config)
    return ModelRequest(system_prompt=build_system_prompt(config, context=context),
        messages=[ModelMessage.model_validate(message.model_dump()) for message in messages],
        tools=build_tools(offers, config, plugins), wire_names=wire_names(spec, auth))


def _without_historical_images(request: ModelRequest) -> ModelRequest | None:
    boundary = next((index for index in range(len(request.messages) - 1, -1, -1)
                     if request.messages[index].role == "user"), 0)
    if not any(message.images for message in request.messages[:boundary]):
        return None
    messages = [
        message.model_copy(update={
            "images": [],
            "content": message.content + f"\n[{len(message.images)} historical image(s) omitted after request body size rejection.]",
        }) if index < boundary and message.images else message
        for index, message in enumerate(request.messages)
    ]
    return request.model_copy(update={"messages": messages})


async def stream(config: ProviderConfig, messages: list[Message], offers: Sequence[McpOffer] | None = None,
                 plugins: Sequence[PluginOffer] | None = None, *, auth: Auth, context: str = "") -> AsyncGenerator[str | Completion[Message], None]:
    if config.provider == "faux":
        async for item in faux.stream(messages):
            yield item
        return
    request = model_request(config, messages, offers, plugins, auth=auth, context=context)
    emitted = False
    for attempt in range(2):
        try:
            async with aclosing(client.stream(model_spec(config), request, auth,
                                              transport=model_transport(config))) as response:
                async for item in response:
                    emitted = True
                    if isinstance(item, str):
                        yield item
                    else:
                        yield ProductCompletion.model_validate(item.model_dump())
            return
        except BackendError as error:
            reduced = _without_historical_images(request) if (
                error.code == "model_http_413" and attempt == 0 and not emitted
            ) else None
            if reduced is None:
                raise
            request = reduced


@dataclass(frozen=True)
class SummaryResult:
    text: str
    usage: ModelCallUsage


async def summarize(config: ProviderConfig, messages: list[Message], instructions: str = "", *,
                    auth: Auth, call_id: str) -> SummaryResult:
    """Ask the configured provider for a context summary. Callers commit it only if the basis still matches."""
    prompt = summary_message(messages, instructions)
    summary = ""
    started = time.time_ns() // 1000000
    first_text: int | None = None
    completion: ProductCompletion | None = None
    async with aclosing(stream(config, [prompt], auth=auth)) as response:
        async for item in response:
            if isinstance(item, str):
                summary += item
                if item and first_text is None:
                    first_text = time.time_ns() // 1000000
            else:
                completion = item
                if item.message.content:
                    summary = item.message.content
    if completion is None:
        raise BackendError("missing_model_completion")
    if not summary.strip():
        raise BackendError("compaction_empty")
    return SummaryResult(summary.strip()[:16000], call_usage(call_id, config.provider, config.model, completion,
        started_at_ms=started, first_text_at_ms=first_text, finished_at_ms=time.time_ns() // 1000000))
