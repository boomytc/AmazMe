"""Run real Host/worker/supervisor/VM recovery checks in a new owned profile."""

import argparse
import concurrent.futures
import json
import os
import select
import shlex
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

from amazme_backend.common import private_write
from amazme_backend.contracts import ToolCall, WriteFile
from amazme_backend.worker import command_for

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
    def __init__(self, command, root: Path, provider: Path):
        self.command, self.root = command, root
        self.workspace, self.profile = root / "workspace", root / "profile"
        self.workspace.mkdir()
        self.env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home()), "TMPDIR": "/tmp"}
        subprocess.run([*command, "init", "--profile", str(self.profile), "--workspace", str(self.workspace),
                        "--provider-config", str(provider)], check=True, capture_output=True, env=self.env)
        self.log = (root / "host.log").open("w")
        self.process = None
        self.client = None

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
                                  headers={"Authorization": "Bearer " + (self.profile / "web.token").read_text()})
        until(lambda: self.client.get("/api/v1/bootstrap"), lambda r: r.status_code == 200)
        schema = self.client.get("/openapi.json").json()
        (self.root / "openapi.json").write_text(json.dumps(schema, indent=2) + "\n")
        expected = ROOT / "backend/contracts/openapi.json"
        if expected.exists():
            assert json.loads(expected.read_text()) == schema, "Public OpenAPI schema drift"

    def session(self):
        r = self.client.post("/api/v1/sessions", json={"title": "P1 verification"})
        r.raise_for_status()
        return r.json()["session_id"]

    def submit(self, session, request, command):
        r = self.client.post(f"/api/v1/sessions/{session}/submissions", json={"request_id": request, "text": "/shell " + command})
        r.raise_for_status()
        return r.json()

    def receipt(self, session, request):
        r = self.client.get(f"/api/v1/sessions/{session}/requests/{request}")
        r.raise_for_status()
        return r.json()

    def complete(self, session, request):
        return until(lambda: self.receipt(session, request),
                     lambda r: r["status"] not in {"queued", "running", "cancelling"}, timeout=40)

    def worker(self, session):
        with sqlite3.connect(self.profile / "execution.sqlite") as db:
            return db.execute("SELECT worker,pid,socket,build FROM workers WHERE session=?", (session,)).fetchone()

    def cleanup_receipt(self, session):
        with sqlite3.connect(self.profile / "execution.sqlite") as db:
            row = db.execute("SELECT state,receipt FROM epochs WHERE session=?", (session,)).fetchone()
            return json.loads(row[1]) if row and row[0] == "clean" else None

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


