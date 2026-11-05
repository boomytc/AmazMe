from __future__ import annotations

from pathlib import Path

from amazme_backend.shared.errors import BackendError


def check_grant_directory(path: Path, profile: Path, primary: Path) -> Path:
    if not path.is_absolute() or path.is_symlink():
        raise BackendError("workspace_grant_forbidden" if not path.is_symlink() else "workspace_symlink")
    if not path.is_dir():
        raise BackendError("workspace_not_directory")
    resolved = path.resolve()
    home = Path.home().resolve()
    blocked = (home, home / ".ssh", home / "Library" / "Keychains", profile.resolve(), primary.resolve())
    if (
        resolved in blocked
        or _inside(resolved, home / ".ssh")
        or _inside(resolved, home / "Library" / "Keychains")
    ):
        raise BackendError("workspace_grant_forbidden")
    if _inside(resolved, profile.resolve()):
        raise BackendError("workspace_grant_forbidden")
    if "docker.sock" in resolved.parts:
        raise BackendError("workspace_grant_forbidden")
    return resolved


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return path != root
