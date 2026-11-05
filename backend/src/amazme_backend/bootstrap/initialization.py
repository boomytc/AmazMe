"""Publish a complete profile once; no caller observes half-written credentials."""
import json
import secrets
import shutil
import tempfile
from pathlib import Path

from amazme_backend.accounts.store import AccountStore
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import ApprovalPolicy
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.configuration import stored_provider
from amazme_backend.profiles.locations import agent_directory
from amazme_backend.profiles.profile import Profile


def initialize(profile: Path, workspace: Path, provider: ProviderConfig, *,
               source: Path | None = None, approval: ApprovalPolicy = "mutations") -> None:
    workspace = workspace.resolve(strict=True)
    if not workspace.is_dir():
        raise NotADirectoryError(workspace)
    if profile.exists():
        raise FileExistsError(profile)
    profile.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".profile-init-", dir=profile.parent))
    try:
        if source is not None:
            original = Profile(source)
            config = original.config.model_copy(update={
                "profile_id": secrets.token_hex(16), "workspace": str(workspace),
                "provider": stored_provider(original.config.provider),
                "account_profile": str(original.account_path),
            })
            private_write(staging / "config.json", config.model_dump_json())
        else:
            provider_data = {**provider.model_dump(mode="json"), "api_key": provider.api_key.get_secret_value()}
            config_data = {"format": 2, "profile_id": secrets.token_hex(16), "workspace": str(workspace),
                           "approval_policy": approval,
                           "user_resources": str(agent_directory()), "provider": provider_data}
            private_write(staging / "config.json", json.dumps(config_data))
            accounts = AccountStore(staging)
            accounts.write(accounts.read())
            provider_data["api_key"] = ""
            private_write(staging / "config.json", json.dumps(config_data))
        private_write(staging / "control.token", secrets.token_hex(32))
        private_write(staging / "web.token", secrets.token_hex(24))
        staging.rename(profile)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
