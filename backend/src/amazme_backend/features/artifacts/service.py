"""Session artifacts: one id, one byte string, no symlink and no silent overwrite."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import stat
from pathlib import Path
from typing import cast

from amazme_backend.contracts.artifacts import (
    ARTIFACT_MAX_BYTES,
    ArtifactBody,
    ArtifactList,
    ArtifactView,
    ArtifactWrite,
)
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.shared.errors import BackendError

ARTIFACT_MAX_COUNT = 32
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_MEDIA = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,40}/[a-z0-9][a-z0-9.+-]{0,40}$")


def _name(value: str) -> str:
    name = value.strip()
    if not name or len(name) > 120 or "/" in name or "\\" in name or "\0" in name or name in {".", ".."}:
        raise BackendError("invalid_artifact_name")
    return name


def _media(value: str) -> str:
    media = value.strip().lower()
    if _MEDIA.fullmatch(media) is None:
        raise BackendError("invalid_artifact_type")
    return media


def _decode(data_base64: str) -> bytes:
    try:
        raw = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise BackendError("invalid_artifact") from None
    if not raw:
        raise BackendError("invalid_artifact")
    if len(raw) > ARTIFACT_MAX_BYTES:
        raise BackendError("artifact_too_large")
    return raw


def _root(profile: Path, session: str) -> Path:
    directory = session_database(profile, session).parent / "artifacts"
    if directory.is_symlink():
        raise BackendError("artifact_refused")
    return directory


def _regular(path: Path) -> bool:
    if path.is_symlink():
        return False
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode)


def _write_bytes(path: Path, payload: bytes) -> None:
    temporary = path.with_name(path.name + "." + secrets.token_hex(4))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        if temporary.exists():
            temporary.unlink()
        raise
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _meta(path: Path) -> dict[str, object]:
    if not _regular(path):
        raise BackendError("artifact_refused")
    try:
        parsed: object = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        raise BackendError("artifact_corrupt", status=503) from None
    if not isinstance(parsed, dict):
        raise BackendError("artifact_corrupt", status=503)
    raw = cast(dict[object, object], parsed)
    return {str(key): value for key, value in raw.items()}


def _view(artifact_id: str, meta: dict[str, object]) -> ArtifactView:
    try:
        return ArtifactView.model_validate(
            {
                "artifact_id": artifact_id,
                "name": meta["name"],
                "media_type": meta["media_type"],
                "size": meta["size"],
                "digest": meta["digest"],
            }
        )
    except (KeyError, ValueError):
        raise BackendError("artifact_corrupt", status=503) from None


def _matches(meta: dict[str, object], *, name: str, media: str, size: int, digest: str) -> bool:
    return (
        meta.get("name") == name
        and meta.get("media_type") == media
        and meta.get("size") == size
        and meta.get("digest") == digest
    )


def save_artifact(profile: Path, session: str, value: ArtifactWrite) -> ArtifactView:
    raw = _decode(value.data_base64)
    name = _name(value.name)
    media = _media(value.media_type)
    digest = hashlib.sha256(raw).hexdigest()
    root = _root(profile, session)
    root.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    if root.is_symlink() or not root.is_dir():
        raise BackendError("artifact_refused")
    meta_path = root / f"{value.artifact_id}.json"
    bin_path = root / f"{value.artifact_id}.bin"
    if meta_path.exists() or bin_path.exists():
        if meta_path.is_symlink() or bin_path.is_symlink():
            raise BackendError("artifact_refused")
        if _regular(meta_path):
            meta = _meta(meta_path)
            if not _regular(bin_path):
                raise BackendError("artifact_corrupt", status=503)
            stored = bin_path.read_bytes()
            if hashlib.sha256(stored).hexdigest() != meta.get("digest"):
                raise BackendError("artifact_corrupt", status=503)
            if _matches(meta, name=name, media=media, size=len(raw), digest=digest):
                return _view(value.artifact_id, meta)
            raise BackendError("artifact_conflict")
        stored = bin_path.read_bytes() if _regular(bin_path) else b""
        if hashlib.sha256(stored).hexdigest() != digest:
            raise BackendError("artifact_conflict")
        private_write(
            meta_path,
            json.dumps(
                {"name": name, "media_type": media, "size": len(raw), "digest": digest},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return _view(
            value.artifact_id, {"name": name, "media_type": media, "size": len(raw), "digest": digest}
        )
    complete = [path for path in root.glob("*.json") if _regular(path)]
    if len(complete) >= ARTIFACT_MAX_COUNT:
        raise BackendError("artifact_limit", status=429)
    _write_bytes(bin_path, raw)
    private_write(
        meta_path,
        json.dumps(
            {"name": name, "media_type": media, "size": len(raw), "digest": digest},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return ArtifactView(
        artifact_id=value.artifact_id, name=name, media_type=media, size=len(raw), digest=digest
    )


def list_artifacts(profile: Path, session: str) -> ArtifactList:
    root = _root(profile, session)
    if not root.exists():
        return ArtifactList(artifacts=[])
    if root.is_symlink() or not root.is_dir():
        raise BackendError("artifact_refused")
    views: list[ArtifactView] = []
    for meta_path in sorted(root.glob("*.json")):
        if meta_path.is_symlink():
            raise BackendError("artifact_refused")
        artifact_id = meta_path.name[:-5]
        if _ID.fullmatch(artifact_id) is None:
            raise BackendError("artifact_corrupt", status=503)
        meta = _meta(meta_path)
        bin_path = root / f"{artifact_id}.bin"
        if not _regular(bin_path):
            raise BackendError("artifact_corrupt", status=503)
        info = bin_path.lstat()
        if info.st_size != meta.get("size"):
            raise BackendError("artifact_corrupt", status=503)
        views.append(_view(artifact_id, meta))
    return ArtifactList(artifacts=views)


def read_artifact(profile: Path, session: str, artifact_id: str) -> ArtifactBody:
    if _ID.fullmatch(artifact_id) is None:
        raise BackendError("invalid_artifact")
    root = _root(profile, session)
    meta_path = root / f"{artifact_id}.json"
    bin_path = root / f"{artifact_id}.bin"
    if not root.exists() or not meta_path.exists():
        raise BackendError("artifact_not_found", status=404)
    if root.is_symlink() or meta_path.is_symlink() or bin_path.is_symlink():
        raise BackendError("artifact_refused")
    meta = _meta(meta_path)
    if not _regular(bin_path):
        raise BackendError("artifact_corrupt", status=503)
    raw = bin_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != meta.get("digest") or len(raw) != meta.get("size"):
        raise BackendError("artifact_corrupt", status=503)
    view = _view(artifact_id, meta)
    return ArtifactBody(
        artifact_id=view.artifact_id,
        name=view.name,
        media_type=view.media_type,
        size=view.size,
        digest=view.digest,
        data_base64=base64.b64encode(raw).decode(),
    )
