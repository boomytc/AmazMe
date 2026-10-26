"""System OpenSSH arguments and host-key handling, ported from Pi env/src/ssh.ts."""

from __future__ import annotations

import base64
import hashlib
import os
import re
import subprocess
import tempfile
from pathlib import Path

from amazme_backend.contracts.remote import SshTarget
from amazme_backend.execution.native import tool_environment
from amazme_backend.platform.private_files import private_write
from amazme_backend.shared.errors import BackendError


def _field(name: str, value: str) -> str:
    if not value or value.startswith("-") or re.search(r"[\s\x00-\x1f\x7f]", value):
        raise BackendError(f"invalid_ssh_{name}")
    return value


def _path(name: str, value: str) -> str:
    if not value or re.search(r'["\x00-\x1f\x7f]', value):
        raise BackendError(f"invalid_ssh_{name}")
    return '"' + value.replace("%", "%%") + '"'


def ssh_arguments(target: SshTarget, known_hosts: Path, alias: str, *, scan: bool = False) -> list[str]:
    """Pi's no-prompt, no-forwarding, non-multiplexed SSH connection contract."""
    _field("host", target.host)
    _field("alias", alias)
    args = ["-F", target.config_file] if target.config_file else []
    args += ["-T", "-a", "-x"]
    settings = [
        "BatchMode=yes", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no",
        "ControlMaster=no", "ControlPath=none", "RemoteCommand=none", "PermitLocalCommand=no",
        "SendEnv=-*", "ServerAliveInterval=15", "ConnectTimeout=15",
        "StrictHostKeyChecking=" + ("accept-new" if scan else "yes"),
        "UserKnownHostsFile=" + _path("known_hosts", str(known_hosts)),
        "GlobalKnownHostsFile=none", "HashKnownHosts=no", "HostKeyAlias=" + alias,
    ]
    for setting in settings:
        args += ["-o", setting]
    if target.user:
        args += ["-l", _field("user", target.user)]
    if target.port is not None:
        args += ["-p", str(target.port)]
    if target.identity_file:
        args += ["-o", "IdentityFile=" + _path("identity_file", target.identity_file), "-o", "IdentitiesOnly=yes"]
    return [*args, "--", target.host]


def ssh_error(stderr: bytes) -> BackendError:
    if b"REMOTE HOST IDENTIFICATION HAS CHANGED" in stderr:
        return BackendError("ssh_host_key_changed")
    if b"Host key verification failed" in stderr or b"host key is known" in stderr:
        return BackendError("ssh_host_key_unknown")
    if b"Permission denied" in stderr:
        return BackendError("ssh_authentication_failed", status=401)
    return BackendError("ssh_connection_failed", status=503)


def ssh_environment() -> dict[str, str]:
    env = tool_environment()
    # Local authentication may use the user's agent; ForwardAgent=no never sends it to the remote.
    if agent := os.environ.get("SSH_AUTH_SOCK"):
        env["SSH_AUTH_SOCK"] = agent
    return env


def run_ssh(target: SshTarget, known_hosts: Path, alias: str, command: str, *,
            data: bytes = b"", scan: bool = False) -> bytes:
    try:
        result = subprocess.run(["ssh", *ssh_arguments(target, known_hosts, alias, scan=scan), command],
                                input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=60, env=ssh_environment())
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackendError("ssh_connection_failed", status=503) from exc
    if result.returncode:
        raise ssh_error(result.stderr)
    return result.stdout


def host_key(alias: str, line: str) -> tuple[str, str]:
    parts = line.strip().split()
    if len(parts) < 3 or parts[0] != alias or not re.fullmatch(
            r"ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+", parts[1]):
        raise BackendError("invalid_ssh_host_key")
    try:
        raw = base64.b64decode(parts[2], validate=True)
    except ValueError as exc:
        raise BackendError("invalid_ssh_host_key") from exc
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
    return f"{alias} {parts[1]} {parts[2]}", fingerprint


def scan_host_key(target: SshTarget, alias: str) -> list[tuple[str, str]]:
    # Like Pi, scan through the exact SSH route; authentication may fail after the key is recorded.
    with tempfile.TemporaryDirectory(prefix="amazme-ssh-key-") as directory:
        path = Path(directory) / "known_hosts"
        try:
            run_ssh(target, path, alias, "exit 0", scan=True)
        except BackendError as exc:
            if exc.code == "ssh_host_key_changed":
                raise
        if not path.is_file():
            raise BackendError("ssh_host_key_missing", status=503)
        return [host_key(alias, line) for line in path.read_text().splitlines() if line.strip()]


def accept_host_key(path: Path, alias: str, line: str) -> None:
    key, _ = host_key(alias, line)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        saved = [host_key(alias, item)[0] for item in path.read_text().splitlines() if item.strip()]
        if key not in saved:
            raise BackendError("ssh_host_key_changed")
    else:
        private_write(path, key + "\n")
