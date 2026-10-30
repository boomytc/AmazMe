from __future__ import annotations

import hashlib
import json
import re
import shlex
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    ConfigDict,
    Field,
    JsonValue,
    TypeAdapter,
    ValidationError,
    field_validator,
    model_validator,
)

from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model

McpExposure = Literal["codemode", "deferred", "direct", "hidden"]


class McpSettings(Model):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    enabled: bool = True
    exposure: McpExposure = "codemode"
    description: str = Field(default="", max_length=4000)
    tool_exposure: dict[str, McpExposure] = Field(default_factory=dict, alias="toolExposure", max_length=128)
    timeout: float = Field(default=60, gt=0, le=86400)


class McpStdioSettings(McpSettings):
    type: Literal["stdio"] = "stdio"
    command: str = Field(min_length=1, max_length=4096)
    args: list[Annotated[str, Field(max_length=4096)]] = Field(default_factory=list, max_length=128)
    env: dict[str, str] = Field(default_factory=dict, max_length=64)
    cwd: str = Field(default="", max_length=4096)

    @model_validator(mode="after")
    def checked_launch(self) -> McpStdioSettings:
        McpLaunch(command=shlex.join([self.command, *self.args]), cwd=self.cwd, environment=self.env)
        return self


def mcp_secure_url(value: str) -> str:
    parts = urlsplit(value)
    if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password
            or parts.fragment or parts.scheme == "http" and parts.hostname not in {"localhost", "127.0.0.1", "::1"}):
        raise ValueError("MCP credentials require HTTPS or loopback HTTP")
    return value


class McpOAuthSettings(Model):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    client_id: str = Field(default="", alias="clientId", max_length=4096)
    client_secret: str = Field(default="", alias="clientSecret", max_length=16384)
    callback_port: int | None = Field(default=None, alias="callbackPort", ge=1, le=65535)
    callback_url: str = Field(default="", alias="callbackUrl", max_length=4096)
    scope: str = Field(default="", max_length=4000)
    client_name: str = Field(default="pi", alias="clientName", min_length=1, max_length=200)
    registration: Literal["auto", "dcr", "cimd"] = Field(default="auto", alias="clientRegistration")
    metadata_url: str = Field(default="", alias="authServerMetadataUrl", max_length=4096)

    def offers_cimd(self) -> bool:
        if self.registration != "auto":
            return self.registration == "cimd"
        if self.client_id or self.client_secret or self.client_name != "pi":
            return False
        parts = urlsplit(self.callback_url) if self.callback_url else None
        return parts is None or parts.hostname != "::1" and parts.path == "/callback"

    @model_validator(mode="after")
    def checked_callback(self) -> McpOAuthSettings:
        if self.callback_url:
            parts = urlsplit(self.callback_url)
            mcp_secure_url(self.callback_url)
            if (parts.scheme != "http" or parts.query or self.callback_port and parts.port and self.callback_port != parts.port):
                raise ValueError("MCP OAuth callback must be loopback HTTP without query or fragment and use one port")
            if self.registration == "cimd" and (parts.hostname == "::1" or parts.path != "/callback"):
                raise ValueError("MCP CIMD requires localhost or 127.0.0.1 /callback")
        if self.metadata_url:
            mcp_secure_url(self.metadata_url)
        if self.registration == "cimd" and (self.client_id or self.client_name != "pi"):
            raise ValueError("MCP CIMD cannot override the Pi client identity")
        return self


class McpProviderAuth(Model):
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")


class McpHttpSettings(McpSettings):
    type: Literal["http", "streamable-http"] = "http"
    url: str = Field(min_length=1, max_length=4096)
    headers: dict[str, str] = Field(default_factory=dict, max_length=64)
    oauth: McpOAuthSettings | None = None
    auth: McpProviderAuth | None = None

    @model_validator(mode="after")
    def checked_transport(self) -> McpHttpSettings:
        parts = urlsplit(self.url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.fragment:
            raise ValueError("invalid streamable HTTP URL")
        if self.oauth or self.auth or self.headers:
            mcp_secure_url(self.url)
        if self.oauth and self.auth:
            raise ValueError("MCP OAuth and provider authentication are mutually exclusive")
        if any(not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}", key) or "\r" in content or "\n" in content or len(content) > 16384
               or key.lower() in {"host", "content-length", "mcp-session-id", "mcp-protocol-version"} for key, content in self.headers.items()):
            raise ValueError("invalid MCP HTTP headers")
        return self


McpServerSettings = McpStdioSettings | McpHttpSettings


