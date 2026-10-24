import asyncio
import fcntl
import hashlib
import json
import os
import secrets
import socket
import stat
import sys
from pathlib import Path
from typing import IO, Literal

import httpx
from pydantic import BaseModel, ValidationError

from .contracts import BackendError, Identity, ProfileConfig, ProviderConfig


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        # "resources" is a bundle Resources directory on a case-insensitive volume.
        return Path(sys.executable).resolve().parent / "runtime"
    return Path(__file__).resolve().parents[2] / "resources"


IDENTITY_SUFFIXES = {".py", ".html", ".js", ".css", ".json", ".mjs"}


def source_identity_files() -> list[Path]:
    """Source bytes that define a build, including the JS helper and plugin gate."""
    root = Path(__file__).parent
    return [path for path in sorted(root.rglob("*")) if path.is_file() and path.suffix in IDENTITY_SUFFIXES]


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
    root = Path(__file__).parent
    h = hashlib.sha256()
    for path in source_identity_files():
        h.update(str(path.relative_to(root)).encode() + path.read_bytes())
    h.update((root.parents[1] / "uv.lock").read_bytes())
    return h.hexdigest()


class FrozenManifest(BaseModel):
    version: str
    nonce: str
    files: dict[str, str]
    build_id: str


def private_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + "." + secrets.token_hex(4))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def lock(path: Path) -> IO[str]:
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    stream = os.fdopen(fd, "a+")
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        stream.close()
        raise
    return stream


def unix_listener(path: Path) -> socket.socket:
    path.unlink(missing_ok=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen(64)
        listener.setblocking(False)
        return listener
    except BaseException:
        listener.close()
        raise


class Profile:
    def __init__(self, path: Path):
        self.path = path.resolve(strict=True)
        self.config = ProfileConfig.model_validate_json((self.path / "config.json").read_bytes())
        self.token = (self.path / "control.token").read_text().strip()
        key = hashlib.sha256(str(self.path).encode()).hexdigest()[:16]
        self.ipc = Path(f"/tmp/amazme-{os.getuid()}-{key}")
        self.ipc.mkdir(mode=0o700, exist_ok=True)
        info = self.ipc.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise BackendError("unsafe_ipc_directory")

    def reload_provider(self) -> None:
        fresh = ProfileConfig.model_validate_json((self.path / "config.json").read_bytes())
        if (fresh.profile_id != self.config.profile_id or fresh.workspace != self.config.workspace
                or fresh.format != self.config.format):
            raise BackendError("profile_identity_mismatch")
        self.config = fresh

    def save_provider(self, provider: ProviderConfig, *, credential_revision: int | None = None) -> None:
        raw = json.loads((self.path / "config.json").read_text())
        raw["provider"] = {**provider.model_dump(mode="json"), "api_key": provider.api_key.get_secret_value()}
        if credential_revision is not None:
            raw["credential_revision"] = credential_revision
        private_write(self.path / "config.json", json.dumps(raw))
        self.reload_provider()

    def socket(self, name: str) -> Path:
        return self.ipc / f"{name}.sock"

    def worker_socket(self, session: str) -> Path:
        return self.socket("w-" + hashlib.sha256(session.encode()).hexdigest()[:16])

    def identity(self, instance: str, build: str, *, role: Literal["host", "supervisor", "worker"] = "host",
                 state: str = "ready", host_epoch: int = 0) -> Identity:
        return Identity(build_id=build, profile_id=self.config.profile_id, instance_id=instance, pid=os.getpid(),
                        role=role, state=state, host_epoch=host_epoch, fingerprint=build)


def child_command(*args: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    return [sys.executable, "-m", "amazme_backend", *args]


class Peer:
    def __init__(self, path: Path, token: str):
        self.client = httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(uds=str(path)), base_url="http://ipc",
            headers={"Authorization": "Bearer " + token}, timeout=180, trust_env=False,
        )

    async def call[T: BaseModel](self, method: str, path: str, response: type[T], body: BaseModel | None = None) -> T:
        r = await self.client.request(method, path, content=body.model_dump_json() if body else None,
                                      headers={"Content-Type": "application/json"})
        if r.is_error:
            from .contracts import ErrorBody
            try:
                error = ErrorBody.model_validate_json(r.content)
            except ValidationError as exc:
                raise BackendError("ipc_http_error", f"IPC HTTP {r.status_code}", r.status_code) from exc
            raise BackendError(error.code, error.message, r.status_code)
        return response.model_validate_json(r.content)

    async def close(self) -> None:
        await self.client.aclose()


async def wait_peer(peer: Peer, expected_build: str, timeout: float = 20,
                    *, instance: str | None = None, profile: str | None = None) -> Identity:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            identity = await asyncio.wait_for(peer.call("GET", "/identity", Identity), 2)
            if identity.build_id != expected_build:
                raise BackendError("build_mismatch")
            if identity.protocol != "amazme-http/1" or (profile and identity.profile_id != profile):
                raise BackendError("peer_identity_mismatch")
            if instance and identity.instance_id != instance:
                await asyncio.sleep(0.1)
                continue
            return identity
        except (httpx.TransportError, FileNotFoundError, TimeoutError):
            await asyncio.sleep(0.1)
    raise BackendError("startup_timeout", status=503)
