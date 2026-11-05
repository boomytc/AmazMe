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
from typing import IO, Literal
from urllib.parse import urlencode

import httpx
from pydantic import ValidationError

from amazme_backend.bootstrap.initialization import initialize
from amazme_backend.contracts.execution import ProcessLease
from amazme_backend.contracts.host import Health, UpdateRecord
from amazme_backend.contracts.identity import HostReady, Identity
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.workspaces import WorkspaceGrantView
from amazme_backend.execution.processes import exited
from amazme_backend.platform.identity import build_id
from amazme_backend.platform.ipc import child_command
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.locations import local_profile
from amazme_backend.profiles.profile import Profile, live_host_ready
from amazme_backend.shared.errors import BackendError, ErrorBody

STARTUP_MESSAGES = {
    "local_host_restart_required": "旧后端不支持自动重启，请先退出旧后端，再运行启动脚本。",
    "local_host_tasks_running": "后端仍有运行中的任务，请结束任务后重新启动。",
    "local_host_retirement_pending": "正在等待旧后端退出，请稍后重新运行启动脚本。",
    "local_source_changed": "启动期间源码发生变化，请重新运行启动脚本。",
}


class LocalConnection(HostReady):
    profile_path: str
    web_token: str
    workspace: str


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


def retire_source(profile: Profile, ready: HostReady) -> None:
    path = profile.path / "processes" / f"host-{ready.instance_id}.lock"
    lease = ProcessLease.model_validate_json(path.read_bytes())
    if (lease.instance_id, lease.role, lease.profile_path, lease.path) != (
        ready.instance_id, "host", str(profile.path), str(path)
    ):
        raise BackendError("process_lease_owner_mismatch")
    with httpx.Client(timeout=30, trust_env=False) as client:
        response = client.post(
            ready.url + "/control/restart", headers={"Authorization": "Bearer " + profile.token},
            json={"host_epoch": ready.host_epoch, "build_id": ready.build_id})
    if response.status_code == 404:
        raise BackendError("local_host_restart_required", "请先停止旧后端，再通过启动脚本重新启动。")
    if not response.is_success:
        error = ErrorBody.model_validate_json(response.content)
        raise BackendError(error.code, error.message, response.status_code)
    identity = Identity.model_validate_json(response.content)
    if (identity.profile_id, identity.instance_id, identity.host_epoch, identity.build_id, identity.state) != (
        ready.profile_id, ready.instance_id, ready.host_epoch, ready.build_id, "stopping"
    ):
        raise BackendError("local_host_identity_mismatch")
    deadline = time.monotonic() + 60
    while not exited(lease):
        if time.monotonic() >= deadline:
            raise BackendError("local_host_retirement_pending")
        time.sleep(0.05)


def connect(profile_path: Path, workspace: Path) -> LocalConnection:
    with startup_lock(profile_path):
        expected_build = build_id()
        if not profile_path.exists():
            initialize(profile_path, workspace, ProviderConfig(provider="faux", model="faux", base_url=""))
        profile = Profile(profile_path)
        ready = probe(profile)
        if ready is not None and ready.build_id != expected_build:
            retire_source(profile, ready)
            ready = None
        if ready is None:
            # An explicit serve command can own the Host lock before publishing readiness.
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
        if ready.state not in {"ready", "frozen"}:
            raise BackendError("local_host_not_ready")
        ready = settle_update(profile, ready)
        if ready.build_id != expected_build or build_id() != expected_build:
            raise BackendError("local_source_changed")
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
        return LocalConnection(**ready.model_dump(), profile_path=str(profile.path),
                               web_token=token, workspace=selected.name)


def doctor(profile_path: Path) -> Health:
    profile = Profile(profile_path)
    ready = probe(profile)
    if ready is None:
        raise BackendError("local_host_unavailable")
    with httpx.Client(timeout=30, trust_env=False) as client:
        response = client.get(ready.url + "/api/v1/health", headers={
            "Authorization": "Bearer " + (profile.path / "web.token").read_text().strip()})
        response.raise_for_status()
        health = Health.model_validate_json(response.content)
    live_host_ready(profile.config.profile_id, ready, health.identity)
    return health


def main(arguments: list[str], mode: Literal["connect", "web", "doctor"] = "connect") -> None:
    parser = argparse.ArgumentParser(prog="amazme-backend " + mode)
    parser.add_argument("--profile", type=Path)
    if mode != "doctor":
        parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args(arguments)
    os.umask(0o077)
    try:
        if mode == "doctor":
            health = doctor(local_profile(args.profile))
            print(health.model_dump_json())
            raise SystemExit(0 if health.state == "ready" and not health.errors else 1)
        result = connect(local_profile(args.profile), args.workspace.resolve(strict=True))
    except (BackendError, OSError, ValueError, httpx.HTTPError) as exc:
        # Command failures cross into Node logs; never print raw config, tokens or validation input.
        code = exc.code if isinstance(exc, BackendError) else "local_profile_invalid"
        body = {"code": code}
        if code in STARTUP_MESSAGES:
            body["message"] = STARTUP_MESSAGES[code]
        print(json.dumps(body, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from None
    if mode == "web":
        print(result.url + "/?" + urlencode({"host": result.profile_id, "workspace": result.workspace}))
    else:
        print(result.model_dump_json())