class McpConfigWrite(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    expected_revision: int = Field(ge=0)
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    entry: McpServerSettings


class McpConfigPatch(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    expected_revision: int = Field(ge=0)
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    scope: Literal["global", "project"] = "global"
    enabled: bool | None = None
    exposure: McpExposure | None = None
    remove: bool = False


class McpConfiguredServer(Model):
    config_id: str
    launch_id: str
    name: str
    detail: str
    scope: Literal["global", "project"]
    overridden: bool = False
    enabled: bool
    exposure: McpExposure
    can_login: bool = False


class McpConfiguration(Model):
    revision: int
    workspace: str
    path: str
    servers: list[McpConfiguredServer]


class McpReconnect(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")


class McpLoginRequest(Model):
    login_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    expected_revision: int = Field(ge=0)


class McpLaunch(Model):
    command: str = Field(min_length=1, max_length=16000)
    workspace: str = ""
    cwd: str = Field(default="", max_length=4096)
    environment: dict[str, str] = Field(default_factory=dict, max_length=64)
    environment_commands: dict[str, str] = Field(default_factory=dict, max_length=64)
    timeout_seconds: float = Field(default=60, gt=0, le=86400)
    managed_id: str = Field(default="", pattern=r"^(?:[a-f0-9]{32})?$")
    name: str = Field(default="", max_length=64)
    http: McpHttpSettings | None = None

    @model_validator(mode="after")
    def checked_transport(self) -> McpLaunch:
        if self.http is not None and (self.command != self.http.url or self.environment or self.environment_commands):
            raise ValueError("HTTP MCP uses its URL and explicit HTTP settings")
        return self

    @field_validator("command", "cwd")
    @classmethod
    def launch_text(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("invalid MCP launch text")
        return value

    @field_validator("environment", "environment_commands")
    @classmethod
    def explicit_environment(cls, value: dict[str, str]) -> dict[str, str]:
        if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", key) or "\x00" in content or len(content) > 16384
               or key.startswith("AMAZME_") for key, content in value.items()):
            raise ValueError("invalid MCP environment")
        return value


class McpOpen(McpLaunch):
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class McpTool(Model):
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    description: str = ""
    input_schema: dict[str, JsonValue] = Field(default_factory=lambda: {"type": "object"})


class McpView(Model):
    server_id: str
    session_id: str = ""
    workspace: str = "primary"
    command: str = ""
    managed_id: str = ""
    name: str = ""
    enabled: bool = True
    exposure: McpExposure = "direct"
    tool_exposure: dict[str, McpExposure] = Field(default_factory=dict)
    protocol_version: str = ""
    phase: Literal["ready", "exited", "unknown"]
    exit_code: int | None = None
    tools: list[McpTool]
    clean: bool


class McpCallRequest(Model):
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    schema_digest: str = ""
    origin: Literal["manual", "model"] = "manual"

    @field_validator("arguments")
    @classmethod
    def bounded_arguments(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if len(json.dumps(value, ensure_ascii=False).encode()) > 16000:
            raise ValueError("MCP arguments exceed 16000 bytes")
        return value

    @field_validator("schema_digest")
    @classmethod
    def schema_pin(cls, value: str) -> str:
        if value and (len(value) != 64 or any(character not in "0123456789abcdef" for character in value)):
            raise ValueError("MCP schema digest invalid")
        return value


class McpToolCall(Model):
    """Identity captured when the model proposes a call. The provider never chooses these fields."""

    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    tool: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    workspace: str = Field(min_length=1, max_length=64)
    command: str = Field(min_length=1, max_length=16000)
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("arguments")
    @classmethod
    def bounded_arguments(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if len(json.dumps(value, ensure_ascii=False).encode()) > 16000:
            raise ValueError("MCP arguments exceed 16000 bytes")
        return value


class McpCall(Model):
    call_id: str
    server_id: str
    name: str
    phase: Literal["waiting_approval", "running", "done", "denied", "unknown", "conflict"]
    result: str = ""
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    result_data: dict[str, JsonValue] | None = None
    is_error: bool = False
    digest: str
    origin: Literal["manual", "model"] = "manual"


class McpState(Model):
    servers: list[McpView]
    calls: list[McpCall]


class McpDecision(Model):
    decision_id: str = Field(min_length=1, max_length=64)
    approve: bool
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")





class McpOffer(Model):
    alias: str = Field(pattern=r"^mcp_[a-f0-9]{20}$")
    server_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = Field(min_length=1, max_length=64)
    command: str = Field(min_length=1, max_length=16000)
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    description: str = ""
    input_schema: dict[str, JsonValue]
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    managed_id: str = ""
    exposure: McpExposure = "direct"
    active: bool = False

    def activation_key(self) -> str:
        return f"{self.managed_id or self.server_id}:{self.name}"


def mcp_alias(server_id: str, name: str) -> str:
    return 'mcp_' + hashlib.sha256(f'{server_id}\n{name}'.encode()).hexdigest()[:20]


def schema_digest(schema: dict[str, JsonValue]) -> str:
    body = json.dumps(schema, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()



def exposure(default: McpExposure, overrides: dict[str, McpExposure], name: str) -> McpExposure:
    if name in overrides:
        return overrides[name]
    for pattern, value in overrides.items():
        if "*" in pattern and re.fullmatch(re.escape(pattern).replace(r"\*", ".*"), name):
            return value
    return default



def catalog_payload(offers: list[McpOffer]) -> str:
    return json.dumps([item.model_dump(mode="json") for item in offers], ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))



def catalog_schema_digest(catalog: str, name: str) -> str:
    try:
        items = TypeAdapter(list[dict[str, JsonValue]]).validate_json(catalog)
    except (json.JSONDecodeError, ValidationError):
        return ""
    for item in items:
        schema = item.get("input_schema")
        if item.get("name") == name and isinstance(schema, dict):
            return schema_digest(schema)
    return ""



def offers_from_views(servers: list[McpView], *, surface: Literal["model", "code", "catalog"] = "model") -> list[McpOffer]:
    """Project ready stored views into offers for the requested surface."""
    offers: list[McpOffer] = []
    for server in servers:
        if not server.enabled or server.phase != "ready" or not server.command or not server.workspace:
            continue
        for tool in server.tools:
            visible = exposure(server.exposure, server.tool_exposure, tool.name)
            if visible == "hidden" or surface == "model" and visible != "direct":
                continue
            schema = tool.input_schema
            if schema.get("type") not in (None, "object"):
                continue
            offers.append(McpOffer(alias=mcp_alias(server.server_id, tool.name), server_id=server.server_id,
                                   workspace=server.workspace, command=server.command, name=tool.name,
                                   description=tool.description[:500], input_schema=schema,
                                   schema_digest=schema_digest(schema), managed_id=server.managed_id,
                                   exposure=visible, active=surface == "code"))
    if len({item.alias for item in offers}) != len(offers):
        raise BackendError("mcp_catalog_conflict")
    return offers
