"""The only local start-or-attach boundary. The Host outlives its launch client."""
import argparse
import json
import os
import subprocess
import sys
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import IO

import httpx
from pydantic import ValidationError

from amazme_backend.bootstrap.initialization import initialize
from amazme_backend.contracts.host import Health, UpdateRecord
from amazme_backend.contracts.identity import HostReady, Identity
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.workspaces import WorkspaceGrantView
from amazme_backend.platform.ipc import child_command
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.locations import local_profile
from amazme_backend.profiles.profile import Profile, live_host_ready
from amazme_backend.shared.errors import BackendError


@contextmanager
def startup_lock(profile: Path) -> Generator[None]:
    profile.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    deadline = time.monotonic() + 120
    while True:
        try:
            held: IO[str] = lock(profile.parent / ".local-host.lock")
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise BackendError("local_host_busy") from None
            time.sleep(0.05)
    with held:
        yield


def probe(profile: Profile) -> HostReady | None:
    try:
        ready = HostReady.model_validate_json((profile.path / "ready.json").read_bytes())
    except (FileNotFoundError, ValidationError):
        return None
    if ready.profile_id != profile.config.profile_id:
        raise BackendError("local_host_identity_mismatch")
    token = (profile.path / "web.token").read_text().strip()
    try:
        with httpx.Client(timeout=2, trust_env=False) as client:
            response = client.get(ready.url + "/api/v1/bootstrap", headers={"Authorization": "Bearer " + token})
    except httpx.TransportError:
        return None
    if not response.is_success:
        raise BackendError("local_host_unavailable")
    try:
        identity = Identity.model_validate_json(response.content)
    except ValidationError as exc:
        raise BackendError("host_upgrade_required") from exc
    # The listener may have changed owners while the request was connecting.
    try:
        current_record = HostReady.model_validate_json((profile.path / "ready.json").read_bytes())
    except (FileNotFoundError, ValidationError):
        return None
    if current_record.url != ready.url:
        return None
    ready = current_record
    current = live_host_ready(profile.config.profile_id, ready, identity)
    if (identity.protocol != "amazme-http/1" or identity.storage_format != 2
            or identity.version != "0.1.0" or response.headers.get("x-amazme-local-host") != "1"):
        raise BackendError("host_upgrade_required")
    if identity.state not in {"ready", "frozen"}:
        raise BackendError("local_host_not_ready")
    return current


def settle_update(profile: Profile, ready: HostReady) -> HostReady:
    if ready.state == "ready":
        return ready
    web_token = (profile.path / "web.token").read_text().strip()
    with httpx.Client(timeout=180, trust_env=False) as client:
        response = client.get(ready.url + "/api/v1/health", headers={"Authorization": "Bearer " + web_token})
        if not response.is_success:
            raise BackendError("local_host_update_failed")
        health = Health.model_validate_json(response.content)
        if (health.identity.profile_id, health.identity.build_id, health.identity.host_epoch) != (
                ready.profile_id, ready.build_id, ready.host_epoch):
            raise BackendError("local_host_identity_mismatch")
        record = health.update
        if record is None or record.target_build != ready.build_id or health.errors:
            raise BackendError("host_update_required")

        update_id = record.update_id

        def control(path: str, body: dict[str, str] | None = None) -> UpdateRecord:
            reply = client.post(ready.url + path, json=body,
                                headers={"Authorization": "Bearer " + profile.token})
            if not reply.is_success:
                raise BackendError("local_host_update_failed")
            updated = UpdateRecord.model_validate_json(reply.content)
            if updated.update_id != update_id or updated.target_build != ready.build_id:
                raise BackendError("local_host_identity_mismatch")
            return updated

        if not record.activated and record.phase not in {"validating", "completed"}:
            record = control("/control/updates/" + record.update_id + "/resume")
        if not record.activated:
            if record.phase not in {"validating", "completed"}:
                raise BackendError("local_host_update_failed")
            record = control("/control/updates/complete", {"update_id": record.update_id,
                                                        "expected_revision": record.revision})
            if not record.activated:
                raise BackendError("local_host_update_failed")
    current = probe(profile)
    if current is None or current.state != "ready":
        raise BackendError("local_host_not_ready")
    return current


