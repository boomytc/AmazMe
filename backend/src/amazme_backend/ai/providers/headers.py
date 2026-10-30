"""Merge resolved request identity with protocol-derived headers."""
import re
from collections.abc import Mapping

from amazme_backend.ai.catalog import INDEX
from amazme_backend.ai.types import Auth, ModelRequest, ModelSpec, RequestTransport
from amazme_backend.shared.errors import BackendError

_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_INVALID_VALUE = re.compile(r"[^\t\x20-\x7e]")


def merge_headers(*sources: Mapping[str, str]) -> dict[str, str]:
    """Later values win case-insensitively; preserve the first spelling for SDK defaults."""
    headers: dict[str, str] = {}
    names: dict[str, str] = {}
    for source in sources:
        for name, value in source.items():
            if _NAME.fullmatch(name) is None or _INVALID_VALUE.search(value) is not None:
                raise BackendError("model_headers_invalid", "模型请求头无效，请检查名称和值。", status=400)
            key = names.setdefault(name.lower(), name)
            headers[key] = value.strip(" \t")
    return headers


def base_headers(config: ModelSpec, request: ModelRequest, auth: Auth, transport: RequestTransport) -> dict[str, str]:
    metadata = INDEX.get((config.provider, config.model))
    identity = {'Authorization': 'Bearer ' + auth.api_key.get_secret_value()}
    if config.provider == 'github-copilot':
        identity.update({'X-Initiator': 'user' if request.messages[-1].role == 'user' else 'agent',
                        'Openai-Intent': 'conversation-edits'})
        if any(message.images for message in request.messages):
            identity['Copilot-Vision-Request'] = 'true'
    return merge_headers(metadata.headers if metadata else {}, transport.headers, auth.headers, identity)
