"""Provider-neutral streaming entry point. The caller owns product request assembly."""
import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing

import httpx
from pydantic import BaseModel, Field, ValidationError

from amazme_backend.ai.providers import anthropic, completions, google, responses
from amazme_backend.ai.providers.headers import base_headers, merge_headers
from amazme_backend.ai.types import (
    Auth,
    Completion,
    ModelMessage,
    ModelRequest,
    ModelSpec,
    ProviderEvent,
    RequestTransport,
    StreamProgress,
)
from amazme_backend.contracts.models import CatalogModel, ModelSelection
from amazme_backend.shared.errors import BackendError


class _DiscoveredModel(BaseModel):
    id: str = ""
    name: str = ""
    displayName: str = ""
    inputTokenLimit: int | None = Field(default=None, gt=0)


class _ModelPage(BaseModel):
    data: list[_DiscoveredModel] = Field(default_factory=lambda: list[_DiscoveredModel](), max_length=4096)
    models: list[_DiscoveredModel] = Field(default_factory=lambda: list[_DiscoveredModel](), max_length=4096)
    has_more: bool = False
    last_id: str = ""
    nextPageToken: str = ""


async def discover_models(model: ModelSpec, auth: Auth, connection: RequestTransport) -> list[CatalogModel]:
    request = ModelRequest(messages=[ModelMessage(role="user", content="")])
    headers = base_headers(model, request, auth, connection)
    endpoint = model.base_url.rstrip("/")
    if model.api == "anthropic-messages":
        _, headers = anthropic.anthropic_body(model, request, auth, connection)
        endpoint += "/models" if endpoint.endswith("/v1") else "/v1/models"
    else:
        endpoint += "/models"
    if model.api == "google-generative-ai":
        headers = merge_headers(connection.headers, auth.headers, {"x-goog-api-key": auth.api_key.get_secret_value()})
    found: dict[str, CatalogModel] = {}
    params: dict[str, str] = {}
    cursors: set[str] = set()
    try:
        async with asyncio.timeout(25), httpx.AsyncClient(proxy=connection.proxy or None, trust_env=False, timeout=20) as client:
            for _ in range(32):
                async with client.stream("GET", endpoint, headers=headers, params=params) as response:
                    response.raise_for_status()
                    body = bytearray()
                    async for part in response.aiter_bytes():
                        body.extend(part)
                        if len(body) > 4 * 1024 * 1024:
                            raise BackendError("model_list_too_large")
                page = _ModelPage.model_validate_json(body)
                for item in page.models if model.api == "google-generative-ai" else page.data:
                    name = item.name.removeprefix("models/") if model.api == "google-generative-ai" else item.id
                    selected = ModelSelection(provider=model.provider, model=name)
                    found[name] = CatalogModel(provider=selected.provider, model=selected.model,
                        label=item.displayName or item.name or name, api=model.api, base_url=model.base_url,
                        endpoint_editable=True, context_window=item.inputTokenLimit)
                if len(found) > 4096:
                    raise BackendError("model_list_too_large")
                cursor = page.nextPageToken or (page.last_id if page.has_more else "")
                if not cursor:
                    if not found or page.has_more:
                        raise BackendError("model_list_invalid")
                    return list(found.values())
                if cursor in cursors:
                    raise BackendError("model_list_invalid")
                cursors.add(cursor)
                params = {"pageToken" if model.api == "google-generative-ai" else "after_id": cursor}
    except (httpx.HTTPError, ValidationError, TimeoutError) as exc:
        raise BackendError("model_list_unavailable", "无法获取供应商模型列表；可继续使用现有目录。", status=502) from exc
    raise BackendError("model_list_too_large")


async def stream(model: ModelSpec, request: ModelRequest, auth: Auth, *,
                 transport: RequestTransport | None = None) -> AsyncGenerator[str | Completion, None]:
    if not request.messages or not any(message.role == "user" for message in request.messages):
        raise BackendError("missing_user_context")
    if not auth.api_key.get_secret_value():
        raise BackendError("provider_not_configured")
    connection = transport if transport is not None else RequestTransport()
    async with aclosing(_provider_stream(model, request, auth, connection)) as response:
        while True:
            try:
                async with asyncio.timeout(connection.timeout_seconds):
                    item = await anext(response)
            except StopAsyncIteration:
                return
            except TimeoutError:
                raise BackendError("model_stream_timeout", status=503) from None
            if not isinstance(item, StreamProgress):
                yield item


async def _provider_stream(model: ModelSpec, request: ModelRequest, auth: Auth,
                           connection: RequestTransport) -> AsyncGenerator[ProviderEvent, None]:
    if model.api == "openai-completions":
        async with aclosing(completions.stream(model, request, auth, connection)) as response:
            async for item in response:
                yield item
        return
    operation = {"openai-responses": responses.responses, "openai-codex-responses": responses.responses,
                 "anthropic-messages": anthropic.anthropic, "google-generative-ai": google.google}.get(model.api)
    if operation is None:
        raise BackendError("model_api_unknown")
    async with httpx.AsyncClient(proxy=connection.proxy or None, trust_env=False,
                                 timeout=connection.timeout_seconds) as client:
        async with aclosing(operation(model, request, auth, connection, client)) as response:
            async for item in response:
                yield item