def connect(profile_path: Path, workspace: Path, *, source: Path | None = None,
            provider: ProviderConfig | None = None, no_start: bool = False) -> dict[str, object]:
    with startup_lock(profile_path):
        if (profile_path.parent / ".profile-migration.json").exists():
            raise BackendError("profile_migration_incomplete")
        if (profile_path / "MIGRATED.json").exists():
            raise BackendError("profile_migrated")
        if not profile_path.exists():
            initialize(profile_path, workspace, provider or ProviderConfig(provider="faux", model="faux", base_url=""), source=source)
        profile = Profile(profile_path)
        if no_start:
            return {"profile_path": str(profile.path)}
        ready = probe(profile)
        if ready is None:
            # A legacy launcher may be starting without our startup lock. Never kill or replace it.
            try:
                with lock(profile.path / "host.lock"):
                    available = True
            except BlockingIOError:
                available = False
            child: subprocess.Popen[bytes] | None = None
            if available:
                error_path = profile.path / "serve.err"
                fd = os.open(error_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "ab") as output:
                    child = subprocess.Popen(child_command("serve", "--profile", str(profile.path), "--port", "0"),
                                             stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                             start_new_session=True, close_fds=True)
            deadline = time.monotonic() + 90
            while ready is None:
                ready = probe(profile)
                if ready is not None:
                    break
                if child is not None and child.poll() is not None:
                    try:
                        with lock(profile.path / "host.lock"):
                            raise BackendError("local_host_start_failed")
                    except BlockingIOError:
                        child = None
                if time.monotonic() >= deadline:
                    raise BackendError("local_host_start_timeout")
                time.sleep(0.1)
        ready = settle_update(profile, ready)
        token = (profile.path / "web.token").read_text().strip()
        with httpx.Client(timeout=30, trust_env=False) as client:
            response = client.post(ready.url + "/api/v1/workspaces/select",
                                   headers={"Authorization": "Bearer " + token,
                                            "x-amazme-build": ready.build_id,
                                            "x-amazme-epoch": str(ready.host_epoch)},
                                   json={"host_path": str(workspace), "name": ""})
        if not response.is_success:
            raise BackendError("workspace_select_failed")
        selected = WorkspaceGrantView.model_validate_json(response.content)
        return {**ready.model_dump(mode="json"), "profile_path": str(profile.path),
                "web_token": token, "workspace": selected.name}


def main(arguments: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="amazme-backend connect")
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--source-profile", type=Path)
    parser.add_argument("--provider-config", type=Path)
    parser.add_argument("--no-start", action="store_true")
    args = parser.parse_args(arguments)
    os.umask(0o077)
    try:
        provider = ProviderConfig.model_validate_json(args.provider_config.read_bytes()) if args.provider_config else None
        if args.profile is None and not any(os.environ.get(key) for key in ("AMAZME_PROFILE", "AMAZME_HOME", "AMAZME_CODING_AGENT_DIR")):
            legacy = Path.home() / "Library/Application Support/AmazMe/python-profile"
            if (legacy / "config.json").exists():
                raise BackendError("profile_migration_required")
        result = connect(local_profile(args.profile), args.workspace.resolve(strict=True), source=args.source_profile,
                         provider=provider, no_start=args.no_start)
    except (BackendError, OSError, ValueError, httpx.HTTPError) as exc:
        # Command failures cross into Node logs; never print raw config, tokens or validation input.
        code = exc.code if isinstance(exc, BackendError) else "local_profile_invalid"
        print(json.dumps({"code": code}), file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result))
