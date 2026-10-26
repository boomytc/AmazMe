"""Provider-neutral streaming entry point. The caller owns product request assembly."""
from collections.abc import AsyncIterator

import httpx

from amazme_backend.ai.providers import anthropic, completions, google, responses
from amazme_backend.ai.types import Auth, Completion, ModelRequest, ModelSpec, RequestTransport
from amazme_backend.shared.errors import BackendError


async def stream(model: ModelSpec, request: ModelRequest, auth: Auth, *,
                 transport: RequestTransport | None = None) -> AsyncIterator[str | Completion]:
    if not request.messages or not any(message.role == "user" for message in request.messages):
        raise BackendError("missing_user_context")
    if not auth.api_key.get_secret_value():
        raise BackendError("provider_not_configured")
    connection = transport if transport is not None else RequestTransport()
    if model.api == "openai-completions":
        async for item in completions.stream(model, request, auth, connection):
            yield item
        return
    operation = {"openai-responses": responses.responses, "openai-codex-responses": responses.responses,
                 "anthropic-messages": anthropic.anthropic, "google-generative-ai": google.google}.get(model.api)
    if operation is None:
        raise BackendError("model_api_unknown")
    async with httpx.AsyncClient(proxy=connection.proxy or None, trust_env=False,
                                 timeout=connection.timeout_seconds) as client:
        async for item in operation(model, request, auth, connection, client):
            yield item
