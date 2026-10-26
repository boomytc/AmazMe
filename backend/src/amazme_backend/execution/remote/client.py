"""Remote daemon over system OpenSSH, following Pi's SSH route and deployment contract."""

from __future__ import annotations

import hashlib
import json
import os
import select
import shlex
import subprocess
import threading
import time
from pathlib import Path
from typing import cast

import psutil

from amazme_backend.contracts.remote import SshTarget
from amazme_backend.execution.native import ProcessIdentity, stop_tracked
from amazme_backend.execution.remote.ssh import (
    accept_host_key,
    run_ssh,
    ssh_arguments,
    ssh_environment,
    ssh_error,
)
from amazme_backend.platform.resources import package_resource
from amazme_backend.shared.errors import BackendError


def daemon_identity() -> str:
    return hashlib.sha256(package_resource("remote_daemon").read_bytes()).hexdigest()


# Pi verifies an existing deployment before starting it; upload only the changed daemon.
_DEPLOY = """import hashlib,os,pathlib,sys
root=pathlib.Path.home()/'.local/share/amazme/remotes'/sys.argv[1]
root.mkdir(mode=0o700,parents=True,exist_ok=True)
f=root/('daemon-'+sys.argv[2]+'.py')
data=sys.stdin.buffer.read(131073)
if len(data)>131072 or hashlib.sha256(data).hexdigest()!=sys.argv[2]: sys.exit(125)
if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=sys.argv[2]:
 t=root/('.upload-'+str(os.getpid()))
 with t.open('xb') as h: h.write(data)
 t.chmod(0o600)
 t.replace(f)
print('deployed')
"""


class RemoteClient:
    def __init__(self, process: subprocess.Popen[bytes]):
        self.process = process
        self.leases = [ProcessIdentity.capture(psutil.Process(process.pid))]
        self.buf = bytearray()
        self.errors = bytearray()
        self.hello: dict[str, object] = {}
        self.closed = False
        assert process.stdin is not None and process.stdout is not None
        os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        self.stderr_reader = threading.Thread(target=self._drain_errors, daemon=True)
        self.stderr_reader.start()

    def _drain_errors(self) -> None:
        pipe = self.process.stderr
        if pipe is None:
            return
        while part := pipe.read(4096):
            self.errors.extend(part[:max(0, 8192 - len(self.errors))])

    @classmethod
    def connect(cls, target: SshTarget, directory: Path, host_key: str, remote_id: str) -> RemoteClient:
        alias = "amazme-remote-" + remote_id
        known_hosts = directory / "known_hosts"
        accept_host_key(known_hosts, alias, host_key)
        digest = daemon_identity()
        source = package_resource("remote_daemon").read_bytes()
        command = "python3 -I -c " + shlex.quote(_DEPLOY) + " " + remote_id + " " + digest
        run_ssh(target, known_hosts, alias, command, data=source)
        root = f'"$HOME/.local/share/amazme/remotes/{remote_id}"'
        command = f'exec python3 -I {root}/daemon-{digest}.py {root}'
        try:
            process = subprocess.Popen(["ssh", *ssh_arguments(target, known_hosts, alias), command],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       env=ssh_environment(), start_new_session=True)
        except OSError as exc:
            raise BackendError("ssh_connection_failed", status=503) from exc
        client = cls(process)
        try:
            client.hello = client._recv(30)
            return client
        except (BackendError, OSError, ValueError):
            client.close()
            raise

    def call(self, call_id: str, command: str) -> dict[str, object]:
        return self._roundtrip({"op": "call", "call_id": call_id, "command": command})

    def query(self, call_id: str) -> dict[str, object]:
        return self._roundtrip({"op": "query", "call_id": call_id})

    def cancel(self, call_id: str) -> dict[str, object]:
        return self._roundtrip({"op": "cancel", "call_id": call_id})

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        # Stop only our local SSH transport; this is not proof that remote user processes exited.
        if self.process.stdin is not None:
            self.process.stdin.close()
        if self.process.poll() is None:
            try:
                direct = self.leases[0].live()
                if direct is not None:
                    self.leases += [ProcessIdentity.capture(child) for child in direct.children(recursive=True)]
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            stop_tracked(self.leases)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self.stderr_reader.join(2)
        for pipe in (self.process.stdout, self.process.stderr):
            if pipe is not None:
                pipe.close()

    def _roundtrip(self, message: dict[str, object]) -> dict[str, object]:
        pipe = self.process.stdin
        if self.closed or pipe is None:
            raise BackendError("remote_disconnected", status=503)
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        if len(data) > 65536:
            raise BackendError("remote_message_too_large")
        offset, deadline = 0, time.monotonic() + 5
        while offset < len(data):
            if time.monotonic() >= deadline:
                raise BackendError("remote_timeout", status=503)
            if not select.select([], [pipe], [], 0.1)[1]:
                continue
            try:
                offset += os.write(pipe.fileno(), data[offset:])
            except BlockingIOError:
                continue
        reply = self._recv(30)
        if reply.get("call_id") != message.get("call_id"):
            raise BackendError("remote_protocol", status=503)
        return reply

    def _recv(self, timeout: float) -> dict[str, object]:
        pipe = self.process.stdout
        if pipe is None:
            raise BackendError("remote_disconnected", status=503)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" in self.buf:
                line, _, rest = self.buf.partition(b"\n")
                self.buf[:] = rest
                value: object = json.loads(line)
                if not isinstance(value, dict):
                    raise BackendError("remote_protocol", status=503)
                return {str(key): item for key, item in cast(dict[object, object], value).items()}
            if len(self.buf) > 65536:
                raise BackendError("remote_message_too_large", status=503)
            if not select.select([pipe], [], [], 0.1)[0]:
                continue
            try:
                part = os.read(pipe.fileno(), 4096)
            except BlockingIOError:
                continue
            if not part:
                if self.errors:
                    raise ssh_error(bytes(self.errors))
                raise BackendError("remote_disconnected", status=503)
            self.buf.extend(part)
        raise BackendError("remote_timeout", status=503)
