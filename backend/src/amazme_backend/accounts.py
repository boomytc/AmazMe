"""Private provider credentials, using Pi's atomic read/modify/write and refresh ownership."""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import re
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import Field, SecretStr

from .common import private_write
from .contracts import (
    BackendError,
    ConfigureProvider,
    Model,
    ModelSelection,
    ProfileConfig,
    ProviderApi,
    ProviderConfig,
    ProviderConfigured,
    ProviderDefinition,
)
from .oauth import OAuthCredential, OAuthStart, OAuthView, refresh


class ApiKeyCredential(Model):
    type: Literal["api_key"] = "api_key"
    key: SecretStr

    def storage(self) -> dict[str, object]:
        return {"type": "api_key", "key": self.key.get_secret_value()}


Credential = Annotated[ApiKeyCredential | OAuthCredential, Field(discriminator="type")]


class LoginRecord(Model):
    request: OAuthStart
    view: OAuthView


class ProviderTransport(Model):
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    name: str = ""
    base_url: str = ""
    api: ProviderApi | None = None
    model_ids: list[str] | None = None


def select_model(config: ProviderConfig, selection: ModelSelection | None, transports: dict[str, ProviderTransport]) -> ProviderConfig:
    """Resolve a provider definition before admission; credential refresh cannot change this endpoint."""
    from .providers import selected_provider, stored_provider

    selected = selection or ModelSelection(provider=config.provider, model=config.model)
    transport = transports.get(selected.provider)
    if transport and transport.model_ids is not None:
        if selected.model not in transport.model_ids:
            raise BackendError("model_not_available")
        chosen = stored_provider(config.model_copy(update={"provider": selected.provider, "model": selected.model}))
    else:
        chosen = selected_provider(config, selected)
    if transport:
        chosen = chosen.model_copy(update={**({"base_url": transport.base_url} if transport.base_url else {}),
            **({"api": transport.api} if transport.api else {})})
    return chosen


class AccountDocument(Model):
    format: Literal[1] = 1
    revision: int = Field(default=0, ge=0)
    credentials: dict[str, Credential] = Field(default_factory=dict)
    uncertain_refresh: list[str] = Field(default_factory=list)
    logins: dict[str, LoginRecord] = Field(default_factory=dict)
    transports: dict[str, ProviderTransport] = Field(default_factory=dict)
    configuration_receipts: dict[str, ConfigurationReceipt] = Field(default_factory=dict)
    configuration_revision: int = 0


class AccountInfo(Model):
    provider: str
    type: Literal["api_key", "oauth"]
    expires_ms: int | None = None
    login_required: bool = False


class AccountsView(Model):
    revision: int
    accounts: list[AccountInfo]


class ConfigurationReceipt(Model):
    digest: str
    view: ProviderConfigured


