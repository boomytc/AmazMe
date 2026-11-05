"""Publish a complete profile once; no caller observes half-written credentials."""
import json
import secrets
import shutil
import tempfile
from pathlib import Path

from amazme_backend.accounts.configuration import ProviderTransport
from amazme_backend.accounts.store import AccountDocument, AccountStore, ApiKeyCredential
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import ApprovalPolicy
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.locations import agent_directory


def initialize(profile: Path, workspace: Path, provider: ProviderConfig, *,
               approval: ApprovalPolicy = "mutations") -> None:
    workspace = workspace.resolve(strict=True)
    if not workspace.is_dir():
        raise NotADirectoryError(workspace)
    if profile.exists():
        raise FileExistsError(profile)
    profile.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".profile-init-", dir=profile.parent))
    try:
        provider_data = {**provider.model_dump(mode="json"), "api_key": ""}
        config_data = {"format": 2, "profile_id": secrets.token_hex(16), "workspace": str(workspace),
                       "approval_policy": approval,
                       "user_resources": str(agent_directory()), "provider": provider_data}
        accounts = AccountStore(staging)
        accounts.write(AccountDocument(
            credentials={provider.provider: ApiKeyCredential(key=provider.api_key)}
            if provider.api_key.get_secret_value() else {},
            transports={provider.provider: ProviderTransport(proxy=provider.proxy, headers=provider.headers)},
        ))
        private_write(staging / "config.json", json.dumps(config_data))
        private_write(staging / "control.token", secrets.token_hex(32))
        private_write(staging / "web.token", secrets.token_hex(24))
        staging.rename(profile)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
