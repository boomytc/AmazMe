from __future__ import annotations

import sys
from pathlib import Path

from .resource_manifest import CLIENT_DIRECTORY, RESOURCE_PATHS


def package_root() -> Path:
    return Path(__file__).resolve().parents[1]


def package_resource(name: str) -> Path:
    return package_root() / RESOURCE_PATHS[name]


def frontend_directory() -> Path:
    if getattr(sys, "frozen", False):
        return package_root() / CLIENT_DIRECTORY
    return package_root().parents[2] / "packages/web/dist/page"


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        # "resources" is a bundle Resources directory on a case-insensitive volume.
        return Path(sys.executable).resolve().parent / "runtime"
    return package_root().parents[1] / "resources"
