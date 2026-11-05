"""Product locations shared by every local client."""
import os
from pathlib import Path


def product_home() -> Path:
    return Path(os.environ.get("AMAZME_HOME", "~/.amazme")).expanduser().resolve()


def agent_directory() -> Path:
    configured = os.environ.get("AMAZME_AGENT_DIR")
    return Path(configured).expanduser().resolve() if configured else product_home() / "agent"


def local_profile(explicit: Path | None = None) -> Path:
    configured = explicit or os.environ.get("AMAZME_PROFILE")
    return Path(configured).expanduser().resolve() if configured else agent_directory() / "python-host"
