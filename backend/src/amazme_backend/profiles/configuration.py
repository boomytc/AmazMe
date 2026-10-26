"""Pure profile model snapshots: public configuration, explicit catalog and credential redaction."""
from collections.abc import Mapping
from urllib.parse import urlsplit

from pydantic import SecretStr

from amazme_backend.contracts.models import CatalogModel, ModelSelection
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.shared.errors import BackendError


def redact_proxy(proxy: str) -> str:
    if not proxy:
        return ""
    parts = urlsplit(proxy)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    if parts.port:
        host = f"{host}:{parts.port}"
    return f"{parts.scheme}://{host}"


def stored_provider(config: ProviderConfig) -> ProviderConfig:
    """Drop credentials before a run record or event is written."""
    return config.model_copy(update={"api_key": SecretStr(""), "proxy": redact_proxy(config.proxy), "headers": {}})


def selected_provider(config: ProviderConfig, selection: ModelSelection | None, *, catalog: Mapping[tuple[str, str], CatalogModel]) -> ProviderConfig:
    """Capture public model configuration; credentials are resolved only at invocation."""
    if selection is None or (config.provider, config.model) == (selection.provider, selection.model):
        return stored_provider(config)
    if selection.provider == "faux" and selection.model == "faux":
        return stored_provider(config.model_copy(update={"provider":"faux", "model":"faux", "base_url":""}))
    model = catalog.get((selection.provider, selection.model))
    if model is None:
        raise BackendError("model_not_available")
    return stored_provider(config.model_copy(update={"provider":model.provider, "model":model.model,
        "api":model.api, "base_url":model.base_url, "auth_type":"api_key", "proxy":"", "headers":{}}))
