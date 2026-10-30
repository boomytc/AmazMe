"""Provider-neutral streaming entry point. The caller owns product request assembly."""
import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing

import httpx

from amazme_backend.ai.providers import anthropic, completions, google, responses
from amazme_backend.ai.types import (
    Auth,
    Completion,
    ModelRequest,
    ModelSpec,
    ProviderEvent,
    RequestTransport,
    StreamProgress,
)
from amazme_backend.shared.errors import BackendError


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
