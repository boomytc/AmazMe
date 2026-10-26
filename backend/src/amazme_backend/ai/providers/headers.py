"""Merge resolved request identity with protocol-derived headers."""
from amazme_backend.ai.catalog import INDEX
from amazme_backend.ai.types import Auth, ModelRequest, ModelSpec, RequestTransport


def base_headers(config: ModelSpec, request: ModelRequest, auth: Auth, transport: RequestTransport) -> dict[str, str]:
    metadata = INDEX.get((config.provider, config.model))
    headers = {**(metadata.headers if metadata else {}), **transport.headers, **auth.headers}
    if config.provider == 'github-copilot':
        headers.update({'X-Initiator': 'user' if request.messages[-1].role == 'user' else 'agent',
                        'Openai-Intent': 'conversation-edits'})
        if any(message.images for message in request.messages):
            headers['Copilot-Vision-Request'] = 'true'
    headers['Authorization'] = 'Bearer ' + auth.api_key.get_secret_value()
    return headers
