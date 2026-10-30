from __future__ import annotations

import asyncio
import time
from contextlib import aclosing

import httpx
from pydantic import SecretStr

from amazme_backend.accounts.configuration import (
    checked_model_endpoint,
    choose_model,
    public_settings,
    request_identity,
    select_model,
)
from amazme_backend.accounts.oauth.flow import BROWSER, DEVICE
from amazme_backend.accounts.oauth.flow import Login as OAuthLogin
from amazme_backend.accounts.store import AccountDocument, AccountStore, ApiKeyCredential
from amazme_backend.agent.model import CATALOG, stream
from amazme_backend.ai.catalog import SELECTION_INDEX
from amazme_backend.ai.classification.catalog import MODELS as CLASSIFIER_MODELS
from amazme_backend.ai.classification.types import ClassifierCatalog
from amazme_backend.ai.types import Auth, Completion
from amazme_backend.contracts.accounts import (
    AccountsView,
    ConfigureProvider,
    CredentialUpdate,
    OAuthInput,
    OAuthStart,
    OAuthView,
    ProviderCheck,
    ProviderCheckRequest,
    ProviderConfigured,
)
from amazme_backend.contracts.models import (
    CatalogModel,
    Message,
    ModelCatalog,
    ModelScope,
    ModelScopeRequest,
    ModelSelection,
    ModelSettings,
    UpdateModelSettings,
)
from amazme_backend.contracts.sessions import SessionModel
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.shared.errors import BackendError


