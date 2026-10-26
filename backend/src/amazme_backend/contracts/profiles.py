from __future__ import annotations

from typing import Literal

from pydantic import Field, SecretStr

from amazme_backend.contracts.models import ProviderApi
from amazme_backend.contracts.sessions import ApprovalPolicy, RunOptions
from amazme_backend.shared.model import Model


class ProviderConfig(RunOptions):
    provider: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-flash"
    api_key: SecretStr = SecretStr("")
    api: ProviderApi = "openai-completions"
    auth_type: Literal["api_key", "oauth"] = "api_key"
    max_tokens: int = Field(default=2048, ge=32, le=8192)
    proxy: str = ""
    headers: dict[str, str] = Field(default_factory=dict)


class ProfileConfig(Model):
    format: Literal[2] = 2
    profile_id: str
    workspace: str
    resources: str
    user_resources: str = ""
    account_profile: str = ""
    provider: ProviderConfig
    approval_policy: ApprovalPolicy = "mutations"
    testing: bool = False
    credential_revision: int = Field(default=0, ge=0)