def run(command, root):
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    runtime = Runtime(command, root, provider)
    report = {"status": "running", "checks": {}, "root": str(root)}

    def record(name, value):
        report["checks"][name] = value
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(name, flush=True)

    try:
        runtime.start()
        report["identity"] = runtime.ready
        session = runtime.session()
        worker_socket = Path(runtime.worker(session)[2])
        assert stat.S_IMODE(worker_socket.stat().st_mode) == 0o600
        assert stat.S_IMODE((worker_socket.parent / "supervisor.sock").stat().st_mode) == 0o600
        unauthorized = httpx.get(runtime.ready["url"] + "/api/v1/bootstrap", trust_env=False)
        assert unauthorized.status_code == 401
        assert runtime.client.post("/api/v1/sessions", headers={"Origin": "https://evil.example"}, json={}).status_code == 403
        assert runtime.client.post("/api/v1/sessions", content=b"x" * 270000).status_code == 413
        duplicate = subprocess.run([*command, "serve", "--profile", str(runtime.profile)], env=runtime.env,
                                   capture_output=True, text=True, timeout=10)
        assert duplicate.returncode != 0 and "BlockingIOError" in duplicate.stderr
        deletion = subprocess.run([*command, "destroy-vm", "--profile", str(runtime.profile)], env=runtime.env,
                                  capture_output=True, text=True, timeout=10)
        assert deletion.returncode != 0 and "BlockingIOError" in deletion.stderr
        record("auth_limits_host_lock", True)
        record("active_vm_deletion_rejected", True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda _: runtime.submit(session, "dedup", "printf x >> once.txt; cat once.txt"), range(16)))
        assert {r["accepted_revision"] for r in results} == {"1"}
        done = runtime.complete(session, "dedup")
        assert done["status"] == "succeeded", done
        assert (runtime.workspace / "once.txt").read_text() == "x"
        response = runtime.client.post(f"/api/v1/sessions/{session}/submissions", json={"request_id": "dedup", "text": "different"})
        assert response.status_code == 409
        assert runtime.client.get(f"/api/v1/sessions/{session}/requests/dedup%3Fother").status_code == 404
        record("concurrent_dedup", {"requests": 16, "effects": 1, "receipt": done})

        runtime.submit(session, "cancel", daemon_command("cancel.log"))
        marker = runtime.workspace / "cancel.log"
        until(lambda: marker.stat().st_size if marker.exists() else 0, lambda n: n > 4)
        r = runtime.client.post(f"/api/v1/sessions/{session}/requests/cancel/cancel", json={})
        assert r.status_code == 202 and r.json()["status"] == "cancelling"
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            repeats = list(pool.map(lambda _: runtime.client.post(
                f"/api/v1/sessions/{session}/requests/cancel/cancel", json={}), range(24)))
        assert all(r.status_code == 202 and r.json()["status"] in {"cancelling", "cancelled"} for r in repeats)
        assert runtime.complete(session, "cancel")["status"] == "cancelled"
        receipt = runtime.cleanup_receipt(session)
        assert receipt and receipt["containers"]
        size = marker.stat().st_size
        time.sleep(.4)
        assert marker.stat().st_size == size
        runtime.submit(session, "after-cancel", "printf ready > after-cancel.txt")
        assert runtime.complete(session, "after-cancel")["status"] == "succeeded"
        record("cancel_detached_descendants", {"cleanup": receipt, "stable_bytes": size, "next_execution": "succeeded", "repeat_cancels": 24})

        runtime.submit(session, "kill", daemon_command("killed.log"))
        marker = runtime.workspace / "killed.log"
        until(lambda: marker.stat().st_size if marker.exists() else 0, lambda n: n > 4)
        old_worker = runtime.worker(session)
        # This PID belongs to the worker created by this test profile, checked by the private identity.
        with httpx.Client(transport=httpx.HTTPTransport(uds=old_worker[2]), base_url="http://ipc",
                          headers={"Authorization": "Bearer " + (runtime.profile / "control.token").read_text()}) as peer:
            assert peer.get('/identity').json()['instance_id'] == old_worker[0]
        os.kill(old_worker[1], signal.SIGKILL)
        receipt = until(lambda: runtime.cleanup_receipt(session), lambda x: x is not None)
        size = marker.stat().st_size
        time.sleep(.4)
        assert marker.stat().st_size == size
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            recovered_requests = list(pool.map(lambda _: runtime.receipt(session, "kill"), range(16)))
        recovered = recovered_requests[0]
        assert all(r == recovered for r in recovered_requests)
        assert recovered["status"] == "unknown", recovered
        assert runtime.worker(session)[0] != old_worker[0]
        runtime.submit(session, "after-kill", "printf recovered > after-kill.txt")
        assert runtime.complete(session, "after-kill")["status"] == "succeeded"
        record("worker_sigkill", {"cleanup": receipt, "recovered": recovered, "stable_bytes": size, "replacement": runtime.worker(session)[0]})

        runtime.submit(session, "host-restart", "sleep 3; printf x >> host-once.txt")
        until(lambda: runtime.receipt(session, "host-restart")["status"], lambda s: s == "running")
        worker = runtime.worker(session)
        old = runtime.ready.copy()
        runtime.process.kill()
        runtime.process.wait(timeout=5)
        runtime.client.close()
        runtime.start()
        assert runtime.ready["host_epoch"] > old["host_epoch"]
        assert runtime.complete(session, "host-restart")["status"] == "succeeded"
        assert runtime.worker(session)[0] == worker[0]
        assert (runtime.workspace / "host-once.txt").read_text() == "x"
        supervisor_socket = Path(worker[2]).parent / "supervisor.sock"
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(supervisor_socket)), base_url="http://ipc",
                          headers={"Authorization": "Bearer " + (runtime.profile / "control.token").read_text()}) as peer:
            stale = peer.post('/workers/stop', json={'session_id':session,'worker_id':worker[0],
                              'host_epoch':old['host_epoch'],'build_id':old['build_id']})
            mismatch = peer.post('/takeover', json={'host_epoch':runtime.ready['host_epoch'],'build_id':'other-build'})
            assert stale.status_code == mismatch.status_code == 409
        record("host_takeover", {"same_worker": True, "effects": 1, "old_epoch": old["host_epoch"],
                                  "new_epoch": runtime.ready["host_epoch"], "stale_stop":409, "build_mismatch":409})
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(supervisor_socket)), base_url="http://ipc", timeout=60,
                          headers={"Authorization": "Bearer " + (runtime.profile / "control.token").read_text()}) as peer:
            owner = {"session_id": session, "worker_id": worker[0], "build_id": runtime.ready["build_id"]}
            response = peer.post("/epochs/open", json=owner)
            response.raise_for_status()
            lease = response.json()
            content = ("\U0001f600'\n" * 10667)[:32000]
            try:
                call = ToolCall(id="large", name="write_file", arguments=WriteFile(path="large.txt", content=content).model_dump_json())
                compiled = command_for(call)
                result = peer.post("/tools/run", json={**lease, "call_id": "large-file-verification", **compiled.model_dump()})
                result.raise_for_status()
                assert result.json()["exit_code"] == 0, result.json()
                assert (runtime.workspace / "large.txt").read_text() == content
                record("max_file_payload", {"characters": len(content), "bytes": len(content.encode()), "exact_round_trip": True})
            finally:
                closed = peer.post("/epochs/close", json=lease)
                closed.raise_for_status()
                assert closed.json()["state"] == "clean"
        runtime.submit(session, "blocked", daemon_command("blocked.log"))
        marker = runtime.workspace / "blocked.log"
        until(lambda: marker.stat().st_size if marker.exists() else 0, lambda n: n > 4)
        control_socket = Path(runtime.worker(session)[2]).parent / "vm/execution/sock/docker.sock"
        held_socket = control_socket.with_name("docker.held.sock")
        control_socket.rename(held_socket)
        try:
            time.sleep(6)  # Let the runtime HTTP pool's prior idle connection expire.
            response = runtime.client.post(f"/api/v1/sessions/{session}/requests/blocked/cancel", json={})
            assert response.status_code == 202
            snapshot = until(lambda: runtime.client.get(f"/api/v1/sessions/{session}/snapshot").json(),
                             lambda s: s.get("state") == "blocked")
            response = runtime.client.post(f"/api/v1/sessions/{session}/submissions",
                                           json={"request_id":"must-not-run","text":"/shell touch unsafe.txt"})
            assert response.status_code == 503
            assert not (runtime.workspace / "unsafe.txt").exists()
            assert runtime.receipt(session, "blocked")["status"] == "cancelling"
            before = marker.stat().st_size
            time.sleep(.3)
            assert marker.stat().st_size > before
            record("cleanup_blocked_admission", {"state": snapshot["state"], "new_submission_http":503,
                    "old_effects_still_active":True, "false_cancelled_status":False})
        finally:
            held_socket.rename(control_socket)
        runtime.stop()
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            failed_start = subprocess.run([*command, "serve", "--profile", str(runtime.profile),
                                           "--port", str(occupied.getsockname()[1])], env=runtime.env,
                                          capture_output=True, text=True, timeout=120)
            assert failed_start.returncode != 0 and "Address already in use" in failed_start.stderr
        record("failed_start_releases_owned_services", True)
        runtime.start()
        assert runtime.receipt(session, "dedup")["status"] == "succeeded"
        runtime.submit(session, "dedup", "printf x >> once.txt; cat once.txt")
        assert (runtime.workspace / "once.txt").read_text() == "x"
        runtime.submit(session, "cold-restart", "printf cold > cold.txt")
        assert runtime.complete(session, "cold-restart")["status"] == "succeeded"
        record("full_stop_restart", True)
        report["status"] = "passed"
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            runtime.close()
            report["cleanup"] = "owned services stopped and VM deleted"
        except BaseException as error:
            report["status"] = "failed"
            report["cleanup_error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(root / "report.json", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    parent = ROOT / ".artifacts/python-backend-p1"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="runtime-", dir=parent))
    command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "amazme_backend"]
    run(command, root)
