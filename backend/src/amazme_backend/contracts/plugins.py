from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import Field, JsonValue

from amazme_backend.shared.model import Model


class PluginTool(Model):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
    label: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=4000)
    parameters: dict[str, JsonValue]
    kind: Literal["tool", "command"] = "tool"


    def schema_digest(self) -> str:
        payload = json.dumps(self.parameters, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


class PluginPackage(Model):
    package_id: str
    entry: str
    phase: Literal["installed", "removing", "removed"] = "installed"


class PluginPackages(Model):
    revision: int
    packages: list[PluginPackage]


class PluginPackageAdd(Model):
    package_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    entry: str = Field(min_length=1, max_length=4096)
    expected_revision: int = Field(ge=0)


class PluginPackageRemove(Model):
    expected_revision: int = Field(ge=0)


class PluginDraft(Model):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    entry: str = Field(min_length=1, max_length=4096)
    config: dict[str, str] = Field(default_factory=dict)


class PluginReload(Model):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    reload_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    entry: str = Field(default="", max_length=4096)
    config: dict[str, str] = Field(default_factory=dict)


class PluginView(Model):
    package_id: str = ""
    session_id: str
    plugin_id: str
    name: str
    capabilities: list[str]
    config: dict[str, str]
    fingerprint: str
    entry: str
    tools: list[PluginTool] = Field(default_factory=lambda: list[PluginTool]())
    phase: Literal["loading", "ready", "disconnected", "failed", "unknown", "removed"] = "disconnected"
    load_id: str = ""
    error: str = ""


class PluginList(Model):
    plugins: list[PluginView]


def plugin_alias(plugin_id: str, name: str) -> str:
    return "plugin_" + hashlib.sha256(f"{plugin_id}\n{name}".encode()).hexdigest()[:20]


class PluginOffer(Model):
    alias: str = Field(pattern=r"^plugin_[a-f0-9]{20}$")
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = Field(min_length=1, max_length=64)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    load_id: str
    name: str
    description: str
    parameters: dict[str, JsonValue]
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")

    @classmethod
    def from_view(cls, view: PluginView, workspace: str) -> list[PluginOffer]:
        if view.phase != "ready":
            return []
        return [cls(alias=plugin_alias(view.plugin_id,tool.name),
                    plugin_id=view.plugin_id, session_id=view.session_id, workspace=workspace,
                    fingerprint=view.fingerprint, load_id=view.load_id, name=tool.name, description=tool.description,
                    parameters=tool.parameters, schema_digest=tool.schema_digest())
                for tool in view.tools if tool.kind == "tool"]


class PluginToolCall(Model):
    plugin_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = Field(min_length=1, max_length=64)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    load_id: str
    name: str
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)


class PluginCallRequest(Model):
    kind: Literal["tool", "command"] = "tool"
    call_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    expected_fingerprint: str = ""
    expected_load_id: str = ""


class PluginResult(Model):
    content: list[dict[str, JsonValue]] = Field(default_factory=lambda: list[dict[str, JsonValue]](), max_length=16)
    details: JsonValue = None
    is_error: bool = False


class PluginCallView(Model):
    call_id: str
    phase: Literal["done", "failed", "unknown", "conflict", "cancelled"]
    cancel_requested: bool = False
    clean: bool = False
    result: PluginResult | None = None
    error: str = ""


class PluginReply(Model):
    phase: Literal["ready", "done", "failed"]
    call_id: str = ""
    tools: list[PluginTool] = Field(default_factory=lambda: list[PluginTool](), max_length=64)
    result: PluginResult | None = None
    error: str = ""
