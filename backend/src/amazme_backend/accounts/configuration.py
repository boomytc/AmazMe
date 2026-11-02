"""Account configuration and selection against caller-provided catalog values."""
import ipaddress
import re
from collections.abc import Mapping
from urllib.parse import urlsplit

from pydantic import Field

from amazme_backend.accounts.oauth.identity import COPILOT_HEADERS
from amazme_backend.contracts.models import (
    CatalogModel,
    ModelSelection,
    ModelSettings,
    ProviderApi,
    ProviderDefinition,
    UpdateModelSettings,
)
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.profiles.configuration import redact_proxy as _redact_proxy
from amazme_backend.profiles.configuration import selected_provider as _selected_provider
from amazme_backend.profiles.configuration import stored_provider as _stored_provider
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model

_FORBIDDEN_HEADERS = {
    "authorization", "cookie", "host", "content-length", "transfer-encoding", "connection",
    "proxy-authorization", "x-api-key",
}


def request_identity(provider: str) -> dict[str, str]:
    return dict(COPILOT_HEADERS) if provider == "github-copilot" else {}


class ProviderTransport(Model):
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    name: str = ""
    base_url: str = ""
    api: ProviderApi | None = None
    model_ids: list[str] | None = None


def _normalize_proxy(current: str, requested: str) -> str:
    raw = requested.strip()
    if not raw:
        return ""
    if raw == _redact_proxy(current):
        return current
    parts = urlsplit(raw)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.query or parts.fragment:
        raise BackendError("invalid_proxy")
    return parts.geturl()


def _clean_headers(headers: dict[str, str]) -> dict[str, str]:
    if len(headers) > 16:
        raise BackendError("too_many_headers")
    cleaned: dict[str, str] = {}
    for name, value in headers.items():
        if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", name) or name.lower() in _FORBIDDEN_HEADERS:
            raise BackendError("invalid_header")
        if not value or len(value) > 512 or "\r" in value or "\n" in value:
            raise BackendError("invalid_header")
        cleaned[name] = value
    return cleaned


def public_settings(config: ProviderConfig, credential_revision: int = 0) -> ModelSettings:
    return ModelSettings(provider=config.provider, model=config.model, base_url=config.base_url, api=config.api, auth_type=config.auth_type,
                         max_tokens=config.max_tokens, key_configured=bool(config.api_key.get_secret_value()),
                         credential_revision=credential_revision,
                         proxy=_redact_proxy(config.proxy), headers=dict(config.headers), thinking=config.thinking or "off")


def choose_model(current: ProviderConfig, requested: UpdateModelSettings) -> ProviderConfig:
    """Return the next provider config. The stored API key is kept and never taken from the request."""
    transport = {
        "proxy": _normalize_proxy(current.proxy, requested.proxy),
        "headers": _clean_headers(requested.headers),
        "max_tokens": requested.max_tokens,
        **({"thinking": requested.thinking} if requested.thinking is not None else {}),
    }
    if requested.provider == "faux":
        if requested.model != "faux":
            raise BackendError("model_not_available")
        return current.model_copy(update={"provider": "faux", "model": "faux", "base_url": "", **transport})
    if not current.api_key.get_secret_value():
        raise BackendError("provider_not_configured")
    if current.provider != requested.provider:
        raise BackendError("provider_not_configured")
    api = requested.api or current.api
    endpoint = checked_model_endpoint(requested.base_url.strip() or current.base_url)
    return current.model_copy(update={
        "provider": requested.provider, "model": requested.model, "api": api, "base_url": endpoint, **transport,
    })


def checked_model_endpoint(value: str) -> str:
    parts = urlsplit(value)
    try:
        loopback = parts.hostname == "localhost" or ipaddress.ip_address(parts.hostname or "").is_loopback
    except ValueError:
        loopback = False
    if (parts.scheme != "https" and not (parts.scheme == "http" and loopback)) or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise BackendError("invalid_model_endpoint")
    return parts.geturl()


def provider_transport(provider: str, transports: Mapping[str, ProviderTransport], providers: Mapping[str, ProviderDefinition]) -> ProviderTransport | None:
    stored = transports.get(provider)
    builtin = providers.get(provider)
    if builtin is None:
        return stored
    if stored is None:
        return ProviderTransport(name=builtin.name, base_url=builtin.base_url, api=builtin.api, model_ids=builtin.model_ids)
    return stored.model_copy(update={"name": stored.name or builtin.name,
        **({"base_url": builtin.base_url, "api": builtin.api} if not stored.base_url else {})})


def select_model(config: ProviderConfig, selection: ModelSelection | None, transports: Mapping[str, ProviderTransport], *, catalog: Mapping[tuple[str, str], CatalogModel], providers: Mapping[str, ProviderDefinition]) -> ProviderConfig:
    """Resolve a provider definition before admission; credential refresh cannot change this endpoint."""
    selected = selection or ModelSelection(provider=config.provider, model=config.model)
    transport = provider_transport(selected.provider, transports, providers)
    model = catalog.get((selected.provider, selected.model))
    if transport is not None and transport.base_url and transport.api is None and model is None:
        raise BackendError("model_not_available")
    if transport and transport.model_ids is not None:
        if selected.model not in transport.model_ids:
            raise BackendError("model_not_available")
        chosen = _stored_provider(config.model_copy(update={"provider": selected.provider, "model": selected.model}))
        if model is not None:
            chosen = chosen.model_copy(update={"api": model.api, "base_url": model.base_url})
    else:
        chosen = _selected_provider(config, selected, catalog=catalog)
    if model is not None and transport is not None and transport.base_url and transport.api is None:
        chosen = chosen.model_copy(update={"api": model.api})
    if transport:
        chosen = chosen.model_copy(update={**({"base_url": transport.base_url} if transport.base_url else {}),
            **({"api": transport.api} if transport.api else {})})
    return chosen
