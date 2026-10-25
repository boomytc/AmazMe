"""Pi MCP credentials and explicit loopback sign-in, using the pinned OAuth protocol client."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import fcntl
import hashlib
import json
import os
import secrets
import sqlite3
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit, urlunsplit

import httpx
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import (
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthMetadata,
    OAuthToken,
    ProtectedResourceMetadata,
)
from pydantic import AnyUrl, TypeAdapter

from . import mcp_management
from .accounts import AccountStore, ApiKeyCredential
from .common import Profile, private_write
from .contracts import (
    BackendError,
    McpHttpSettings,
    McpLaunch,
    McpLoginRequest,
    McpOAuthSettings,
    mcp_secure_url,
)
from .host_store import HostStore
from .mcp_management import expand_reference
from .oauth import OAuthView


def resolve_values(values: dict[str, str], cwd: str, expand: bool = True) -> dict[str, str]:
    from .mcp_gate import launch_environment

    plain = {key: expand_reference(value) if expand else value for key, value in values.items() if not value.startswith("!")}
    commands = {key: value[1:] for key, value in values.items() if value.startswith("!")}
    resolved = launch_environment(McpLaunch(command=":", environment=plain, environment_commands=commands), "/bin/sh", cwd)
    return {key: resolved[key] for key in values}


class TokenStore:
    def __init__(self, profile: Profile, name: str, settings: McpHttpSettings, redirect: str = ""):
        self.settings = settings.oauth or McpOAuthSettings()
        key = hashlib.sha256(json.dumps([name, settings.url, self.settings.client_id, self.settings.registration]).encode()).hexdigest()
        directory = profile.account_path / "mcp-auth"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / (key + ".json")
        self.redirect = redirect
        self.authorizing = False
        self.guard: Callable[[], Awaitable[None]] | None = None

    def read(self) -> dict[str, object]:
        if not self.path.exists():
            return {}
        return TypeAdapter(dict[str, object]).validate_json(self.path.read_bytes())

    def save(self, **changes: object) -> None:
        private_write(self.path, json.dumps({**self.read(), **changes}))

    @asynccontextmanager
    async def locked(self) -> AsyncGenerator[None]:
        fd = os.open(self.path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + 35
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise BackendError("mcp_credential_busy", status=503) from None
                    await asyncio.sleep(.025)
            yield
        finally:
            os.close(fd)

    async def get_tokens(self) -> OAuthToken | None:
        document = self.read()
        if self.authorizing or document.get("uncertain"):
            return None
        if not document.get("tokens"):
            return None
        token = OAuthToken.model_validate(document["tokens"])
        expires = document.get("expires")
        return token.model_copy(update={"expires_in": max(0, int(expires - time.time()))}) if isinstance(expires, (int, float)) else token

    async def set_tokens(self, tokens: OAuthToken) -> None:
        if self.guard:
            await self.guard()
        self.save(tokens=tokens.model_dump(mode="json"), expires=time.time() + tokens.expires_in if tokens.expires_in is not None else None, uncertain=False)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        if self.settings.client_id:
            return OAuthClientInformationFull(client_id=self.settings.client_id, client_secret=self.settings.client_secret or None,
                redirect_uris=[AnyUrl(self.redirect)] if self.redirect else None,
                token_endpoint_auth_method="client_secret_post" if self.settings.client_secret else "none")
        value = self.read().get("client")
        return OAuthClientInformationFull.model_validate(value) if value else None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        if self.guard:
            await self.guard()
        self.save(client=client_info.model_dump(mode="json"), redirect=self.redirect)


class McpAuth(OAuthClientProvider):
    requires_response_body = False

    def __init__(self, settings: McpHttpSettings, store: TokenStore, *,
                 redirect: Callable[[str], Awaitable[None]] | None = None,
                 callback: Callable[[], Awaitable[tuple[str, str | None]]] | None = None):
        options = store.settings
        metadata = OAuthClientMetadata(redirect_uris=[AnyUrl(store.redirect)] if store.redirect else None,
            client_name=options.client_name, scope=options.scope or None,
            token_endpoint_auth_method="client_secret_post" if options.client_secret else "none")
        super().__init__(settings.url, metadata, store, redirect_handler=redirect, callback_handler=callback,
                         timeout=15, client_metadata_url="https://pi.dev/oauth/client.json" if options.registration == "cimd" else None)
        self.store, self.interactive = store, redirect is not None
        self.issuer_required = False
        self.expected_issuer = ""

    async def _perform_authorization_code_grant(self) -> tuple[str, str]:
        if not self.interactive:
            raise BackendError("mcp_oauth_authorization_required", status=401)
        metadata = self.context.oauth_metadata
        if self.store.settings.scope:
            self.context.client_metadata.scope = self.store.settings.scope
        if self.store.settings.registration == "cimd":
            if not metadata or not metadata.client_id_metadata_document_supported or "none" not in (metadata.token_endpoint_auth_methods_supported or []):
                raise BackendError("mcp_cimd_not_supported")
            redirect = self.store.redirect
            client_id = "https://pi.dev/oauth/client.json"
            if not self.issuer_required:
                callback_id = callback_id_for(self.context.server_url)
                parts = urlsplit(redirect)
                redirect = urlunsplit((parts.scheme, parts.netloc, "/callback/" + callback_id, "", ""))
                client_id = f"https://pi.dev/oauth/{callback_id}/client.json"
            self.context.client_metadata.redirect_uris = [AnyUrl(redirect)]
            self.context.client_info = OAuthClientInformationFull(client_id=client_id, redirect_uris=[AnyUrl(redirect)], token_endpoint_auth_method="none")
            await self.store.set_client_info(self.context.client_info)
        return await super()._perform_authorization_code_grant()

    async def async_auth_flow(self, request: httpx.Request) -> AsyncGenerator[httpx.Request, httpx.Response]:
        async with self.store.locked():
            document = self.store.read()
            self.issuer_required = document.get("issuer_required") is True
            self.expected_issuer = str(document.get("issuer", ""))
            if not self.interactive and document.get("uncertain"):
                raise BackendError("mcp_oauth_authorization_required", status=401)
            if not self.interactive and not document.get("tokens"):
                response = yield request
                if response.status_code in {401, 403}:
                    raise BackendError("mcp_oauth_authorization_required", status=401)
                return
            self._initialized = False
            if document.get("metadata"):
                self.context.oauth_metadata = OAuthMetadata.model_validate(document["metadata"])
            if document.get("resource"):
                self.context.protected_resource_metadata = ProtectedResourceMetadata.model_validate(document["resource"])
            flow = super().async_auth_flow(request)
            try:
                outgoing = await anext(flow)
                while True:
                    if outgoing is not request:
                        refreshing = outgoing.method == "POST" and b"grant_type=refresh_token" in outgoing.content
                        if not self.interactive and not refreshing:
                            raise BackendError("mcp_oauth_authorization_required", status=401)
                        mcp_secure_url(str(outgoing.url))
                        if self.store.settings.metadata_url and outgoing.method == "GET" and "/.well-known/" in outgoing.url.path and "oauth-protected-resource" not in outgoing.url.path:
                            outgoing = httpx.Request("GET", self.store.settings.metadata_url, headers=outgoing.headers)
                        outgoing.extensions["timeout"] = {"connect": 15, "read": 15, "write": 15, "pool": 15}
                        if self.store.settings.registration == "cimd" and self.context.oauth_metadata and str(outgoing.url) == str(self.context.oauth_metadata.registration_endpoint):
                            raise BackendError("mcp_cimd_not_supported")
                        if refreshing:
                            self.store.save(uncertain=True)
                    response = yield outgoing
                    if outgoing is not request:
                        await response.aread()
                        if response.is_success and outgoing.method == "GET":
                            metadata = TypeAdapter(dict[str, object]).validate_json(response.content)
                            if "authorization_endpoint" in metadata and isinstance(metadata.get("issuer"), str):
                                self.issuer_required = metadata.get("authorization_response_iss_parameter_supported") is True
                                self.expected_issuer = str(metadata["issuer"])
                    outgoing = await flow.asend(response)
            except StopAsyncIteration:
                pass
            finally:
                await flow.aclose()
                self.store.save(metadata=self.context.oauth_metadata.model_dump(mode="json") if self.context.oauth_metadata else None,
                                resource=self.context.protected_resource_metadata.model_dump(mode="json") if self.context.protected_resource_metadata else None,
                                issuer_required=self.issuer_required, issuer=self.expected_issuer)


async def http_settings(settings: McpHttpSettings, profile: Profile, name: str, cwd: str, *, expand: bool = False) -> tuple[dict[str, str], McpAuth | None]:
    values = await asyncio.to_thread(resolve_values, {f"v{index}": content for index, content in enumerate(settings.headers.values())}, cwd, expand)
    headers = {key: values[f"v{index}"] for index, key in enumerate(settings.headers)}
    if any("\n" in value or "\r" in value for value in headers.values()):
        raise BackendError("mcp_header_invalid")
    if settings.auth:
        store = AccountStore(profile.account_path)
        transport = store.read().transports.get(settings.auth.provider)
        credential = await store.resolve(settings.auth.provider, proxy=transport.proxy if transport else "")
        if credential is None:
            raise BackendError("provider_not_configured")
        headers["Authorization"] = "Bearer " + (credential.key if isinstance(credential, ApiKeyCredential) else credential.access).get_secret_value()
    if settings.oauth:
        secret = await asyncio.to_thread(resolve_values, {"secret": settings.oauth.client_secret}, cwd, expand) if settings.oauth.client_secret else {}
        settings = settings.model_copy(update={"oauth": settings.oauth.model_copy(update={"client_secret": secret.get("secret", "")})})
        return headers, McpAuth(settings, TokenStore(profile, name, settings))
    return headers, None


async def sign_in(settings: McpHttpSettings, profile: Profile, name: str,
                  publish: Callable[[str], Awaitable[None]], input_queue: asyncio.Queue[str], guard: Callable[[], Awaitable[None]]) -> None:
    options = settings.oauth
    if options is None:
        raise BackendError("mcp_oauth_not_configured")
    parts = urlsplit(options.callback_url or "http://127.0.0.1/callback")
    callback_path = parts.path or "/"
    store = TokenStore(profile, name, settings)
    registered = store.read().get("redirect")
    port = parts.port or options.callback_port or (urlsplit(registered).port if isinstance(registered, str) else None) or 0
    future: asyncio.Future[tuple[str, str | None]] = asyncio.get_running_loop().create_future()
    auth: McpAuth | None = None
    expected_state = ""

    def accept(value: str) -> None:
        supplied = urlsplit(value)
        if supplied.scheme and (supplied.scheme, supplied.netloc) != ("http", urlsplit(store.redirect).netloc):
            raise BackendError("mcp_oauth_callback_mismatch")
        if supplied.path not in {callback_path, "/callback/" + callback_id_for(settings.url)}:
            raise BackendError("mcp_oauth_callback_mismatch")
        query = parse_qs(supplied.query)
        if not expected_state or not secrets.compare_digest(query.get("state", [""])[0], expected_state):
            raise BackendError("mcp_oauth_state_mismatch")
        if auth and auth.context.oauth_metadata:
            issuer = query.get("iss", [""])[0]
            metadata = auth.context.oauth_metadata
            if issuer and issuer != (auth.expected_issuer or str(metadata.issuer)) or auth.issuer_required and not issuer:
                raise BackendError("mcp_oauth_issuer_mismatch")
        if query.get("error"):
            raise BackendError("mcp_oauth_denied")
        code = query.get("code", [""])[0]
        if code and not future.done():
            future.set_result((code, query.get("state", [None])[0]))

    async def callback(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = await asyncio.wait_for(reader.readline(), 5)
            if len(line) > 8192:
                raise BackendError("mcp_oauth_callback_invalid")
            method, target, _version = line.decode().strip().split(" ", 2)
            if method != "GET":
                raise BackendError("mcp_oauth_callback_invalid")
            accept(target)
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nReturn to AmazMe to check sign-in status.")
            await writer.drain()
        except (OSError, ValueError, BackendError, TimeoutError):
            writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid callback")
        finally:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()

    server = await asyncio.start_server(callback, "127.0.0.1" if parts.hostname == "localhost" else parts.hostname, port, limit=8192)
    actual = server.sockets[0].getsockname()[1]
    host = "[::1]" if parts.hostname == "::1" else parts.hostname
    store.redirect = options.callback_url if parts.port else urlunsplit(("http", f"{host}:{actual}", callback_path, "", ""))

    async def receive() -> tuple[str, str | None]:
        while not future.done():
            pasted = asyncio.create_task(input_queue.get())
            done, _pending = await asyncio.wait([future, pasted], timeout=300, return_when=asyncio.FIRST_COMPLETED)
            if pasted not in done:
                pasted.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pasted
            if future in done:
                break
            if pasted in done:
                accept(pasted.result())
            else:
                raise TimeoutError()
        return future.result()

    try:
        headers, resolved = await http_settings(settings, profile, name, profile.config.workspace, expand=True)
        if resolved:
            store.settings = resolved.store.settings
        store.guard, store.authorizing = guard, True

        async def redirect(url: str) -> None:
            nonlocal expected_state
            expected_state = parse_qs(urlsplit(url).query).get("state", [""])[0]
            await publish(url)

        auth = McpAuth(settings, store, redirect=redirect, callback=receive)
        async with httpx.AsyncClient(headers=headers, auth=auth, timeout=15, trust_env=False, follow_redirects=False) as client:
            async with asyncio.timeout(300):
                async with client.stream("POST", settings.url, headers={"Accept": "application/json, text/event-stream"}, json={
                    "jsonrpc": "2.0", "id": "login", "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "pi", "version": "0.1.0"}}}) as response:
                    response.raise_for_status()
                    session_id = response.headers.get("mcp-session-id")
                if session_id:
                    await client.delete(settings.url, headers={"mcp-session-id": session_id})
                if not store.read().get("tokens"):
                    raise BackendError("mcp_oauth_no_tokens")
    finally:
        server.close()
        await server.wait_closed()


@dataclass
class McpLogin:
    view: OAuthView
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue[str](1))
    task: asyncio.Task[None] | None = None


class McpLogins:
    def __init__(self, profile: Profile, store: HostStore, admit: Callable[[], Awaitable[None]]):
        self.profile, self.store, self.admit = profile, store, admit
        self.active: dict[str, McpLogin] = {}
        self.lock = asyncio.Lock()

    async def view(self, login_id: str) -> OAuthView:
        if login_id in self.active:
            return self.active[login_id].view
        row = await self.store.db.call(lambda db: db.execute("SELECT view FROM mcp_logins WHERE id=?", (login_id,)).fetchone())
        if row is None:
            raise BackendError("mcp_login_not_found", status=404)
        view = OAuthView.model_validate_json(str(row[0]))
        return view.model_copy(update={"phase": "unknown", "error": "mcp_login_interrupted"}) if view.phase == "pending" else view

    async def start(self, value: McpLoginRequest) -> OAuthView:
        await self.admit()
        async with self.lock:
            for key in list(self.active):
                if self.active[key].view.phase != "pending":
                    self.active.pop(key)
            def reserve(db: sqlite3.Connection) -> tuple[McpHttpSettings | None, str, OAuthView]:
                old = db.execute("SELECT payload,view FROM mcp_logins WHERE id=?", (value.login_id,)).fetchone()
                if old:
                    if str(old[0]) != value.model_dump_json():
                        raise BackendError("mcp_login_conflict")
                    return None, "", OAuthView.model_validate_json(str(old[1]))
                if len([login for login in self.active.values() if login.view.phase == "pending"]) >= 8:
                    raise BackendError("mcp_login_capacity")
                if db.execute("SELECT revision FROM mcp_config_revision WHERE id=1").fetchone()[0] != value.expected_revision:
                    raise BackendError("mcp_config_revision")
                item = next((item for item in mcp_management.effective(db, "") if item.name == value.name), None)
                if item is None or not isinstance(item.settings, McpHttpSettings) or item.settings.oauth is None:
                    raise BackendError("mcp_oauth_not_configured")
                if any(login.view.provider == value.name and login.view.phase == "pending" for login in self.active.values()):
                    raise BackendError("mcp_login_pending")
                view = OAuthView(login_id=value.login_id, provider=value.name, phase="pending", expires_ms=int(time.time() * 1000) + 300000)
                db.execute("INSERT INTO mcp_logins VALUES(?,?,?)", (value.login_id, value.model_dump_json(), view.model_dump_json()))
                return item.settings, item.launch_id, view
            settings, launch, view = await self.store.transaction(reserve)
            if settings is None:
                return await self.view(value.login_id)
            login = McpLogin(view)
            self.active[value.login_id] = login

            async def guard() -> None:
                await self.admit()
                valid = await self.store.db.call(lambda db: any(item.name == value.name and item.launch_id == launch for item in mcp_management.effective(db, "")))
                if not valid:
                    raise BackendError("mcp_config_changed")

            async def publish(url: str) -> None:
                await guard()
                login.view = login.view.model_copy(update={"url": url})
                await self.save(login)

            async def run() -> None:
                try:
                    await sign_in(settings, self.profile, value.name, publish, login.queue, guard)
                    await guard()
                    login.view.phase = "complete"
                except asyncio.CancelledError:
                    login.view.phase = "cancelled"
                except TimeoutError:
                    login.view.phase = "expired"
                except Exception as error:
                    login.view.phase = "failed" if isinstance(error, BackendError) else "unknown"
                    login.view.error = error.code if isinstance(error, BackendError) else "mcp_login_failed"
                finally:
                    login.view.url = ""
                    await self.save(login)
            login.task = asyncio.create_task(run())
            return view

    async def save(self, login: McpLogin) -> None:
        await self.store.transaction(lambda db: db.execute("UPDATE mcp_logins SET view=? WHERE id=?", (login.view.model_dump_json(), login.view.login_id)))

    async def input(self, login_id: str, text: str) -> OAuthView:
        await self.admit()
        login = self.active.get(login_id)
        if login is None or login.view.phase != "pending" or login.queue.full():
            raise BackendError("mcp_login_inactive")
        login.queue.put_nowait(text)
        return login.view

    async def cancel(self, login_id: str) -> OAuthView:
        login = self.active.get(login_id)
        if login and login.view.phase == "pending" and login.task:
            login.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await login.task
            if login.view.phase == "pending":
                login.view.phase, login.view.url = "cancelled", ""
                await self.save(login)
        view = await self.view(login_id)
        if login is None and view.phase == "unknown":
            view = view.model_copy(update={"phase": "cancelled", "url": ""})
            await self.store.transaction(lambda db: db.execute("UPDATE mcp_logins SET view=? WHERE id=?", (view.model_dump_json(), login_id)))
        return view

    async def close(self) -> None:
        await asyncio.gather(*(self.cancel(key) for key in list(self.active)), return_exceptions=True)


def callback_id_for(url: str) -> str:
    canonical = str(httpx.URL(url))
    return base64.urlsafe_b64encode(hashlib.sha256(canonical.encode()).digest()[:9]).decode().rstrip("=")
