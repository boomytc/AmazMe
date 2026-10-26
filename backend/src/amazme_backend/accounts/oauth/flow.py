"""Provider OAuth wire contracts ported from Pi ai/src/auth/oauth (be14d973).

Client IDs, callback addresses and provider request identities intentionally retain Pi's values.
Credentials stay server-side; UI clients receive only URLs, user codes and lifecycle state.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from pydantic import SecretStr, TypeAdapter

from amazme_backend.accounts.oauth.identity import COPILOT_HEADERS
from amazme_backend.contracts.accounts import OAuthStart, OAuthView
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model

JSON = TypeAdapter(dict[str, object])
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"


class OAuthCredential(Model):
    type: Literal["oauth"] = "oauth"
    access: SecretStr
    refresh: SecretStr = SecretStr("")
    expires: int
    client_id: str = ""
    account_id: str = ""
    base_url: str = ""
    scope: str = ""

    def storage(self) -> dict[str, object]:
        return {**self.model_dump(mode="json"), "access": self.access.get_secret_value(),
                "refresh": self.refresh.get_secret_value()}








@dataclass(frozen=True)
class BrowserFlow:
    client_id: str
    authorize_url: str
    token_url: str
    redirect_uri: str
    scopes: str
    margin_ms: int = 0


BROWSER = {
    "anthropic": BrowserFlow("9d1c250a-e61b-44d9-88ed-5944d1962f5e", "https://claude.ai/oauth/authorize",
        "https://platform.claude.com/v1/oauth/token", "http://localhost:53692/callback",
        "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload", 300000),
    "openai-codex": BrowserFlow("app_EMoamEEZ73f0CkXaXp7hrann", "https://auth.openai.com/oauth/authorize",
        "https://auth.openai.com/oauth/token", "http://localhost:1455/auth/callback", "openid profile email offline_access"),
    "openai": BrowserFlow("dynamic_agent_client", "https://auth.openai.com/api/accounts/authorize",
        "https://auth.openai.com/api/accounts/oauth/token", "http://127.0.0.1:1455/auth/callback",
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", 180000),
    "openrouter": BrowserFlow("", "https://openrouter.ai/auth", "https://openrouter.ai/api/v1/auth/keys", "", ""),
}


@dataclass(frozen=True)
class DeviceFlow:
    client_id: str
    device_url: str
    token_url: str
    scope: str = ""
    margin_ms: int = 0


DEVICE = {
    "github-copilot": DeviceFlow("Iv1.b507a08c87ecfe98", "https://github.com/login/device/code",
        "https://github.com/login/oauth/access_token", "read:user"),
    "kimi-coding": DeviceFlow("17e5f671-d194-4dfb-9706-5516cb48c098", "https://auth.kimi.com/api/oauth/device_authorization",
        "https://auth.kimi.com/api/oauth/token"),
    "xai": DeviceFlow("b1a00492-073a-47ea-816f-4c329264a828", "https://auth.x.ai/oauth2/device/code",
        "https://auth.x.ai/oauth2/token", "openid profile email offline_access grok-cli:access api:access", 300000),
    "meta": DeviceFlow("1031625952748946", "https://auth.meta.com/oidc/device/authorization/",
        "https://auth.meta.com/oidc/device/token/"),
}


def required(body: dict[str, object], name: str) -> str:
    value = body.get(name)
    if not isinstance(value, str) or not value:
        raise BackendError("oauth_invalid_response")
    return value


def positive(body: dict[str, object], name: str, default: int | None = None) -> int:
    value = body.get(name, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise BackendError("oauth_invalid_response")
    return int(value)


def trusted_url(value: str, *, https_only: bool = False) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ({"https"} if https_only else {"http", "https"}) or not parts.hostname or parts.username or parts.password:
        raise BackendError("oauth_untrusted_url")
    return value


def token(body: dict[str, object], margin: int = 0, previous: OAuthCredential | None = None, *, default_lifetime: bool = False) -> OAuthCredential:
    refresh = body.get("refresh_token")
    if refresh is None and previous is not None:
        refresh = previous.refresh.get_secret_value()
    if not isinstance(refresh, str):
        raise BackendError("oauth_invalid_response")
    return OAuthCredential(access=SecretStr(required(body, "access_token")), refresh=SecretStr(refresh),
        expires=int(time.time() * 1000) + positive(body, "expires_in", 3600 if default_lifetime else None) * 1000 - margin)


async def post(client: httpx.AsyncClient, url: str, fields: dict[str, str], *,
               as_json: bool = False, headers: dict[str, str] | None = None) -> tuple[int, dict[str, object]]:
    options = {"Accept": "application/json", **(headers or {})}
    try:
        if as_json:
            response = await client.post(url, json=fields, headers=options)
        else:
            response = await client.post(url, data=fields, headers=options)
        try:
            body = JSON.validate_json(response.content)
        except ValueError:
            if response.is_success:
                raise
            body = {}
        return response.status_code, body
    except (httpx.HTTPError, ValueError) as exc:
        # Provider bodies may contain tokens. Never include them in a client error or log.
        raise BackendError("oauth_request_failed", status=503) from exc


async def copilot_token(client: httpx.AsyncClient, github_token: str) -> OAuthCredential:
    response = await client.get("https://api.github.com/copilot_internal/v2/token", headers={
        **COPILOT_HEADERS, "Accept": "application/json", "Authorization": "Bearer " + github_token})
    if not response.is_success:
        raise BackendError("oauth_refresh_failed", status=401 if response.status_code in {401, 403} else 503)
    body = JSON.validate_json(response.content)
    access = required(body, "token")
    proxy = next((part.split("=", 1)[1] for part in access.split(";") if part.startswith("proxy-ep=")), "")
    base = "https://" + proxy.replace("proxy.", "api.", 1) if proxy else "https://api.individual.githubcopilot.com"
    return OAuthCredential(access=SecretStr(access), refresh=SecretStr(github_token),
                           expires=positive(body, "expires_at") * 1000, base_url=trusted_url(base, https_only=True))


async def meta_key(client: httpx.AsyncClient, identity_token: str) -> OAuthCredential:
    status, body = await post(client, "https://api.meta.ai/muse-code/key", {}, as_json=True,
        headers={"Authorization": "Bearer " + identity_token, "x-api-version": "1.0.0"})
    if not 200 <= status < 300:
        raise BackendError("oauth_login_required" if status in {401, 403} else "oauth_refresh_failed", status=503)
    return OAuthCredential(access=SecretStr(required(body, "api_key")), refresh=SecretStr(identity_token),
                           expires=int(time.time() * 1000) + 86400000)


async def refresh(client: httpx.AsyncClient, provider: str, credential: OAuthCredential) -> OAuthCredential:
    if provider == "openrouter":
        return credential
    if provider == "github-copilot":
        return await copilot_token(client, credential.refresh.get_secret_value())
    if provider == "meta":
        return await meta_key(client, credential.refresh.get_secret_value())
    flow = BROWSER.get(provider) or DEVICE.get(provider)
    if flow is None:
        raise BackendError("oauth_provider_unknown")
    fields = {"grant_type": "refresh_token", "client_id": credential.client_id or flow.client_id,
              "refresh_token": credential.refresh.get_secret_value()}
    if provider == "openai":
        if not credential.client_id:
            raise BackendError("oauth_login_required")
        fields["resource"] = "https://api.openai.com/v1"
    # Pi's Anthropic token endpoint uses JSON; the remaining endpoints use form encoding.
    retries = 3 if provider == "kimi-coding" else 0
    status = 503
    for attempt in range(retries + 1):
        if attempt:
            await asyncio.sleep(2 ** (attempt - 1))
        status, body = await post(client, flow.token_url, fields, as_json=provider == "anthropic")
        if 200 <= status < 300:
            result = token(body, flow.margin_ms, credential if provider == "xai" else None, default_lifetime=provider == "xai")
            if provider == "openai":
                scope = required(body, "scope")
                if "chatgpt.tokens.use.direct" not in scope.split():
                    raise BackendError("oauth_scope_missing")
                result.scope = scope
            return result.model_copy(update={"client_id": credential.client_id,
                "account_id": credential.account_id, "base_url": credential.base_url, "scope": result.scope or credential.scope})
        if status != 429 and status < 500:
            break
    raise BackendError("oauth_login_required" if status in {400, 401, 403} else "oauth_refresh_failed", status=503)


@dataclass
class Login:
    request: OAuthStart
    view: OAuthView
    verifier: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    state: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    redirect_uri: str = ""
    device_code: str = ""
    callback: asyncio.Server | None = None
    future: asyncio.Future[str] | None = None
    task: asyncio.Task[None] | None = None
    interval: int = 5

    async def close_callback(self) -> None:
        if self.callback:
            self.callback.close()
            await self.callback.wait_closed()
            self.callback = None

    async def cancel(self) -> None:
        if self.view.phase != "pending":
            return
        self.view.phase = "cancelled"
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.close_callback()

    def parse_input(self, value: str, *, callback: bool = False) -> dict[str, str]:
        raw = value.strip()
        parts = urlsplit(raw)
        if parts.scheme:
            expected = urlsplit(self.redirect_uri)
            if self.request.provider == "openai" and (parts.scheme, parts.netloc, parts.path) != (
                    expected.scheme, expected.netloc, expected.path):
                raise BackendError("oauth_callback_mismatch")
            parsed = {key: values[0] for key, values in parse_qs(parts.query).items()}
        elif "#" in raw:
            code, state = raw.split("#", 1)
            parsed = {"code": code, "state": state}
        elif "code=" in raw:
            parsed = {key: values[0] for key, values in parse_qs(raw).items()}
        else:
            parsed = {"code": raw}
        if self.request.provider != "openrouter":
            state = parsed.get("state")
            if (state and state != self.state) or ((callback or self.request.provider == "openai") and not state):
                raise BackendError("oauth_state_mismatch")
        if not parsed.get("code") or parsed.get("error"):
            raise BackendError("oauth_authorization_failed")
        if self.request.provider == "openai" and not parsed.get("client_id"):
            raise BackendError("oauth_client_id_missing")
        return parsed

    async def callback_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        status = "400 Bad Request"
        try:
            line = await asyncio.wait_for(reader.readline(), 5)
            method, target, _ = line.decode("ascii").split(" ", 2)
            if method != "GET" or urlsplit(target).path != urlsplit(self.redirect_uri).path:
                raise BackendError("oauth_callback_mismatch")
            url = self.redirect_uri.split("?", 1)[0] + "?" + urlsplit(target).query
            self.parse_input(url, callback=True)
            if self.future is not None and not self.future.done():
                self.future.set_result(url)
                status = "200 OK"
        except (BackendError, ValueError, UnicodeError, TimeoutError, asyncio.LimitOverrunError):
            pass
        try:
            body = b"Login received. You may close this window." if status.startswith("200") else b"Invalid login callback."
            writer.write((f"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n"
                          f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").encode() + body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def begin_browser(self) -> None:
        flow = BROWSER[self.request.provider]
        self.redirect_uri = flow.redirect_uri
        if self.request.provider == "anthropic":
            self.state = self.verifier
        if self.request.provider == "openai-codex":
            self.state = secrets.token_hex(16)
        if self.request.provider == "openrouter":
            path, port = "/oauth/callback/" + str(uuid.uuid4()), 0
        else:
            path = urlsplit(self.redirect_uri).path
            port = urlsplit(self.redirect_uri).port or 0
        self.future = asyncio.get_running_loop().create_future()
        copy_code = self.request.provider == "anthropic" and self.request.method == "copy_code"
        if copy_code:
            self.redirect_uri = "https://platform.claude.com/oauth/code/callback"
        try:
            if not copy_code:
                self.callback = await asyncio.start_server(self.callback_request, "127.0.0.1", port, limit=8192)
        except OSError:
            if self.request.provider == "anthropic":
                self.callback = await asyncio.start_server(self.callback_request, "127.0.0.1", 0, limit=8192)
            elif self.request.provider == "openai":
                raise BackendError("oauth_callback_port_in_use") from None
            elif self.request.provider != "openai-codex":
                raise
        if self.callback and self.request.provider in {"anthropic", "openrouter"}:
            actual_port = self.callback.sockets[0].getsockname()[1]
            host = "localhost" if self.request.provider == "anthropic" else "127.0.0.1"
            self.redirect_uri = f"http://{host}:{actual_port}{path}"
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip("=")
        fields = {"response_type": "code", "client_id": flow.client_id, "redirect_uri": self.redirect_uri,
                  "scope": flow.scopes, "state": self.state, "code_challenge": challenge, "code_challenge_method": "S256"}
        if self.request.provider == "anthropic":
            fields["code"] = "true"
        elif self.request.provider == "openrouter":
            fields = {"callback_url": self.redirect_uri, "code_challenge": challenge, "code_challenge_method": "S256"}
        elif self.request.provider == "openai-codex":
            fields.update({"id_token_add_organizations": "true", "codex_cli_simplified_flow": "true", "originator": "pi"})
        elif self.request.provider == "openai":
            fields.update({"resource": "https://api.openai.com/v1", "agent_name_hint": "Pi",
                           "ext_agent_host_id": str(uuid.uuid4()), "nonce": secrets.token_urlsafe(32)})
        self.view.url = flow.authorize_url + "?" + urlencode(fields)

    async def exchange(self, client: httpx.AsyncClient, value: str) -> OAuthCredential:
        parsed = self.parse_input(value)
        flow = BROWSER[self.request.provider]
        if self.request.provider == "openrouter":
            fields = {"code": parsed["code"], "code_verifier": self.verifier, "code_challenge_method": "S256"}
        else:
            fields = {"grant_type": "authorization_code", "client_id": parsed.get("client_id", flow.client_id),
                      "code": parsed["code"], "redirect_uri": self.redirect_uri, "code_verifier": self.verifier}
            if self.request.provider == "anthropic":
                fields["state"] = self.state
            elif self.request.provider == "openai":
                fields["resource"] = "https://api.openai.com/v1"
        status, body = await post(client, flow.token_url, fields, as_json=self.request.provider in {"anthropic", "openrouter"})
        if not 200 <= status < 300:
            raise BackendError("oauth_exchange_failed", status=503)
        if self.request.provider == "openrouter":
            return OAuthCredential(access=SecretStr(required(body, "key")), expires=9007199254740991)
        credential = token(body, flow.margin_ms)
        if self.request.provider == "openai":
            if "chatgpt.tokens.use.direct" not in required(body, "scope").split() or not required(body, "id_token"):
                raise BackendError("oauth_scope_missing")
            credential.client_id, credential.scope = parsed["client_id"], required(body, "scope")
        if self.request.provider == "openai-codex":
            try:
                payload = credential.access.get_secret_value().split(".")[1]
                claims = JSON.validate_json(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
                auth = JSON.validate_python(claims.get("https://api.openai.com/auth"))
                credential.account_id = required(auth, "chatgpt_account_id")
            except (ValueError, IndexError) as exc:
                raise BackendError("oauth_account_id_missing") from exc
        return credential

    async def begin_device(self, client: httpx.AsyncClient) -> None:
        provider = self.request.provider
        if provider == "openai-codex":
            status, body = await post(client, "https://auth.openai.com/api/accounts/deviceauth/usercode",
                                      {"client_id": BROWSER[provider].client_id}, as_json=True)
            if not 200 <= status < 300:
                raise BackendError("oauth_device_failed", status=503)
            self.device_code = required(body, "device_auth_id")
            self.view.user_code = required(body, "user_code")
            self.view.url = "https://auth.openai.com/codex/device"
            raw = body.get("interval", 5)
            try:
                self.interval = max(0, int(str(raw)))
            except ValueError:
                raise BackendError("oauth_invalid_response") from None
            self.view.expires_ms = int(time.time() * 1000) + 900000
            return
        flow = DEVICE[provider]
        fields = {"client_id": flow.client_id}
        if flow.scope:
            fields["scope"] = flow.scope
        if provider == "xai":
            fields["referrer"] = "pi"
        headers = {"User-Agent": COPILOT_HEADERS["User-Agent"]} if provider == "github-copilot" else None
        status, body = await post(client, flow.device_url, fields, headers=headers)
        if not 200 <= status < 300:
            raise BackendError("oauth_device_failed", status=503)
        self.device_code = required(body, "device_code")
        self.view.user_code = required(body, "user_code")
        uri = body.get("verification_uri_complete") or body.get("verification_uri")
        if not isinstance(uri, str):
            raise BackendError("oauth_invalid_response")
        self.view.url = trusted_url(uri, https_only=provider == "xai")
        self.interval = positive(body, "interval", 5)
        self.view.expires_ms = int(time.time() * 1000) + positive(body, "expires_in", 900) * 1000

    async def poll_device(self, client: httpx.AsyncClient) -> OAuthCredential:
        provider = self.request.provider
        # Pi's RFC 8628 providers wait before the first request; Codex's custom device endpoint does not.
        wait_first = provider != "openai-codex"
        while time.time() * 1000 < self.view.expires_ms:
            if wait_first:
                await asyncio.sleep(self.interval)
            wait_first = True
            if provider == "openai-codex":
                status, body = await post(client, "https://auth.openai.com/api/accounts/deviceauth/token",
                    {"device_auth_id": self.device_code, "user_code": self.view.user_code}, as_json=True)
                if 200 <= status < 300:
                    self.verifier = required(body, "code_verifier")
                    self.redirect_uri = "https://auth.openai.com/deviceauth/callback"
                    return await self.exchange(client, required(body, "authorization_code"))
                if status in {403, 404}:
                    continue
            else:
                flow = DEVICE[provider]
                headers = {"User-Agent": COPILOT_HEADERS["User-Agent"]} if provider == "github-copilot" else None
                status, body = await post(client, flow.token_url, {"client_id": flow.client_id,
                    "device_code": self.device_code, "grant_type": DEVICE_GRANT}, headers=headers)
                if 200 <= status < 300 and isinstance(body.get("access_token"), str):
                    if provider == "github-copilot":
                        return await copilot_token(client, required(body, "access_token"))
                    if provider == "meta":
                        return await meta_key(client, required(body, "access_token"))
                    return token(body, flow.margin_ms, default_lifetime=provider == "xai")
            code = body.get("error")
            if code == "authorization_pending":
                continue
            if code == "slow_down":
                self.interval = max(self.interval + 5, positive(body, "interval", self.interval + 5))
                continue
            raise BackendError("oauth_login_denied" if code == "access_denied" else "oauth_device_failed")
        raise BackendError("oauth_login_expired")
