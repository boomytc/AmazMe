from __future__ import annotations

from pathlib import Path

from .resource_manifest import RESOURCE_PATHS


def package_root() -> Path:
    return Path(__file__).resolve().parents[1]


def package_resource(name: str) -> Path:
    return package_root() / RESOURCE_PATHS[name]


def frontend_directory() -> Path:
    return package_root().parents[2] / "packages/web/dist/page"