class AccountOperations:
    def __init__(self, lifecycle: HostLifecycle):
        self.lifecycle = lifecycle
        self.accounts = AccountStore(lifecycle.profile.account_path)
        self.provider_lock = asyncio.Lock()
        self.provider_checks: set[str] = set()
        self.oauth_logins: dict[str, OAuthLogin] = {}

    async def write_guard(self) -> None:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)

    def account_list(self) -> AccountsView:
        return self.accounts.view()

    def classifier_catalog(self) -> ClassifierCatalog:
        return ClassifierCatalog(models=CLASSIFIER_MODELS)

    async def update_account(self, provider: str, value: CredentialUpdate) -> AccountsView:
        await self.write_guard()
        key = value.api_key.get_secret_value()
        if (
            value.clear
            and key
            or (not value.clear and (not key or len(key) > 512 or any((char in key for char in "\r\n\x00"))))
        ):
            raise BackendError("invalid_credential")
        async with self.provider_lock:
            saved = await self.accounts.set(
                provider,
                None if value.clear else ApiKeyCredential(key=value.api_key),
                value.expected_revision,
                self.write_guard,
            )
            self.lifecycle.profile.reload_provider()
            if self.lifecycle.profile.config.provider.provider == provider:
                chosen = self.lifecycle.profile.config.provider.model_copy(
                    update={"api_key": SecretStr(""), "auth_type": "api_key"}
                )
                self.lifecycle.profile.save_provider(chosen, credential_revision=saved.revision)
            return saved

    async def start_oauth(self, value: OAuthStart) -> OAuthView:
        await self.write_guard()
        if value.provider not in BROWSER and value.provider not in DEVICE:
            raise BackendError("oauth_provider_unknown")
        if value.method == "copy_code" and value.provider != "anthropic":
            raise BackendError("oauth_method_unknown")
        if value.method == "device_code" and value.provider not in {*DEVICE, "openai-codex"}:
            raise BackendError("oauth_method_unknown")
        old = self.oauth_logins.get(value.login_id)
        if old is not None:
            if old.request != value:
                raise BackendError("oauth_login_conflict")
            return old.view
        for key in list(self.oauth_logins):
            if self.oauth_logins[key].view.phase != "pending":
                del self.oauth_logins[key]
        if len(self.oauth_logins) >= 64:
            raise BackendError("oauth_login_limit")
        view = OAuthView(
            login_id=value.login_id,
            provider=value.provider,
            phase="pending",
            expires_ms=int(time.time() * 1000) + 300000,
        )
        async with self.provider_lock:
            if value.login_id in self.oauth_logins:
                login = self.oauth_logins[value.login_id]
                if login.request != value:
                    raise BackendError("oauth_login_conflict")
                return login.view
            existing = await self.accounts.reserve_login(value, view, self.write_guard)
            if existing is not None:
                return (
                    existing.model_copy(update={"phase": "unknown", "error": "oauth_login_interrupted"})
                    if existing.phase == "pending"
                    else existing
                )
        login = OAuthLogin(value, view)
        self.oauth_logins[value.login_id] = login
        login.task = asyncio.create_task(self._run_oauth(login))
        return view

    def oauth_view(self, login_id: str) -> OAuthView:
        login = self.oauth_logins.get(login_id)
        if login is None:
            saved = self.accounts.read().logins.get(login_id)
            if saved is None:
                raise BackendError("oauth_login_missing", status=404)
            return (
                saved.view.model_copy(update={"phase": "unknown", "error": "oauth_login_interrupted"})
                if saved.view.phase == "pending"
                else saved.view
            )
        return login.view

    async def oauth_input(self, login_id: str, value: OAuthInput) -> OAuthView:
        await self.write_guard()
        login = self.oauth_logins.get(login_id)
        if login is None:
            raise BackendError("oauth_login_missing", status=404)
        if login.view.phase != "pending":
            return login.view
        login.parse_input(value.value.get_secret_value())
        if login.future is None:
            raise BackendError("oauth_input_not_ready")
        if not login.future.done():
            login.future.set_result(value.value.get_secret_value())
        return login.view

    async def cancel_oauth(self, login_id: str) -> OAuthView:
        login = self.oauth_logins.get(login_id)
        if login is None:
            view = self.oauth_view(login_id)
            if view.phase == "unknown":
                view.phase = "cancelled"
                await self.accounts.settle_login(login_id, view)
            return view
        if login.view.phase == "pending":
            await login.cancel()
            await self.accounts.settle_login(login_id, login.view)
        return login.view

    async def _oauth_request_guard(self, _request: httpx.Request) -> None:
        await self.write_guard()

    async def _run_oauth(self, login: OAuthLogin) -> None:
        try:
            self.lifecycle.profile.reload_provider()
            async with httpx.AsyncClient(
                proxy=self.lifecycle.profile.config.provider.proxy or None,
                trust_env=False,
                timeout=30,
                event_hooks={"request": [self._oauth_request_guard]},
            ) as client:
                if login.request.provider in DEVICE or login.request.method == "device_code":
                    await login.begin_device(client)
                    credential = await login.poll_device(client)
                else:
                    await login.begin_browser()
                    assert login.future is not None
                    value = await asyncio.wait_for(login.future, 300)
                    credential = await login.exchange(client, value)
                async with self.provider_lock:
                    saved = await self.accounts.set(
                        login.request.provider, credential, login.request.expected_revision, self.write_guard
                    )
                    self.lifecycle.profile.reload_provider()
                    if self.lifecycle.profile.config.provider.provider == login.request.provider:
                        chosen = self.lifecycle.profile.config.provider.model_copy(
                            update={"api_key": SecretStr(""), "auth_type": "oauth"}
                        )
                        self.lifecycle.profile.save_provider(chosen, credential_revision=saved.revision)
                    login.view.phase = "complete"
        except asyncio.CancelledError:
            login.view.phase = "cancelled"
        except TimeoutError:
            login.view.phase, login.view.error = ("expired", "oauth_login_expired")
        except Exception as exc:
            login.view.phase = "failed"
            login.view.error = exc.code if isinstance(exc, BackendError) else "oauth_login_failed"
        finally:
            await login.close_callback()
            login.verifier, login.state, login.device_code = ("", "", "")
            login.future = None
            try:
                await self.accounts.settle_login(login.request.login_id, login.view)
            except (BackendError, OSError, ValueError):
                login.view.phase, login.view.error = ("unknown", "oauth_storage_unconfirmed")

    def model_catalog(self) -> ModelCatalog:
        self.lifecycle.admit()
        self.lifecycle.profile.reload_provider()
        document = self.accounts.read()
        definitions = {item.provider: item for item in self.accounts.provider_definitions(document)}
        models: list[CatalogModel] = []
        for item in CATALOG:
            definition = definitions.get(item.provider)
            if definition and definition.model_ids is not None and (item.model not in definition.model_ids):
                continue
            models.append(
                item.model_copy(update={"base_url": definition.base_url, "api": definition.api})
                if definition
                else item
            )
        for definition in definitions.values():
            for name in definition.model_ids or []:
                if not any((item.provider == definition.provider and item.model == name for item in models)):
                    models.append(
                        CatalogModel(
                            provider=definition.provider,
                            model=name,
                            label=f"{definition.name} · {name}",
                            api=definition.api,
                            base_url=definition.base_url,
                            endpoint_editable=True,
                        )
                    )
        current = self._published_model(document)
        if not any((item.provider == current.provider and item.model == current.model for item in models)):
            models.append(
                CatalogModel(
                    provider=current.provider,
                    model=current.model,
                    label=current.model,
                    api=current.api,
                    base_url=current.base_url,
                    endpoint_editable=True,
                )
            )
        return ModelCatalog(
            models=models,
            current=current,
            providers=list(definitions.values()),
            configuration_revision=document.configuration_revision,
        )

    async def configure_provider(self, value: ConfigureProvider) -> ProviderConfigured:
        self.lifecycle.admit()
        if value.provider == "faux" or (
            not value.model_ids and (not any((item.provider == value.provider for item in CATALOG)))
        ):
            raise BackendError("provider_models_required")
        if value.api not in {
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "google-generative-ai",
        }:
            raise BackendError("provider_configuration_readonly")
        checked_model_endpoint(value.base_url)
        async with self.provider_lock:
            self.lifecycle.profile.reload_provider()
            if value.operation_id not in self.accounts.read().configuration_receipts:
                if (
                    value.provider == self.lifecycle.profile.config.provider.provider
                    and value.model_ids is not None
                    and (self.lifecycle.profile.config.provider.model not in value.model_ids)
                ):
                    raise BackendError("default_model_not_available")
            return await self.accounts.configure_provider(value, self.write_guard)

    async def check_provider(self, value: ProviderCheckRequest) -> ProviderCheck:
        self.lifecycle.admit()
        document = self.accounts.read()
        result, send = await self.lifecycle.store.begin_provider_check(
            value, document.configuration_revision, document.revision
        )
        if not send:
            return (
                result.model_copy(update={"phase": "pending"})
                if value.operation_id in self.provider_checks
                else result
            )
        self.provider_checks.add(value.operation_id)
        failed: list[str] = []
        try:
            self.lifecycle.profile.reload_provider()
            base = self.lifecycle.profile.config.provider
            for model in dict.fromkeys(value.model_ids):
                try:
                    await self.write_guard()
                    selected = select_model(
                        base,
                        ModelSelection(provider=value.provider, model=model),
                        document.transports,
                        catalog=SELECTION_INDEX,
                    )
                    configured = await self.accounts.configured(
                        selected.model_copy(update={"max_tokens": 16, "thinking": "off"})
                    )
                    current = self.accounts.read()
                    if (
                        current.revision != document.revision
                        or current.configuration_revision != document.configuration_revision
                    ):
                        raise BackendError("provider_configuration_changed")
                    completed = False
                    async with asyncio.timeout(30):
                        async with aclosing(stream(
                            configured,
                            [Message(role="user", content="Reply OK.")],
                            auth=Auth(api_key=configured.api_key, auth_type=configured.auth_type,
                                      headers=request_identity(configured.provider)),
                        )) as response:
                            async for item in response:
                                if isinstance(item, Completion):
                                    completed = True
                    if not completed:
                        failed.append(model)
                except (BackendError, TimeoutError, httpx.HTTPError):
                    failed.append(model)
            result = result.model_copy(
                update={"phase": "done", "checked_at": int(time.time() * 1000), "failed": failed}
            )
            return await self.lifecycle.store.finish_provider_check(result)
        finally:
            self.provider_checks.discard(value.operation_id)

    def model_scope(self, value: ModelScopeRequest) -> ModelScope:
        from amazme_backend.ai.selection import resolve_scope

        catalog = self.model_catalog()
        if not any(
            (
                (item.provider, item.model) == (catalog.current.provider, catalog.current.model)
                for item in catalog.models
            )
        ):
            catalog.models.append(
                CatalogModel(
                    provider=catalog.current.provider,
                    model=catalog.current.model,
                    label=catalog.current.model,
                    api=catalog.current.api,
                    base_url=catalog.current.base_url,
                    endpoint_editable=True,
                )
            )
        return resolve_scope(value, catalog.models)

    async def session_model(self, session_id: str) -> SessionModel:
        self.lifecycle.admit()
        found = await self.lifecycle.store.session_model(session_id)
        if found is None:
            raise BackendError("session_model_missing", status=404)
        return found

    async def save_session_model(self, value: SessionModel) -> SessionModel:
        self.lifecycle.admit()
        async with self.provider_lock:
            if await self.lifecycle.store.active_update():
                raise BackendError("update_frozen", status=503)
            self.lifecycle.profile.reload_provider()
            select_model(
                self.lifecycle.profile.config.provider,
                ModelSelection(provider=value.provider, model=value.model),
                self.accounts.read().transports,
                catalog=SELECTION_INDEX,
            )
            return await self.lifecycle.store.save_session_model(value)

    def _published_model(self, document: AccountDocument | None = None) -> ModelSettings:
        document = document if document is not None else self.accounts.read()
        credential = document.credentials.get(self.lifecycle.profile.config.provider.provider)
        transport = document.transports.get(self.lifecycle.profile.config.provider.provider)
        key = (
            credential.key
            if isinstance(credential, ApiKeyCredential)
            else credential.access
            if credential is not None
            else SecretStr("")
        )
        configured = select_model(
            self.lifecycle.profile.config.provider, None, document.transports, catalog=SELECTION_INDEX
        ).model_copy(
            update={
                "api_key": key,
                "auth_type": credential.type if credential is not None else "api_key",
                "proxy": transport.proxy if transport else self.lifecycle.profile.config.provider.proxy,
                "headers": transport.headers if transport else self.lifecycle.profile.config.provider.headers,
            }
        )
        return public_settings(configured, document.revision)

    async def update_model(self, value: UpdateModelSettings) -> ModelSettings:
        self.lifecycle.admit()
        async with self.provider_lock:
            if await self.lifecycle.store.active_update():
                raise BackendError("update_frozen", status=503)
            self.lifecycle.profile.reload_provider()
            select_model(
                self.lifecycle.profile.config.provider.model_copy(
                    update={"provider": value.provider, "model": value.model}
                ),
                None,
                self.accounts.read().transports,
                catalog=SELECTION_INDEX,
            )
            await self.accounts.ensure(self.write_guard)
            target = self.lifecycle.profile.config.provider.model_copy(update={"provider": value.provider})
            target = await self.accounts.configured(target)
            requested = value.model_copy(
                update={
                    key: getattr(target, key)
                    for key in ("proxy", "headers", "max_tokens")
                    if key not in value.model_fields_set
                }
            )
            chosen = choose_model(target, requested, catalog=SELECTION_INDEX)
            await self.write_guard()
            await self.accounts.save_transport(chosen, self.write_guard)
            persisted = chosen.model_copy(update={"api_key": SecretStr("")})
            self.lifecycle.profile.save_provider(persisted, credential_revision=self.accounts.read().revision)
            return self._published_model()

    async def replace_credential(self, value: CredentialUpdate) -> ModelSettings:
        """Replace or clear the stored key. A stale revision cannot overwrite a newer key."""
        self.lifecycle.admit()
        key = value.api_key.get_secret_value()
        if value.clear:
            if key:
                raise BackendError("credential_conflict")
            key = ""
        elif not key or len(key) > 512 or any((character in key for character in "\r\n\x00")):
            raise BackendError("invalid_credential")
        async with self.provider_lock:
            if await self.lifecycle.store.active_update():
                raise BackendError("update_frozen", status=503)
            self.lifecycle.profile.reload_provider()
            saved = await self.accounts.set(
                self.lifecycle.profile.config.provider.provider,
                ApiKeyCredential(key=SecretStr(key)) if key else None,
                value.expected_revision,
                self.write_guard,
            )
            chosen = self.lifecycle.profile.config.provider.model_copy(
                update={"api_key": SecretStr(""), "auth_type": "api_key"}
            )
            self.lifecycle.profile.save_provider(chosen, credential_revision=saved.revision)
            return self._published_model()

    def secrets(self) -> tuple[str, ...]:
        return self.accounts.secrets()

    def web_key(self) -> str:
        provider = self.lifecycle.profile.config.provider
        if provider.provider != "deepseek":
            return ""
        credential = self.accounts.read().credentials.get("deepseek")
        return credential.key.get_secret_value() if isinstance(credential, ApiKeyCredential) else ""
