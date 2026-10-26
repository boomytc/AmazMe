from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from pydantic import BaseModel

from amazme_backend.platform.resource_manifest import IDENTITY_SUFFIXES
from amazme_backend.platform.resources import package_root
from amazme_backend.shared.errors import BackendError


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


def frozen_identity(root: Path) -> str:
    """Return the build id only when every listed file still matches the manifest."""
    manifest = FrozenManifest.model_validate_json((root / "build.json").read_bytes())
    expected = hashlib.sha256(json.dumps(manifest.model_dump(exclude={"build_id"}), sort_keys=True).encode()).hexdigest()
    if expected != manifest.build_id:
        raise BackendError("build_manifest_mismatch")
    for name, digest in manifest.files.items():
        path = root / name
        if not path.resolve().is_relative_to(root):
            raise BackendError("build_resource_outside_bundle")
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != digest:
            raise BackendError("build_resource_mismatch", name)
    return manifest.build_id


def rewrite_frozen_manifest(root: Path) -> str:
    """Rehash a bundle after codesign changes Mach-O bytes, keeping version and nonce."""
    current = json.loads((root / "build.json").read_text())
    manifest_path = root / "build.json"
    files: dict[str, str] = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file() and item != manifest_path):
        if not path.resolve().is_relative_to(root):
            raise BackendError("build_resource_outside_bundle")
        with path.open("rb") as stream:
            files[path.relative_to(root).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    body = {"version": str(current["version"]), "nonce": str(current["nonce"]), "files": files}
    build = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    manifest_path.write_text(json.dumps({**body, "build_id": build}, indent=2) + "\n")
    if frozen_identity(root) != build:
        raise BackendError("build_manifest_mismatch")
    return build


def build_id() -> str:
    if getattr(sys, "frozen", False):
        return frozen_identity(Path(sys.executable).resolve().parent)
    root = package_root()
    h = hashlib.sha256()
    for path in source_identity_files():
        h.update(os.path.relpath(path, root).encode() + path.read_bytes())
    h.update((root.parents[1] / "uv.lock").read_bytes())
    return h.hexdigest()


class FrozenManifest(BaseModel):
    version: str
    nonce: str
    files: dict[str, str]
    build_id: str
