"""Own a disposable native Host and borrowed credentials for model evaluations."""

import asyncio
import json
import select
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError


def _census():
    tools = str(Path(__file__).resolve().parent)
    if tools not in sys.path:
        sys.path.insert(0, tools)
    import resource_census
    return resource_census


def until(operation, predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = operation()
        if predicate(value):
            return value
        time.sleep(0.1)
    raise TimeoutError("Host readiness timed out")


class EvalRuntime:
    def __init__(self, command, root: Path, provider: Path):
        self.command, self.root = command, root
        self.workspace, self.profile = root / "workspace", root / "profile"
        if self.profile.exists() or self.profile.is_symlink():
            raise RuntimeError("Eval profile already exists")
        self.workspace.mkdir()
        self.env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home()), "TMPDIR": "/tmp"}
        subprocess.run([*command, "init", "--profile", str(self.profile), "--workspace", str(self.workspace),
                        "--provider-config", str(provider), "--approval-policy", "auto"], check=True, capture_output=True, env=self.env)
        identity = self.profile.stat()
        self._profile_identity = (identity.st_dev, identity.st_ino)
        self.log = (root / "host.log").open("w")
        self.ipc = Profile(self.profile).ipc
        identity = self.ipc.stat()
        self._ipc_identity = (identity.st_dev, identity.st_ino)
        self.process = None
        self.client = None

    def start(self):
        census = _census()
        report = census.collect()
        self.resource_before = report
        census.admit(report, purpose="serve")
        self.process = subprocess.Popen([*self.command, "serve", "--profile", str(self.profile)], env=self.env,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True)
        if not select.select([self.process.stdout], [], [], 30)[0]:
            raise TimeoutError("Host startup timeout")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Host exited; inspect host.log")
        self.ready = json.loads(line)
        self.client = httpx.Client(base_url=self.ready["url"], timeout=45, trust_env=False,
                                  headers={"Authorization": "Bearer " + (self.profile / "web.token").read_text(),
                                           "x-amazme-build": self.ready["build_id"],
                                           "x-amazme-epoch": str(self.ready["host_epoch"])} )
        until(lambda: self.client.get("/api/v1/bootstrap"), lambda r: r.status_code == 200)

    def stop(self):
        if self.process and self.process.poll() is None:
            if self.client is not None:
                r = self.client.post("/control/shutdown", headers={"Authorization": "Bearer " + (self.profile / "control.token").read_text()},
                                     json={"host_epoch": self.ready["host_epoch"], "build_id": self.ready["build_id"]})
                r.raise_for_status()
            else:
                self.process.send_signal(signal.SIGINT)
            self.process.wait(timeout=30)
            if self.client is not None and self.process.returncode != 0:
                raise BackendError("eval_host_exit_failed")
        if self.client is not None:
            self.client.close()
            self.client = None

    def clear_owned_credentials(self):
        """Only this evaluation profile may lose its borrowed credentials."""
        from amazme_backend.accounts.store import AccountDocument, AccountStore

        identity = self.profile.stat()
        if self.profile.is_symlink() or (identity.st_dev, identity.st_ino) != self._profile_identity:
            raise RuntimeError("Eval profile identity changed")

        async def clear():
            store = AccountStore(self.profile)
            async with store.locked():
                current = self.profile.stat()
                if self.profile.is_symlink() or (current.st_dev, current.st_ino) != self._profile_identity:
                    raise RuntimeError("Eval profile identity changed")
                # The copied vault is now authoritative; config-only scrubbing is insufficient.
                previous = store.read()
                config = self.profile / "config.json"
                value = json.loads(config.read_text())
                value["provider"].update(api_key="", proxy="", headers={})
                private_write(config, json.dumps(value))
                store.write(AccountDocument(revision=previous.revision + 1))
        asyncio.run(clear())

    def close(self):
        try:
            self.stop()
            from amazme_backend.contracts import ProcessLease
            from amazme_backend.execution.processes import exited
            for path in (self.profile / "processes").glob("*.lock"):
                if not exited(ProcessLease.model_validate_json(path.read_bytes())):
                    raise BackendError("eval_process_exit_unconfirmed", path.name)
        finally:
            try:
                self.log.close()
                self.clear_owned_credentials()
            finally:
                census = _census()
                try:
                    report, processes = census.scan()
                    self.resource_report = census.owned_after(
                        [self.root, self.profile], report, processes, before=getattr(self, "resource_before", None),
                    )
                    census.record(report, purpose="serve", event="after", before=getattr(self, "resource_before", None))
                except Exception as error:
                    self.resource_report = {
                        "reclaimed": False, "owned_reclaimed": False, "global_reclaimed": False,
                        "scope": census.SCOPE, "error": str(error), "deletion": "not_performed", "note": census.NOTE,
                    }
        if not self.resource_report.get("owned_reclaimed", False):
            raise BackendError("eval_cleanup_unconfirmed")
        if self.ipc.exists() or self.ipc.is_symlink():
            identity = self.ipc.lstat()
            if self.ipc.is_symlink() or (identity.st_dev, identity.st_ino) != self._ipc_identity:
                raise BackendError("eval_ipc_owner_changed")
            shutil.rmtree(self.ipc)
