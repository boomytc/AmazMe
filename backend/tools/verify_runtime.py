"""Run real Host/worker/supervisor/VM recovery checks in a new owned profile."""

import json
import select
import shlex
import signal
import sqlite3
import subprocess
import time
from pathlib import Path

import httpx

from amazme_backend.common import private_write

ROOT = Path(__file__).resolve().parents[2]


def until(operation, predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = operation()
        if predicate(value):
            return value
        time.sleep(0.1)
    raise AssertionError(f"condition timed out: {value}")


class Runtime:
    def __init__(self, command, root: Path, provider: Path, *, approval_policy="auto"):
        self.command, self.root = command, root
        self.workspace, self.profile = root / "workspace", root / "profile"
        self.workspace.mkdir()
        self.env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home()), "TMPDIR": "/tmp"}
        subprocess.run([*command, "init", "--profile", str(self.profile), "--workspace", str(self.workspace),
                        "--provider-config", str(provider), "--approval-policy", approval_policy, "--test-mode"], check=True, capture_output=True, env=self.env)
        self.log = (root / "host.log").open("w")
        self.process = None
        self.client = None
        self.attachments = {}

    def start(self):
        self.process = subprocess.Popen([*self.command, "serve", "--profile", str(self.profile)], env=self.env,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True)
        if not select.select([self.process.stdout], [], [], 260)[0]:
            raise TimeoutError("Host startup timeout")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Host exited; inspect host.log")
        self.ready = json.loads(line)
        self.client = httpx.Client(base_url=self.ready["url"], timeout=45, trust_env=False,
                                  headers={"Authorization": "Bearer " + (self.profile / "web.token").read_text(),
                                           "x-amazme-build": self.ready["build_id"],
                                           "x-amazme-epoch": str(self.ready["host_epoch"])} )
        self.attachments.clear()
        until(lambda: self.client.get("/api/v1/bootstrap"), lambda r: r.status_code == 200)
        schema = self.client.get("/openapi.json").json()
        (self.root / "openapi.json").write_text(json.dumps(schema, indent=2) + "\n")
        expected = ROOT / "backend/contracts/openapi.json"
        if expected.exists():
            assert json.loads(expected.read_text()) == schema, "Public OpenAPI schema drift"

    def session(self):
        r = self.client.post("/api/v1/sessions", json={"title": "P2 verification"})
        r.raise_for_status()
        session = r.json()["session_id"]
        self.attach(session)
        return session

    def attach(self, session):
        if session not in self.attachments:
            response = self.client.post(f"/api/v1/sessions/{session}/attachments")
            response.raise_for_status()
            self.attachments[session] = response.json()["attachment_id"]
        return {"x-amazme-attachment": self.attachments[session]}

    def submit(self, session, request, command):
        r = self.client.post(f"/api/v1/sessions/{session}/submissions", json={"request_id": request, "text": "/shell " + command}, headers=self.attach(session))
        r.raise_for_status()
        return r.json()

    def receipt(self, session, request):
        r = self.client.get(f"/api/v1/sessions/{session}/requests/{request}")
        r.raise_for_status()
        return r.json()

    def complete(self, session, request):
        return until(lambda: self.receipt(session, request),
                     lambda r: r["status"] in {"succeeded", "cancelled", "interrupted", "failed", "unknown"}, timeout=40)

    def worker(self, session):
        response = self.client.get("/api/v1/health")
        response.raise_for_status()
        worker = next(w for w in reversed(response.json()["supervisor"]["workers"])
                      if w["session_id"] == session and w["state"] != "stopped")
        return worker["worker_id"], worker["pid"], worker["socket"], worker["build_id"]

    def cleanup_receipt(self, session):
        with sqlite3.connect(self.profile / "execution.sqlite") as db:
            row = db.execute("SELECT state,receipt FROM epochs WHERE session=? ORDER BY epoch DESC LIMIT 1", (session,)).fetchone()
            return json.loads(row[1]) if row and row[0] == "clean" else None

    def vm_socket(self):
        return Path(json.loads((self.profile / "vm.json").read_text())["home"]) / "execution/sock/docker.sock"

    def stop(self):
        if self.process and self.process.poll() is None:
            if self.client is not None:
                r = self.client.post("/control/shutdown", headers={"Authorization": "Bearer " + (self.profile / "control.token").read_text()},
                                     json={"host_epoch": self.ready["host_epoch"], "build_id": self.ready["build_id"]})
                r.raise_for_status()
            else:
                self.process.send_signal(signal.SIGINT)
            self.process.wait(timeout=180)
            if self.client is not None:
                assert self.process.returncode == 0
        if self.client is not None:
            self.client.close()
            self.client = None

    def close(self):
        try:
            self.stop()
            result = until(lambda: subprocess.run([*self.command, "destroy-vm", "--profile", str(self.profile)], env=self.env,
                                                   capture_output=True, text=True, timeout=90),
                           lambda r: "BlockingIOError" not in r.stderr, timeout=30)
            if result.returncode:
                raise RuntimeError(result.stderr[-1500:])
        finally:
            self.log.close()
            config = self.profile / "config.json"
            value = json.loads(config.read_text())
            value["provider"]["api_key"] = ""
            private_write(config, json.dumps(value))


def daemon_command(marker):
    code = f"""import os,time
end=time.monotonic()+90
if os.fork()==0:
 os.setsid()
 if os.fork()!=0:os._exit(0)
 with open({marker!r},'a',buffering=1) as f:
  while time.monotonic()<end:
   f.write('x\\n');f.flush();os.fsync(f.fileno());time.sleep(.03)
 os._exit(0)
while time.monotonic()<end:time.sleep(.1)
"""
    return "python -I -c " + shlex.quote(code)



if __name__ == "__main__":
    from verify_p2 import main
    main()
