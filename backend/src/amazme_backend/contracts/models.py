from __future__ import annotations

import base64
import binascii
from typing import Annotated, Literal

from pydantic import Field, field_validator

from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model

ProviderApi = Literal["openai-completions", "openai-responses", "openai-codex-responses",
                      "anthropic-messages", "google-generative-ai"]


TOOL_NAME_PATTERN = r"^(shell|read_file|glob|grep|write_file|edit_file|apply_patch|tool_output|job_list|job_output|job_kill|delegate_task|web_search|web_fetch|mcp_tool|mcp_[a-f0-9]{20}|plugin_tool|plugin_[a-f0-9]{20}|tool_search|codemode)$"


ThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]


class ModelSelection(Model):
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    model: str = Field(min_length=1, max_length=128, pattern=r"^[\w./:@+-]+$")


class CatalogModel(Model):
    api: ProviderApi = "openai-completions"
    base_url: str = ""
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    model: str
    label: str
    endpoint_editable: bool
    thinking_levels: list[ThinkingLevel] = Field(default_factory=lambda: ["off"])


class ModelSettings(Model):
    api: ProviderApi = "openai-completions"
    auth_type: Literal["api_key", "oauth"] = "api_key"
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    model: str
    base_url: str
    max_tokens: int
    key_configured: bool
    credential_revision: int = 0
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    thinking: ThinkingLevel = "off"


class ProviderDefinition(Model):
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    name: str = Field(default="", max_length=100)
    base_url: str = Field(max_length=300)
    api: ProviderApi
    model_ids: list[str] | None = Field(default=None, max_length=256)

    @field_validator("model_ids")
    @classmethod
    def checked_model_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is not None:
            if not value or len(set(value)) != len(value):
                raise ValueError("model ids must be nonempty and unique")
            for name in value:
                ModelSelection(provider="custom", model=name)
        return value


class ModelCatalog(Model):
    models: list[CatalogModel]
    current: ModelSettings
    providers: list[ProviderDefinition] = Field(default_factory=lambda: list[ProviderDefinition]())
    configuration_revision: int = 0


class ScopedModel(Model):
    model: CatalogModel
    thinking: ThinkingLevel | None = None


class ModelScopeRequest(Model):
    patterns: list[Annotated[str, Field(min_length=1, max_length=256)]] = Field(min_length=1, max_length=128)
    provider: str = Field(default="", pattern=r"^(?:[a-z][a-z0-9._-]{0,63})?$")


class ModelScope(Model):
    models: list[ScopedModel]
    diagnostics: list[str] = Field(default_factory=list)


class UpdateModelSettings(Model):
    """Model selection never carries an API key. Credential changes use CredentialUpdate."""

    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    api: ProviderApi | None = None
    model: str = Field(min_length=1, max_length=128, pattern=r"^[\w./:@+-]+$")
    base_url: str = Field(default="", max_length=300)
    max_tokens: int = Field(default=2048, ge=32, le=8192)
    proxy: str = Field(default="", max_length=300)
    headers: dict[str, str] = Field(default_factory=dict)
    thinking: ThinkingLevel | None = None


IMAGE_MEDIA_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")


IMAGE_MAX_BYTES = 8 * 1024 * 1024


IMAGE_MAX_COUNT = 8


_IMAGE_BASE64_MAX = (IMAGE_MAX_BYTES + 2) // 3 * 4


class ImagePart(Model):
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data_base64: str = Field(min_length=1, max_length=_IMAGE_BASE64_MAX)


def checked_images(images: list[ImagePart]) -> list[ImagePart]:
    """Reject a prompt image before it is stored or sent. The bytes stay out of ordinary events."""
    if len(images) > IMAGE_MAX_COUNT:
        raise BackendError("too_many_images")
    for image in images:
        try:
            raw = base64.b64decode(image.data_base64, validate=True)
        except (binascii.Error, ValueError):
            raise BackendError("invalid_image") from None
        if not raw:
            raise BackendError("invalid_image")
        if len(raw) > IMAGE_MAX_BYTES:
            raise BackendError("image_too_large")
    return images


class ToolCall(Model):
    id: str
    # mcp_tool is the session's canonical call. mcp_<20 hex> is only the name offered to a provider.
    name: str = Field(pattern=TOOL_NAME_PATTERN)
    arguments: str


class Message(Model):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=lambda: list[ToolCall]())
    tool_call_id: str = ""
    provider_response_id: str = ""
    thinking: ThinkingLevel | None = None
    # Opaque provider replay data. Ordinary usage and logs do not include this text.
    reasoning_signature: str = ""
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart](), max_length=IMAGE_MAX_COUNT)
