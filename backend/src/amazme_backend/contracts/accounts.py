from __future__ import annotations

from typing import Literal

from pydantic import Field, SecretStr

from amazme_backend.contracts.models import ProviderDefinition
from amazme_backend.shared.model import Model


class ConfigureProvider(ProviderDefinition):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    expected_revision: int = Field(ge=0)


class ProviderConfigured(Model):
    operation_id: str
    revision: int
    credential_revision: int
    provider: str


class CredentialUpdate(Model):
    expected_revision: int = Field(ge=0, le=1_000_000_000)
    clear: bool = False
    api_key: SecretStr = SecretStr("")


class ProviderCheckRequest(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    provider: str = Field(min_length=1, max_length=100)
    model_ids: list[str] = Field(min_length=1, max_length=4096)


class ProviderCheck(Model):
    operation_id: str
    provider: str
    phase: Literal["pending", "done", "unknown"]
    configuration_revision: int
    credential_revision: int
    checked_at: int = 0
    failed: list[str] = Field(default_factory=lambda: list[str]())




class AccountInfo(Model):
    provider: str
    type: Literal["api_key", "oauth"]
    expires_ms: int | None = None
    login_required: bool = False

class AccountsView(Model):
    revision: int
    accounts: list[AccountInfo]




class OAuthView(Model):
    login_id: str
    provider: str
    phase: Literal["pending", "complete", "failed", "cancelled", "expired", "unknown"]
    url: str = ""
    user_code: str = ""
    expires_ms: int = 0
    error: str = ""

class OAuthStart(Model):
    login_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    provider: str
    expected_revision: int = Field(ge=0)
    method: Literal["browser", "device_code", "copy_code"] = "browser"

class OAuthInput(Model):
    value: SecretStr = Field(max_length=8192)