class AccountStore:
    def __init__(self, profile: Path):
        self.profile = profile
        self.path = profile / "accounts.json"

    @staticmethod
    def _provider(provider: str) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", provider):
            raise BackendError("invalid_provider")

    def read(self) -> AccountDocument:
        if self.path.exists():
            return AccountDocument.model_validate_json(self.path.read_bytes())
        # Preserve the already configured account when the private vault is first written.
        config = ProfileConfig.model_validate_json((self.profile / "config.json").read_bytes())
        key = config.provider.api_key
        credentials: dict[str, Credential] = {}
        if key.get_secret_value():
            credentials[config.provider.provider] = ApiKeyCredential(key=key)
        return AccountDocument(revision=config.credential_revision, credentials=credentials,
            transports={config.provider.provider: ProviderTransport(proxy=config.provider.proxy,
                                                                   headers=config.provider.headers)})

    def write(self, value: AccountDocument) -> None:
        raw = {"format": value.format, "revision": value.revision,
               "credentials": {provider: credential.storage() for provider, credential in value.credentials.items()},
               "uncertain_refresh": value.uncertain_refresh,
               "logins": {key: row.model_dump(mode="json") for key, row in value.logins.items()},
               "transports": {key: row.model_dump() for key, row in value.transports.items()},
               "configuration_revision": value.configuration_revision,
               "configuration_receipts": {key: row.model_dump(mode="json") for key, row in value.configuration_receipts.items()}}
        private_write(self.path, json.dumps(raw))

    @asynccontextmanager
    async def locked(self) -> AsyncGenerator[None]:
        fd = os.open(self.profile / "accounts.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + 35
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise BackendError("credential_busy", status=503) from None
                    await asyncio.sleep(0.025)
            yield
        finally:
            os.close(fd)

    async def ensure(self, guard: Callable[[], Awaitable[None]] | None = None) -> None:
        async with self.locked():
            if guard is not None:
                await guard()
            if not self.path.exists():
                self.write(self.read())

    async def save_transport(self, config: ProviderConfig, guard: Callable[[], Awaitable[None]]) -> None:
        async with self.locked():
            await guard()
            document = self.read()
            current = document.transports.get(config.provider, ProviderTransport())
            updated = current.model_copy(update={"proxy": config.proxy, "headers": config.headers,
                "base_url": config.base_url, "api": config.api})
            if updated != current:
                document.configuration_revision += 1
            document.transports[config.provider] = updated
            self.write(document)

    async def configure_provider(self, value: ConfigureProvider, guard: Callable[[], Awaitable[None]]) -> ProviderConfigured:
        async with self.locked():
            await guard()
            document = self.read()
            digest = hashlib.sha256(value.model_dump_json().encode()).hexdigest()
            previous = document.configuration_receipts.get(value.operation_id)
            if previous:
                if previous.digest != digest:
                    raise BackendError("provider_configuration_conflict")
                return previous.view
            current = document.transports.get(value.provider, ProviderTransport())
            updated = current.model_copy(update=value.model_dump(exclude={"provider", "expected_revision", "operation_id"}))
            if document.configuration_revision != value.expected_revision:
                raise BackendError("provider_configuration_conflict")
            if len(document.configuration_receipts) >= 4096:
                raise BackendError("provider_configuration_capacity", status=429)
            document.transports[value.provider] = updated
            document.configuration_revision += 1
            view = ProviderConfigured(operation_id=value.operation_id, revision=document.configuration_revision,
                credential_revision=document.revision, provider=value.provider)
            document.configuration_receipts[value.operation_id] = ConfigurationReceipt(digest=digest, view=view)
            self.write(document)
            return view

    def provider_definitions(self, document: AccountDocument | None = None) -> list[ProviderDefinition]:
        document = document if document is not None else self.read()
        return [ProviderDefinition(provider=name, name=value.name or name, base_url=value.base_url, api=value.api,
                model_ids=value.model_ids) for name, value in document.transports.items() if value.api and value.base_url]

    def view(self) -> AccountsView:
        return self._view(self.read())

    @staticmethod
    def _view(document: AccountDocument) -> AccountsView:
        return AccountsView(revision=document.revision, accounts=[AccountInfo(provider=provider,
            type=credential.type, expires_ms=credential.expires if isinstance(credential, OAuthCredential) else None,
            login_required=provider in document.uncertain_refresh)
            for provider, credential in sorted(document.credentials.items())])

    async def set(self, provider: str, credential: Credential | None, expected_revision: int,
                  guard: Callable[[], Awaitable[None]] | None = None) -> AccountsView:
        self._provider(provider)
        async with self.locked():
            if guard is not None:
                await guard()
            document = self.read()
            if document.revision != expected_revision:
                raise BackendError("credential_conflict")
            if credential is None:
                document.credentials.pop(provider, None)
            else:
                document.credentials[provider] = credential
            document.uncertain_refresh = [item for item in document.uncertain_refresh if item != provider]
            document.revision += 1
            self.write(document)
            return self.view()

    async def reserve_login(self, request: OAuthStart, view: OAuthView,
                            guard: Callable[[], Awaitable[None]]) -> OAuthView | None:
        async with self.locked():
            await guard()
            document = self.read()
            old = document.logins.get(request.login_id)
            if old is not None:
                if old.request != request:
                    raise BackendError("oauth_login_conflict")
                return old.view
            if document.revision != request.expected_revision:
                raise BackendError("credential_conflict")
            if len(document.logins) >= 4096:
                raise BackendError("oauth_identity_limit")
            document.logins[request.login_id] = LoginRecord(request=request, view=view)
            self.write(document)
            return None

    async def settle_login(self, login_id: str, view: OAuthView) -> None:
        async with self.locked():
            document = self.read()
            document.logins[login_id].view = view
            self.write(document)

    def secrets(self) -> tuple[str, ...]:
        values: set[str] = set()
        for credential in self.read().credentials.values():
            if isinstance(credential, ApiKeyCredential):
                values.add(credential.key.get_secret_value())
            else:
                values.update((credential.access.get_secret_value(), credential.refresh.get_secret_value()))
        values.discard("")
        return tuple(values)

    async def resolve(self, provider: str, *, proxy: str = "") -> Credential | None:
        self._provider(provider)
        async with self.locked():
            document = self.read()
            credential = document.credentials.get(provider)
            if credential is None or isinstance(credential, ApiKeyCredential):
                return credential
            if provider in document.uncertain_refresh:
                raise BackendError("oauth_login_required", status=401)
            if credential.expires > time.time() * 1000:
                return credential
            # Refresh tokens can rotate. Persist intent before sending; an ambiguous refresh is never replayed.
            document.uncertain_refresh.append(provider)
            self.write(document)
            async with httpx.AsyncClient(proxy=proxy or None, trust_env=False, timeout=30) as client:
                renewed = await refresh(client, provider, credential)
            document.credentials[provider] = renewed
            document.uncertain_refresh.remove(provider)
            document.revision += 1
            self.write(document)
            return renewed

    async def configured(self, config: ProviderConfig) -> ProviderConfig:
        transport = self.read().transports.get(config.provider)
        if transport is not None:
            config = config.model_copy(update={"proxy": transport.proxy, "headers": dict(transport.headers)})
        if config.provider == "faux":
            return config.model_copy(update={"api_key": SecretStr("")})
        credential = await self.resolve(config.provider, proxy=config.proxy)
        if credential is None:
            raise BackendError("provider_not_configured")
        if isinstance(credential, ApiKeyCredential):
            return config.model_copy(update={"api_key": credential.key, "auth_type": "api_key"})
        return config.model_copy(update={"api_key": credential.access, "auth_type": "oauth",
            "base_url": credential.base_url or config.base_url})
