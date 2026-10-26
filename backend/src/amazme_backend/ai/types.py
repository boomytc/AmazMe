"""Pure model request values. Product policies and credential stores stay outside this module."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal

from pydantic import Field, JsonValue, SecretStr, model_validator

from amazme_backend.contracts.models import IMAGE_MAX_COUNT, ImagePart, ProviderApi, ThinkingLevel
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


class ModelSpec(Model):
    provider: str
    model: str
    api: ProviderApi = "openai-completions"
    base_url: str
    max_tokens: int = 2048
    thinking: ThinkingLevel | None = None


class Auth(Model):
    api_key: SecretStr = SecretStr("")
    auth_type: Literal["api_key", "oauth"] = "api_key"
    headers: dict[str, str] = Field(default_factory=dict)


type AuthSource = Auth | Callable[[], Awaitable[Auth]]


class RequestTransport(Model):
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: float = 60.0


class ToolDefinition(Model):
    name: str
    description: str
    parameters: dict[str, JsonValue]


class ModelToolCall(Model):
    id: str
    name: str
    arguments: str


class ModelMessage(Model):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_calls: list[ModelToolCall] = Field(default_factory=lambda: list[ModelToolCall]())
    tool_call_id: str = ""
    provider_response_id: str = ""
    thinking: ThinkingLevel | None = None
    reasoning_signature: str = ""
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart](), max_length=IMAGE_MAX_COUNT)


class ModelRequest(Model):
    messages: list[ModelMessage]
    system_prompt: str = ""
    tools: list[ToolDefinition] = Field(default_factory=lambda: list[ToolDefinition]())
    wire_names: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def names(self) -> ModelRequest:
        declared = [tool.name for tool in self.tools]
        if len(set(declared)) != len(declared):
            raise BackendError("model_tool_name_conflict")
        names = set(declared) | set(self.wire_names)
        names.update(call.name for message in self.messages for call in message.tool_calls)
        sent = [self.wire_name(name) for name in names]
        if any(not name for name in sent) or len(set(sent)) != len(sent):
            raise BackendError("model_tool_name_conflict")
        return self

    def wire_name(self, name: str) -> str:
        return self.wire_names.get(name, name)

    def internal_name(self, name: str) -> str:
        return next((source for source, target in self.wire_names.items() if target == name), name)


class Completion[MessageT = ModelMessage](Model):
    message: MessageT
    response_id: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    price_input_micro_per_million: int | None = None
    price_output_micro_per_million: int | None = None
    price_cache_read_micro_per_million: int | None = None
    price_cache_write_micro_per_million: int | None = None
