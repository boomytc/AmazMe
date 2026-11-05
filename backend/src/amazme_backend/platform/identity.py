from __future__ import annotations

import hashlib
import os
from pathlib import Path

from amazme_backend.platform.resource_manifest import IDENTITY_SUFFIXES
from amazme_backend.platform.resources import package_root


def source_identity_files() -> list[Path]:
    """Source bytes that define a build, including the JS helper and plugin gate."""
    root = package_root()
    files = [path for path in sorted(root.rglob("*")) if path.is_file() and path.suffix in IDENTITY_SUFFIXES]
    sandbox = root.parents[2] / "packages/codemode"
    files.extend(path for path in sorted((sandbox / "dist").rglob("*")) if path.is_file() and path.suffix == ".js")
    files.append(sandbox / "package.json")
    client = root.parents[2] / "packages/web/dist/page"
    files.extend(path for path in sorted(client.rglob("*")) if path.is_file() and path.suffix != ".map")
    return files


def build_id() -> str:
    root = package_root()
    h = hashlib.sha256()
    for path in source_identity_files():
        h.update(os.path.relpath(path, root).encode() + path.read_bytes())
    h.update((root.parents[1] / "uv.lock").read_bytes())
    return h.hexdigest()
