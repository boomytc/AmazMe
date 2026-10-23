"""Opt-in real P2 fault matrix; never imports the concurrently edited backend.

Run with the backend venv's Python and an immutable packaged executable:
  python tools/verify_p2.py --executable '/bundle A/amazme-backend' --case core
  python tools/verify_p2.py --executable '/bundle A/amazme-backend' \
      --target-executable '/bundle B/amazme-backend' --case 'update.*'

--list only lists cases. A run owns one fresh temporary HOME/profile/workspace,
uses faux/auto/test-mode, and retains evidence there. approval.wait alone uses a
second fresh mutations profile. No existing profile is accepted. Cases share
their VM, reuse at most three session slots with distinct request IDs/files, and explicitly reset
restart budgets through /control/recover after settling a crash. A failed case
stops the group; remaining selected cases are reported as not_run, never passed.
SIGINT, failures and normal exit all attempt stop AND destroy-vm in finally.

Fault plans are one-shot rendezvous, not timing guesses. Supervisor.closed has
only session_id: warm the worker before arming it, or its startup empty epoch
would consume the plan. The before_commit hook pauses acceptance before COMMIT;
other session hooks pause after COMMIT. SQLite FULL is covered by storage tests;
this runner does not claim hardware sleep or physical power-loss coverage.
approval.auto tests rejection under auto; approval.wait
actually crashes/restarts the separately owned mutations profile.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import fnmatch
import hashlib
import json
import os
import queue
import re
import secrets
import shlex
import signal
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import httpx

TERMINAL = {"succeeded", "cancelled", "interrupted", "failed", "unknown"}
WORKER_POINTS = ("model_intent", "model_result", "tool_intent", "tool_result", "decision", "cleanup")
SUPERVISOR_POINTS = ("create_intent", "created", "registered", "started", "before_permit",
                     "permitted", "result", "closed")
TRANSIENT = {"runtime_recovering", "supervisor_unavailable", "worker_startup_failed", "startup_timeout",
             "worker_startup_timeout", "execution_blocked", "worker_retirement_pending",
             "worker_fence_pending", "process_exit_pending", "supervisor_startup_failed",
             "worker_identity_mismatch"}


def require(condition: object, message: str) -> None:
    # Unlike Python assert, safety checks remain enabled under python -O.
    if not condition:
        raise AssertionError(message)


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"Expected object: {path}")
    return value


def write_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + "." + secrets.token_hex(4))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def wait_for(operation: Callable, predicate: Callable, *, timeout: float, label: str):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = operation()
        if predicate(last):
            return last
        time.sleep(0.1)
    raise AssertionError(f"{label}: timed out after {timeout}s; last={str(last)[:2000]}")


class HTTPFailure(RuntimeError):
    def __init__(self, response: httpx.Response):
        try:
            self.body = response.json()
        except ValueError:
            self.body = {"code": "non_json_response", "message": response.text[:1000]}
        self.status = response.status_code
        self.code = self.body.get("code", "http_error")
        super().__init__(f"HTTP {self.status}: {self.body}")


def decoded(response: httpx.Response):
    if response.is_error:
        raise HTTPFailure(response)
    return response.json()


@dataclass
class Build:
    executable: Path
    build_id: str
    identities: dict[Path, tuple] = field(repr=False)

    @classmethod
    def load(cls, executable: Path) -> Build:
        executable = executable.resolve(strict=True)
        require(executable.is_file() and os.access(executable, os.X_OK), "Executable required")
        root = executable.parent
        manifest = read_json(root / "build.json")
        require(set(manifest) == {"version", "nonce", "files", "build_id"}, "Unsupported frozen manifest")
        require(manifest["version"] == "0.1.0", "This matrix requires two P2 0.1.0 builds")
        digest = hashlib.sha256(json.dumps({k: v for k, v in manifest.items() if k != "build_id"},
                                          sort_keys=True).encode()).hexdigest()
        require(digest == manifest["build_id"], "Frozen manifest digest mismatch")
        require(executable.name in manifest["files"], "Executable is not covered by build manifest")
        identities = {}
        for name, expected in manifest["files"].items():
            path = root / name
            require(path.resolve(strict=True).is_relative_to(root), "Bundle member escapes bundle")
            with path.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            require(actual == expected, f"Bundle checksum mismatch: {name}")
            identities[path] = cls.stamp(path)
        identities[root / "build.json"] = cls.stamp(root / "build.json")
        return cls(executable, digest, identities)

    @staticmethod
    def stamp(path: Path) -> tuple:
        s = path.stat()
        return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns

    def unchanged(self) -> None:
        for path, original in self.identities.items():
            require(self.stamp(path) == original, f"Immutable build changed during run: {path}")


@dataclass
class Evidence:
    name: str
    path: Path
    data: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.data = {"case": self.name, "status": "running", "started_unix": time.time(),
                     "assertions": [], "observations": []}
        self.flush()

    def flush(self) -> None:
        write_json(self.path, self.data)

    def observe(self, name: str, value: object) -> None:
        self.data["observations"].append({"name": name, "value": value})
        self.flush()

    def check(self, name: str, condition: object, actual: object = None) -> None:
        self.data["assertions"].append({"assert": name, "passed": bool(condition), "actual": actual})
        self.flush()
        require(condition, f"{self.name}: {name}; actual={actual}")

    def finish(self, status: str, error: str = "") -> None:
        self.data.update(status=status, error=error, ended_unix=time.time())
        self.flush()


@dataclass(frozen=True)
class Actor:
    role: str
    instance: str
    pid: int
    lease: dict
    build_id: str
    session: str = ""


@dataclass
class Rendezvous:
    runtime: Runtime
    role: str
    point: str
    match: dict
    nonce: str = field(default_factory=lambda: secrets.token_hex(8))

    @property
    def plan(self) -> Path:
        return self.runtime.profile / "faults" / f"{self.role}.{self.point}.json"

    def reached(self) -> dict:
        marker = self.plan.parent / f"{self.nonce}.reached.json"
        result = wait_for(lambda: read_json(marker) if marker.exists() else None, bool,
                          timeout=self.runtime.timeout, label=f"fault {self.role}.{self.point} not reached")
        require((result.get("nonce"), result.get("role"), result.get("point")) ==
                (self.nonce, self.role, self.point), "Fault marker identity mismatch")
        require(all(result.get("context", {}).get(k) == v for k, v in self.match.items()),
                "Fault marker scope mismatch")
        consumed = read_json(self.plan.parent / f"{self.nonce}.consumed.json")
        require(consumed == {"nonce": self.nonce, "match": self.match}, "Fault plan consumption mismatch")
        self.runtime.note("fault_reached", result)
        return result

    def release(self) -> None:
        path = self.plan.parent / f"{self.nonce}.release"
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        # Remove only our own still-unconsumed plan.
        if self.plan.exists() and read_json(self.plan).get("nonce") == self.nonce:
            self.plan.unlink()


class PendingHTTP:
    """Capture the destination before a takeover; never silently retry an old request."""

    def __init__(self, operation: Callable[[], httpx.Response]):
        self.result: queue.Queue = queue.Queue(maxsize=1)

        def run() -> None:
            try:
                self.result.put(operation())
            except Exception as error:
                self.result.put(error)
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def finish(self, runtime: Runtime, *, lost_reply: bool = False):
        value = self.result.get(timeout=runtime.timeout + 10)
        if isinstance(value, Exception):
            runtime.note("http_waiter", {"error": type(value).__name__, "detail": str(value)[:1000]})
            if lost_reply and isinstance(value, httpx.TransportError):
                return None
            raise value
        runtime.note("http_waiter", {"status": value.status_code, "body": value.text[:2000]})
        if lost_reply and value.status_code in {502, 503, 504}:
            return None
        return decoded(value)


class Runtime:
    def __init__(self, root: Path, build: Build, timeout: float):
        self.root, self.build, self.timeout = root, build, timeout
        self.profile = (root / "p").resolve()
        self.workspace = (root / "w").resolve()
        self.home = root / "h"
        self.workspace.mkdir(mode=0o700)
        self.home.mkdir(mode=0o700)
        self.env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": "/tmp",
                    "LANG": "en_US.UTF-8", "PYTHONNOUSERSITE": "1"}
        self.ready: dict = {}
        self.attachments: dict[str, str] = {}
        self.sessions: list[str] = []
        self.case_sessions: set[str] = set()
        self.build_paths = {build.build_id: build.executable}
        self.process: subprocess.Popen | None = None
        self.hosts: list[subprocess.Popen] = []
        self.log_threads: list[threading.Thread] = []
        self.faults: list[Rendezvous] = []
        self.actors: dict[str, Actor] = {}
        self.paused: dict[str, Actor] = {}
        self.host_paused = False
        self.evidence: Evidence | None = None
        self.control_token = self.web_token = self.profile_id = ""
        self.initialized = False

    def note(self, name: str, value: object) -> None:
        if self.evidence:
            self.evidence.observe(name, value)

    def cli(self, mode: str, *extra: str, timeout: float = 240) -> subprocess.CompletedProcess:
        self.build.unchanged()
        return subprocess.run([str(self.build.executable), mode, "--profile", str(self.profile), *extra],
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, env=self.env,
                              cwd=self.root, timeout=timeout)

    def init(self, approval_policy: str = "auto") -> None:
        require(approval_policy in {"auto", "mutations"}, "Unsupported verification profile policy")
        faux = self.root / "faux.json"
        write_json(faux, {"provider": "faux", "api_key": ""})
        result = self.cli("init", "--workspace", str(self.workspace), "--provider-config", str(faux),
                          "--test-mode", "--approval-policy", approval_policy, timeout=30)
        require(result.returncode == 0, f"init failed: {result.stderr[-2000:]}")
        config = read_json(self.profile / "config.json")
        require(config["format"] == 2 and config["testing"] is True and
                config["approval_policy"] == approval_policy and config["workspace"] == str(self.workspace) and
                config["provider"]["provider"] == "faux" and not config["provider"].get("api_key"),
                "CLI did not initialize the requested isolated faux test profile")
        self.profile_id = config["profile_id"]
        # These are freshly generated local test capabilities, not user credentials.
        self.control_token = (self.profile / "control.token").read_text().strip()
        self.web_token = (self.profile / "web.token").read_text().strip()
        require(self.control_token and self.web_token and self.control_token != self.web_token,
                "Test control/web tokens must be separate")
        (self.profile / "faults").mkdir(mode=0o700, exist_ok=True)
        self.initialized = True

    def start(self, build: Build | None = None, *, expected_states: tuple[str, ...] = ("ready",)) -> None:
        require(self.process is None or self.process.poll() is not None, "Previous owned Host still alive")
        self.build = build or self.build
        self.build_paths[self.build.build_id] = self.build.executable
        self.build.unchanged()
        self.attachments.clear()
        index = len(self.hosts)
        ready_lines: queue.Queue = queue.Queue()
        with (self.root / f"host-{index}.stderr.log").open("ab") as log:
            process = subprocess.Popen([str(self.build.executable), "serve", "--profile", str(self.profile)],
                                       env=self.env, cwd=self.root, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        self.process = process
        self.hosts.append(process)

        def drain() -> None:
            require(process.stdout is not None, "Missing stdout pipe")
            with process.stdout, (self.root / f"host-{index}.stdout.log").open("ab") as log:
                for line in iter(process.stdout.readline, b""):
                    log.write(line)
                    log.flush()
                    ready_lines.put(line)
        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        self.log_threads.append(thread)
        deadline = time.monotonic() + max(self.timeout, 300)
        while time.monotonic() < deadline:
            try:
                line = ready_lines.get(timeout=0.1)
            except queue.Empty:
                require(process.poll() is None, f"Host exited before readiness; see host-{index}.stderr.log")
                continue
            try:
                ready = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(ready, dict) and "url" in ready:
                break
        else:
            raise TimeoutError("No stdout readiness from CLI")
        url = urlparse(ready["url"])
        require(url.scheme == "http" and url.hostname == "127.0.0.1" and url.port and
                not url.username and not url.password and url.path in {"", "/"}, "Non-loopback readiness URL")
        require((ready["pid"], ready["profile_id"], ready["build_id"], ready["role"], ready["fingerprint"]) ==
                (process.pid, self.profile_id, self.build.build_id, "host", self.build.build_id),
                "Host stdout identity does not match owned Popen/profile/build")
        require(ready["host_epoch"] > self.ready.get("host_epoch", 0), "Host epoch did not advance")
        self.ready = ready
        bootstrap = self.poll(lambda: self.api("GET", "/api/v1/bootstrap"), lambda x: bool(x), "bootstrap")
        self.note("stdout_readiness", ready)
        self.note("bootstrap", bootstrap)
        health = self.poll(self.health, lambda h: h["state"] in expected_states,
                           "Host health " + "/".join(expected_states), timeout=max(self.timeout, 300))
        self.note("startup_health", health)

    def fence(self) -> dict:
        return {"host_epoch": self.ready["host_epoch"], "build_id": self.ready["build_id"]}

    def headers(self, *, session: str = "", control: bool = False) -> dict:
        result = {"Authorization": "Bearer " + (self.control_token if control else self.web_token),
                  "X-AmazMe-Epoch": str(self.ready["host_epoch"]), "X-AmazMe-Build": self.ready["build_id"]}
        if session:
            if session not in self.attachments:
                attachment = self.api("POST", f"/api/v1/sessions/{session}/attachments", {})
                require((attachment["session_id"], attachment["host_epoch"], attachment["build_id"]) ==
                        (session, self.ready["host_epoch"], self.ready["build_id"]), "Attachment scope mismatch")
                self.attachments[session] = attachment["attachment_id"]
            result["X-AmazMe-Attachment"] = self.attachments[session]
        return result

    def raw(self, method: str, path: str, body: dict | None = None, *, session: str = "",
            control: bool = False, headers: dict | None = None) -> httpx.Response:
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            return client.request(method, self.ready["url"] + path, json=body,
                                  headers=headers if headers is not None else self.headers(session=session, control=control))

    def api(self, method: str, path: str, body: dict | None = None, **kwargs):
        return decoded(self.raw(method, path, body, **kwargs))

    def pending(self, method: str, path: str, body: dict, *, session: str = "",
                control: bool = False) -> PendingHTTP:
        url, headers = self.ready["url"] + path, self.headers(session=session, control=control)
        def request() -> httpx.Response:
            with httpx.Client(timeout=self.timeout, trust_env=False) as client:
                return client.request(method, url, json=body, headers=headers)
        return PendingHTTP(request)

    def private(self, socket: Path, method: str, path: str, body: dict | None = None) -> httpx.Response:
        require(socket.parent == self.ipc(), "Private socket outside owned profile IPC")
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(socket)), base_url="http://ipc",
                          timeout=self.timeout, trust_env=False) as client:
            return client.request(method, path, json=body, headers={"Authorization": "Bearer " + self.control_token})

    def ipc(self) -> Path:
        key = hashlib.sha256(str(self.profile).encode()).hexdigest()[:16]
        return Path(f"/tmp/amazme-{os.getuid()}-{key}")

    def poll(self, operation: Callable, predicate: Callable, label: str, timeout: float | None = None):
        def sample():
            try:
                return operation()
            except httpx.TransportError:
                return None
            except HTTPFailure as error:
                if error.code in TRANSIENT or (error.status == 404 and error.code == "request_not_found"):
                    return None
                raise
        return wait_for(sample, lambda v: v is not None and predicate(v), timeout=timeout or self.timeout, label=label)

    def health(self) -> dict:
        return self.api("GET", "/api/v1/health")

    def session(self, title: str) -> str:
        # Reuse bounded slots: Host restart rediscovers every durable session.
        # Unbounded per-case sessions would exhaust Supervisor's eight-worker cap.
        session = next((s for s in self.sessions if s not in self.case_sessions), "")
        if not session:
            session = self.api("POST", "/api/v1/sessions", {"title": title[:100]})["session_id"]
            self.sessions.append(session)
        self.case_sessions.add(session)
        self.note("case_session", {"session_id": session, "purpose": title})
        self.headers(session=session)
        self.poll(lambda: self.snapshot(session), lambda s: s["state"] == "ready", "warm session")
        return session

    def snapshot(self, session: str) -> dict:
        return self.api("GET", f"/api/v1/sessions/{session}/snapshot")

    def submit(self, session: str, request: str, text: str, **extra) -> dict:
        return self.api("POST", f"/api/v1/sessions/{session}/submissions",
                        {"request_id": request, "text": text, **extra}, session=session)

    def send(self, session: str, request: str, text: str, **extra) -> PendingHTTP:
        return self.pending("POST", f"/api/v1/sessions/{session}/submissions",
                            {"request_id": request, "text": text, **extra}, session=session)

    def receipt(self, session: str, request: str) -> dict:
        return self.api("GET", f"/api/v1/sessions/{session}/requests/{request}")

    def terminal(self, session: str, request: str) -> dict:
        receipt = self.poll(lambda: self.receipt(session, request), lambda r: r["status"] in TERMINAL,
                            f"terminal receipt {request}")
        self.note("terminal_receipt", receipt)
        return receipt

    def arm(self, role: str, point: str, **match: str) -> Rendezvous:
        fault = Rendezvous(self, role, point, match)
        require(not fault.plan.exists(), "An unconsumed fault plan is already armed")
        write_json(fault.plan, {"nonce": fault.nonce, "match": match})
        self.faults.append(fault)
        self.note("fault_armed", {"role": role, "point": point, "nonce": fault.nonce, "match": match})
        return fault

    def sql(self, database: Path, statement: str, args: tuple = ()) -> list[dict]:
        require(database.resolve().is_relative_to(self.profile), "Database outside owned profile")
        with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(statement, args)]

    def steps(self, session: str, request: str) -> list[dict]:
        return [json.loads(r["payload"]) for r in self.sql(self.profile / "sessions" / session / "session.sqlite",
                "SELECT payload FROM steps WHERE request_id=? ORDER BY ordinal", (request,))]

    def registry(self) -> list[Actor]:
        actors = []
        for database, statement, role in (
            (self.profile / "execution.sqlite", "SELECT info AS payload FROM workers", "worker"),
            (self.profile / "host.sqlite", "SELECT payload FROM services", "supervisor"),
        ):
            if not database.exists():
                continue
            for row in self.sql(database, statement):
                value = json.loads(row["payload"])
                lease = value.get("process_lease")
                if lease and value.get("pid", 0) > 0:
                    actor = Actor(role, value["worker_id"] if role == "worker" else value["instance_id"],
                                  value["pid"], lease, value["build_id"], value.get("session_id", ""))
                    actors.append(actor)
                    self.actors[actor.instance] = actor
        return actors

    def actor(self, marker: dict) -> Actor:
        matching = [a for a in self.registry() if (a.role, a.instance, a.pid) ==
                    (marker["role"], marker["instance"], marker["pid"])]
        require(len(matching) == 1, "Exact fault PID/instance absent from owned registry")
        actor = matching[0]
        if actor.role == "worker":
            require(marker["context"].get("session_id") == actor.session, "Fault/worker session mismatch")
        self.validate_actor(actor)
        return actor

    def lease_open(self, actor: Actor) -> tuple[int, bool]:
        expected = self.profile / "processes" / f"{actor.role}-{actor.instance}.lock"
        lease = actor.lease
        require((lease["role"], lease["instance_id"], lease["profile_path"], lease["path"]) ==
                (actor.role, actor.instance, str(self.profile), str(expected)), "Foreign process lease")
        require(expected.parent.resolve() == expected.parent, "Symlinked process directory")
        fd = os.open(expected, os.O_RDWR | os.O_NOFOLLOW)
        try:
            current, inode = expected.lstat(), os.fstat(fd)
            require(stat.S_ISREG(inode.st_mode) and inode.st_uid == os.getuid() and
                    stat.S_IMODE(inode.st_mode) == 0o600 and
                    (inode.st_dev, inode.st_ino) == (current.st_dev, current.st_ino) ==
                    (lease["device"], lease["inode"]), "Lease inode/owner mismatch")
            require(json.loads(os.pread(fd, 16384, 0)) == lease, "Lease metadata mismatch")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return fd, False
            return fd, True
        except BaseException:
            os.close(fd)
            raise

    def exited(self, actor: Actor) -> bool:
        fd, dead = self.lease_open(actor)
        os.close(fd)
        return dead

    def validate_actor(self, actor: Actor) -> None:
        require(actor.pid > 1 and actor.pid != os.getpid(), "Unsafe target PID")
        require(not self.exited(actor), "Lease already released; refusing to signal reused PID")
        observed = subprocess.run(["/bin/ps", "-ww", "-p", str(actor.pid), "-o", "uid=", "-o", "command="],
                                  capture_output=True, text=True, timeout=3, env=self.env)
        fields = observed.stdout.strip().split(None, 1)
        require(observed.returncode == 0 and len(fields) == 2 and int(fields[0]) == os.getuid(),
                "Process UID could not be verified")
        command = fields[1]
        executable = self.build_paths.get(actor.build_id)
        require(executable is not None and command.startswith(f"{executable} {actor.role} ") and
                re.search(r"--profile\s+" + re.escape(str(self.profile)) + r"(?:\s|$)", command) and
                re.search(r"--instance\s+" + re.escape(actor.instance) + r"(?:\s|$)", command),
                "PID command does not identify this profile/instance/role")
        require(not self.exited(actor), "Process lease released during identity validation")

    def signal_actor(self, actor: Actor, sig: int) -> None:
        # Linux pins PID identity when possible; macOS uses the paused rendezvous,
        # exact instance command and held kernel lease, checked immediately before kill.
        descriptor = os.pidfd_open(actor.pid) if hasattr(os, "pidfd_open") else None
        try:
            self.validate_actor(actor)
            if descriptor is not None:
                signal.pidfd_send_signal(descriptor, sig)
            else:
                os.kill(actor.pid, sig)
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if sig == signal.SIGSTOP:
            self.paused[actor.instance] = actor
        elif sig in {signal.SIGCONT, signal.SIGKILL}:
            self.paused.pop(actor.instance, None)
        self.note("signal", {"signal": sig, "actor": actor.__dict__})

    def kill_host(self, marker: dict | None = None) -> None:
        require(self.process is not None and self.process.poll() is None, "Owned Host is not alive")
        if marker:
            require((marker["pid"], marker["instance"], marker["role"]) ==
                    (self.process.pid, self.ready["instance_id"], "host"), "Host marker/Popen mismatch")
        self.process.kill()
        self.process.wait(timeout=15)
        self.host_paused = False
        self.note("host_sigkill", {"pid": self.process.pid, "instance": self.ready.get("instance_id", "pre-readiness")})

    def recover(self, session: str) -> None:
        # New ID means an explicit, auditable budget reconciliation, not an implicit retry loop.
        identity = secrets.token_hex(16)
        result = self.api("POST", "/control/recover", {**self.fence(), "recovery_id": identity,
                          "session_id": session}, control=True)
        self.note("explicit_recovery", {"recovery_id": identity, "session_id": session, "health": result})

    def vm_owner(self) -> dict:
        locator = read_json(self.profile / "vm.json")
        key = hashlib.sha256(str(self.profile).encode()).hexdigest()[:24]
        expected = self.home / ".amazme-vm" / key
        require(Path(locator["home"]) == expected, "VM home is not under fresh test HOME")
        require((locator["profile_id"], locator["profile_path"]) == (self.profile_id, str(self.profile)),
                "Foreign VM locator")
        owner = read_json(expected / "owner.json")
        require(owner == {k: locator[k] for k in ("vm_id", "profile_id", "profile_path")}, "VM owner mismatch")
        return locator

    def close(self) -> dict:
        result: dict = {"status": "running", "steps": [], "errors": []}
        def attempt(name: str, action: Callable):
            try:
                value = action()
                result["steps"].append({"name": name, "result": value})
                return True
            except Exception as error:
                result["errors"].append({"step": name, "error": str(error)})
                return False

        for fault in self.faults:
            attempt("release_" + fault.nonce, fault.release)
        for actor in list(self.paused.values()):
            attempt("resume_" + actor.instance, lambda a=actor: self.signal_actor(a, signal.SIGCONT))
        if self.host_paused and self.process and self.process.poll() is None:
            attempt("resume_host", lambda: self.process.send_signal(signal.SIGCONT))
            self.host_paused = False
        if self.initialized:
            attempt("discover_owned_registry", lambda: [a.__dict__ for a in self.registry()])
            if self.process is None or self.process.poll() is not None:
                attempt("restart_for_shutdown", lambda: self.start(expected_states=("ready", "frozen", "blocked")))

            def stop() -> dict:
                completed = self.cli("stop", timeout=240)
                require(completed.returncode == 0, f"CLI stop failed: {completed.stderr[-2000:]}")
                if self.process:
                    self.process.wait(timeout=30)
                    require(self.process.returncode == 0, "Host shutdown was not clean")
                for actor in self.registry():
                    require(self.exited(actor), f"CLI stop left a live process lease: {actor.instance}")
                return {"returncode": completed.returncode, "stdout": completed.stdout[-1000:]}
            stopped = attempt("stop", stop)
            if not stopped:
                # Emergency cleanup never selects by a bare PID or by process name.
                if self.process and self.process.poll() is None:
                    attempt("kill_owned_host", self.kill_host)
                attempt("read_owned_registry", lambda: [a.__dict__ for a in self.registry()])
                for actor in list(self.actors.values()):
                    def kill_if_live(a=actor):
                        if not self.exited(a):
                            self.signal_actor(a, signal.SIGKILL)
                        wait_for(lambda: self.exited(a), bool, timeout=15, label="cleanup process exit")
                    attempt("retire_" + actor.instance, kill_if_live)

            def destroy() -> dict:
                locator = self.vm_owner() if (self.profile / "vm.json").exists() else None
                completed = self.cli("destroy-vm", timeout=240)
                require(completed.returncode == 0, f"destroy-vm failed: {completed.stderr[-2000:]}")
                locator = locator or self.vm_owner()
                require(not (Path(locator["home"]) / "execution").exists(), "VM instance directory remains")
                return {"returncode": completed.returncode, "instance_absent": True}
            attempt("destroy_vm", destroy)
            for actor in list(self.actors.values()):
                attempt("exit_proof_" + actor.instance,
                        lambda a=actor: require(self.exited(a), f"Process still holds lease: {a.instance}"))
        elif self.process and self.process.poll() is None:
            attempt("kill_owned_startup", self.kill_host)
        result["status"] = "failed" if result["errors"] else "passed"
        return result


def marker_command(name: str) -> str:
    require(re.fullmatch(r"[a-zA-Z0-9_.-]+", name), "Unsafe test marker name")
    script = (f"import os; f=open('/workspace/{name}','ab',buffering=0); "
              "f.write(b'once\\n'); os.fsync(f.fileno()); f.close(); print('recorded')")
    return "python -I -c " + shlex.quote(script)


def contents(runtime: Runtime, name: str) -> bytes:
    path = runtime.workspace / name
    require(path.resolve().is_relative_to(runtime.workspace), "Marker outside test workspace")
    return path.read_bytes() if path.exists() else b""


def worker_info(runtime: Runtime, session: str) -> dict:
    def current():
        health = runtime.health()
        return next((w for w in (health.get("supervisor") or {}).get("workers", [])
                     if w["session_id"] == session and w["state"] == "ready"), None)
    return runtime.poll(current, bool, "ready worker registry")


def check_clean(runtime: Runtime, evidence: Evidence, session: str) -> None:
    def epochs():
        supervisor = runtime.health().get("supervisor")
        return [e for e in supervisor["epochs"] if e["session_id"] == session] if supervisor else None
    values = runtime.poll(epochs, lambda rows: bool(rows) and all(r["state"] == "clean" for r in rows),
                          "all session epochs clean")
    evidence.check("each epoch has an exact durable cleanup proof", all(
        e.get("cleanup") and e["cleanup"]["state"] == "clean" and e["cleanup"]["proof_id"] and
        e["cleanup"]["session_id"] == session and e["cleanup"]["execution_epoch"] == e["execution_epoch"]
        and e["cleanup"]["vm_id"] for e in values), values)


def acceptance_once(runtime: Runtime, evidence: Evidence, session: str, request: str) -> None:
    database = runtime.profile / "sessions" / session / "session.sqlite"
    rows = runtime.sql(database, "SELECT payload FROM batches ORDER BY seq")
    accepted = [event for row in rows for event in json.loads(row["payload"])["events"]
                if event["kind"] == "accepted" and event["request_id"] == request]
    evidence.check("one durable acceptance event", len(accepted) == 1, len(accepted))
    rows = runtime.sql(database, "SELECT payload FROM messages WHERE request_id=? ORDER BY ordinal", (request,))
    messages = [json.loads(row["payload"]) for row in rows]
    calls = [m["tool_call_id"] for m in messages if m["role"] == "tool"]
    evidence.check("no duplicated tool-result message", len(calls) == len(set(calls)), calls)


def holds_for(runtime: Runtime, session: str, request: str) -> list[dict]:
    supervisor = runtime.health().get("supervisor")
    require(supervisor is not None, "Supervisor health unavailable")
    return [h for h in supervisor["effects"] if h["session_id"] == session and h["request_id"] == request]


def reconcile(runtime: Runtime, evidence: Evidence, session: str, request: str, marker: str,
              *, required: bool) -> None:
    holds = holds_for(runtime, session, request)
    if required:
        evidence.check("unknown write has an explicit unresolved hold", bool(holds) and
                       all(not h["reconciled"] for h in holds), holds)
    if not holds:
        return
    evidence.check("effect reconciliation cannot precede cleanup", all(h["resource_clean"] for h in holds), holds)
    # A different session proves the hold is profile-wide. If cleanup left the
    # supervisor barrier up, refusal to spawn is the admission result; do not wait it out.
    probe = next((item for item in runtime.sessions if item not in runtime.case_sessions), "")
    if not probe:
        probe = runtime.api("POST", "/api/v1/sessions", {"title": "hold diagnostic " + evidence.name})["session_id"]
        runtime.sessions.append(probe)
    runtime.case_sessions.add(probe)
    runtime.note("case_session", {"session_id": probe, "purpose": "hold diagnostic " + evidence.name})
    blocked_marker = secrets.token_hex(8) + "-must-not-write"
    barrier = False
    try:
        runtime.snapshot(probe)
    except HTTPFailure as error:
        if error.code not in {"diagnostic_worker_unavailable", "execution_blocked", "worker_retirement_pending",
                               "worker_restart_budget_exhausted"}:
            raise
        health = runtime.health()
        supervisor = health.get("supervisor") or {}
        evidence.check("blocked profile refuses a new execution worker",
                       bool(supervisor.get("blocked")) or health.get("state") == "blocked",
                       {"code": error.code, "state": health.get("state"), "blocked": supervisor.get("blocked")})
        evidence.check("refused admission produced no marker", not contents(runtime, blocked_marker))
        barrier = True
    else:
        info = worker_info(runtime, probe)
        owner = {"session_id": probe, "worker_id": info["worker_id"], "build_id": info["build_id"]}
        socket = runtime.ipc() / "supervisor.sock"
        lease = decoded(runtime.private(socket, "POST", "/epochs/open", owner))
        try:
            response = runtime.private(socket, "POST", "/tools/run", {**lease, "request_id": "hold-probe",
                "call_id": secrets.token_hex(16), "effect": "write", "command": marker_command(blocked_marker),
                "timeout_seconds": 10})
            evidence.check("unknown hold rejects real conflicting write admission",
                           response.status_code == 503 and response.json().get("code") == "unknown_effect_conflict",
                           {"status": response.status_code, "body": response.text})
            evidence.check("rejected conflicting write produced no marker", not contents(runtime, blocked_marker))
        finally:
            proof = decoded(runtime.private(socket, "POST", "/epochs/close", lease))
            evidence.check("diagnostic epoch cleaned", proof["state"] == "clean" and proof["proof_id"], proof)
    data = contents(runtime, marker)
    for hold in holds:
        resolution = {"resolution_id": secrets.token_hex(16), "call_id": hold["call_id"],
                      "outcome": "applied" if data else "not_applied", "evidence": json.dumps({
                          "source": "owned-workspace-after-cleanup", "marker": marker,
                          "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                          "observed_utf8": data.decode(), "cleanup": hold}, sort_keys=True)}
        evidence.observe("explicit_effect_evidence", resolution)
        runtime.api("POST", f"/api/v1/sessions/{session}/effects/resolve", resolution, session=session)
        repeated = runtime.api("POST", f"/api/v1/sessions/{session}/effects/resolve", resolution, session=session)
        evidence.check("reconcile does not rewrite the historical unknown receipt",
                       repeated["status"] in {"unknown", "cancelled"}, repeated)
    reconciled = runtime.poll(lambda: holds_for(runtime, session, request),
                             lambda hs: bool(hs) and all(h["reconciled"] and h["resource_clean"] for h in hs),
                             "durable effect reconciliation")
    evidence.observe("reconciled_holds", reconciled)
    if barrier:
        for existing in list(runtime.sessions):
            runtime.recover(existing)
        runtime.poll(lambda: runtime.health(), lambda health: health["state"] == "ready",
                     "explicit recovery opens the execution barrier")
    follow = secrets.token_hex(8) + "-after-reconcile"
    runtime.submit(probe, follow, "/shell " + marker_command(follow))
    receipt = runtime.terminal(probe, follow)
    evidence.check("a new write succeeds only after explicit evidence reconciliation",
                   receipt["status"] == "succeeded" and contents(runtime, follow) == b"once\n", receipt)


def stream_case(runtime: Runtime, evidence: Evidence) -> None:
    from websockets.exceptions import ConnectionClosed
    from websockets.sync.client import connect

    session = runtime.session(evidence.name)
    url = runtime.ready["url"].replace("http://", "ws://") + "/api/v1/events/" + session

    def open_stream(stream="", after="0"):
        attachment = runtime.api("POST", f"/api/v1/sessions/{session}/attachments", {})
        binding = attachment["attachment_id"]
        channel = connect(url, origin=runtime.ready["url"],
                          additional_headers={"Cookie": "amazme=" + runtime.web_token}, max_size=34 * 1024 * 1024)
        channel.send(json.dumps({"kind": "hello", "binding_id": binding, "stream_id": stream,
                                 "after": after, "build_id": runtime.build.build_id}))
        return channel, binding, json.loads(channel.recv(timeout=30))

    channel, binding, first = open_stream()
    try:
        evidence.check("stream starts from a complete snapshot", first["snapshot"]["session_id"] == session)
        initial = first["snapshot"]["seq"]
        # Deliberately withhold ACK while using the ordinary HTTP acceptance path.
        request = secrets.token_hex(8)
        runtime.submit(session, request, "ACK isolation proof")
        receipt = runtime.terminal(session, request)
        evidence.check("unacknowledged subscriber cannot block persisted business work", receipt["status"] == "succeeded")
        try:
            channel.recv(timeout=20)
            raise AssertionError("Server sent another frame without ACK")
        except ConnectionClosed as closed:
            evidence.check("stalled subscriber is bounded and disconnected", closed.rcvd is not None and closed.rcvd.code == 1013)
    finally:
        channel.close()
        runtime.api("DELETE", f"/api/v1/sessions/{session}/attachments/{binding}",
                    headers={**runtime.headers(), "X-AmazMe-Attachment": binding})
    channel, binding, resumed = open_stream(first["stream_id"], initial)
    try:
        evidence.check("lost ACK reconnect replays complete transactions", bool(resumed["batches"]) and
                       resumed["batches"][0]["base_revision"] == initial)
        last = resumed["batches"][-1]["seq"]
        channel.send(json.dumps({"kind": "ack", "binding_id": binding, "stream_id": resumed["stream_id"],
                                 "seq": str(int(last) + 1)}))
        try:
            channel.recv(timeout=5)
            raise AssertionError("Invalid ACK accepted")
        except ConnectionClosed as closed:
            evidence.check("a gap ACK is rejected", closed.rcvd is not None and closed.rcvd.code == 1008)
    finally:
        channel.close()
        runtime.api("DELETE", f"/api/v1/sessions/{session}/attachments/{binding}",
                    headers={**runtime.headers(), "X-AmazMe-Attachment": binding})
    channel, binding, reset = open_stream("not-this-stream", "0")
    try:
        evidence.check("foreign/expired stream cursor receives a new authoritative snapshot",
                       reset["resync"] == "cursor_unavailable" and reset["snapshot"]["stream_id"] == first["stream_id"])
        channel.send(json.dumps({"kind":"ack", "binding_id":binding, "stream_id":reset["stream_id"],
                                 "seq":reset["snapshot"]["seq"]}))
    finally:
        channel.close()
        runtime.api("DELETE", f"/api/v1/sessions/{session}/attachments/{binding}",
                    headers={**runtime.headers(), "X-AmazMe-Attachment": binding})


def restart_budget_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    for index in range(4):
        workers = [a for a in runtime.registry() if a.role == "worker" and a.session == session and not runtime.exited(a)]
        evidence.check("one registered worker before fault", len(workers) == 1)
        runtime.signal_actor(workers[0], signal.SIGKILL)
        runtime.poll(lambda: runtime.exited(workers[0]), bool, "killed worker kernel exit")
        if index < 3:
            runtime.poll(lambda: runtime.snapshot(session), lambda s: s["state"] == "ready", "budgeted replacement")
    def blocked():
        response = runtime.raw("GET", f"/api/v1/sessions/{session}/snapshot")
        return response.status_code, response.json()
    failure = wait_for(blocked, lambda r: r[0] == 503 and r[1].get("code") == "worker_restart_budget_exhausted",
                       timeout=runtime.timeout, label="durable worker budget")
    evidence.observe("exhausted_budget", failure)
    runtime.kill_host()
    runtime.start(expected_states=("blocked",))
    evidence.check("Host restart does not reset worker retry budget", runtime.health()["state"] == "blocked")
    runtime.recover(session)
    runtime.poll(lambda: runtime.snapshot(session), lambda s: s["state"] == "ready", "explicit recovery")
    request = secrets.token_hex(8)
    runtime.submit(session, request, "recovered")
    evidence.check("explicit recovery restores work", runtime.terminal(session, request)["status"] == "succeeded")


def cleanup_unavailable_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    request = secrets.token_hex(8)
    runtime.submit(session, request, "/shell " + ticker_command(request))
    runtime.poll(lambda: contents(runtime, request + ".ticks"), bool, "detached writer started")
    locator = runtime.vm_owner()
    home = Path(locator["home"])
    socket = home / "execution/sock/docker.sock"
    hidden_socket = socket.with_name("docker.test-held.sock")
    barrier = home / "operation.lock"
    hidden_barrier = barrier.with_name("operation.test-held.lock")
    fd = os.open(barrier, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        evidence.check("normal VM startup released its mutation barrier", True)
    finally:
        os.close(fd)
    socket.rename(hidden_socket)
    barrier.rename(hidden_barrier)
    replacement = os.open(barrier, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(replacement)
    try:
        time.sleep(6)  # Existing pooled HTTP connections expire before the injected socket outage.
        runtime.api("POST", f"/api/v1/sessions/{session}/requests/{request}/cancel", {}, session=session)
        health = runtime.poll(runtime.health, lambda h: h["state"] == "blocked", "failed cleanup barrier")
        evidence.observe("blocked_cleanup_health", health)
        rows = runtime.sql(runtime.profile / "sessions" / session / "session.sqlite",
                           "SELECT payload FROM requests WHERE id=?", (request,))
        receipt = json.loads(rows[0]["payload"])
        evidence.check("cleanup failure never reports cancelled", receipt["status"] not in TERMINAL, receipt)
        unsafe = secrets.token_hex(8)
        response = runtime.raw("POST", f"/api/v1/sessions/{session}/submissions",
                               {"request_id":unsafe,"text":"/shell " + marker_command(unsafe)},session=session)
        evidence.check("failed cleanup rejects new execution", response.status_code == 503 and not contents(runtime,unsafe),response.text)
    finally:
        barrier.unlink()
        hidden_barrier.rename(barrier)
        hidden_socket.rename(socket)
    runtime.recover(session)
    runtime.terminal(session, request)
    check_clean(runtime, evidence, session)
    ticks = contents(runtime, request + ".ticks")
    time.sleep(0.4)
    evidence.check("old detached descendants stop after restored cleanup proof", contents(runtime, request + ".ticks") == ticks)
    reconcile(runtime, evidence, session, request, request, required=False)


def commit_crash_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    request = secrets.token_hex(8)
    store = runtime.profile / "sessions" / session / "session.sqlite"
    fault = runtime.arm("worker", "before_commit", session_id=session, request_id=request)
    pending = runtime.send(session, request, "/shell " + marker_command(request))
    actor = runtime.actor(fault.reached())
    evidence.check("uncommitted receipt is invisible to another SQLite reader",
                   not runtime.sql(store, "SELECT id FROM requests WHERE id=?", (request,)))
    evidence.check("uncommitted acceptance produced no effect", not contents(runtime, request))
    runtime.signal_actor(actor, signal.SIGKILL)
    pending.finish(runtime, lost_reply=True)
    receipt = runtime.terminal(session, request)
    evidence.check("durable Host intent retries rolled-back acceptance exactly once",
                   receipt["status"] == "succeeded" and contents(runtime, request) == b"once\n", receipt)
    acceptance_once(runtime, evidence, session, request)
    check_clean(runtime, evidence, session)
    runtime.recover(session)


def checkpoint_case(runtime: Runtime, evidence: Evidence, role: str, point: str) -> None:
    session = runtime.session(evidence.name)
    request, marker = secrets.token_hex(8), secrets.token_hex(8) + ".effect"
    follow_marker = secrets.token_hex(8) + ".second" if (role, point) in {
        ("worker", "tool_result"), ("supervisor", "result")} else ""
    text = ("/sequence " + json.dumps([marker_command(marker), marker_command(follow_marker)])
            if follow_marker else "/shell " + marker_command(marker))
    # Also rendezvous with the exact worker when killing worker+Supervisor together.
    worker_fault = runtime.arm("worker", point if role == "worker" else "tool_intent",
                               session_id=session, request_id=request)
    supervisor_fault = None
    if role == "supervisor":
        match = {"session_id": session}
        if point != "closed":
            match["request_id"] = request
        supervisor_fault = runtime.arm("supervisor", point, **match)
    pending = runtime.send(session, request, text)
    worker_marker = worker_fault.reached()
    worker = runtime.actor(worker_marker)
    captured_steps = runtime.steps(session, request)
    supervisor = None
    if supervisor_fault:
        worker_fault.release()
        supervisor_marker = supervisor_fault.reached()
        supervisor = runtime.actor(supervisor_marker)
        # Prevent cleanup from moving the paused boundary between the two kills.
        runtime.signal_actor(supervisor, signal.SIGSTOP)
        captured_steps = runtime.steps(session, request)
    evidence.observe("steps_at_boundary", captured_steps)
    paused_receipt = json.loads(runtime.sql(runtime.profile / "sessions" / session / "session.sqlite",
                                            "SELECT payload FROM requests WHERE id=?", (request,))[0]["payload"])
    evidence.observe("receipt_at_boundary", paused_receipt)
    before = contents(runtime, marker)
    if (role == "worker" and point in {"model_intent", "model_result", "tool_intent"}) or (
        role == "supervisor" and point in {"create_intent", "created", "registered", "started", "before_permit"}
    ):
        evidence.check("no user effect before permit", before == b"", before.decode())
    if role == "worker" and point in {"tool_result", "decision", "cleanup"} or (
        role == "supervisor" and point in {"result", "closed"}
    ):
        evidence.check("committed tool result has exactly one effect", before == b"once\n", before.decode())
    runtime.signal_actor(worker, signal.SIGKILL)
    if supervisor:
        runtime.signal_actor(supervisor, signal.SIGKILL)
    pending.finish(runtime, lost_reply=True)
    receipt = runtime.terminal(session, request)
    expected = "unknown" if (role == "worker" and point in {"model_intent", "tool_intent"}) or (
        role == "supervisor" and point not in {"result", "closed"}) else "succeeded"
    evidence.check("checkpoint recovery has the required terminal outcome", receipt["status"] == expected, receipt)
    data = contents(runtime, marker)
    evidence.check("original effect occurs at most once", data in {b"", b"once\n"}, data.decode())
    if expected == "succeeded":
        evidence.check("known checkpoint resumes to exactly one effect", data == b"once\n")
    if follow_marker:
        evidence.check("next tool in the sequence runs exactly once", contents(runtime, follow_marker) == b"once\n")
    if role == "worker" and point in {"model_intent", "tool_intent"}:
        evidence.check("uninvoked intent is never replayed", data == b"")
    after_steps = runtime.steps(session, request)
    if role == "worker" and point == "decision":
        evidence.check("business decision is preserved through cleanup-only recovery",
                       bool(paused_receipt["decision"]) and receipt["decision"] == paused_receipt["decision"], receipt)
        evidence.check("decision recovery does not invoke another model", [s["step_id"] for s in after_steps if
                       s["kind"] == "model"] == [s["step_id"] for s in captured_steps if s["kind"] == "model"])
    if role == "worker" and point == "model_intent":
        models = [s for s in after_steps if s["kind"] == "model"]
        evidence.check("unknown model call is not replaced with another invocation", len(models) == 1 and
                       models[0]["step_id"] == worker_marker["context"]["call_id"] and
                       models[0]["phase"] == "unknown", models)
    for saved in captured_steps:
        if saved["phase"] in {"result", "applied"} and saved.get("result"):
            current = next((s for s in after_steps if s["step_id"] == saved["step_id"]), None)
            evidence.check("persisted result checkpoint reused " + saved["step_id"],
                           current is not None and current["result"] == saved["result"], current)
    check_clean(runtime, evidence, session)
    reconcile(runtime, evidence, session, request, marker, required=role == "supervisor" and expected == "unknown")
    duplicate = runtime.submit(session, request, text)
    evidence.check("duplicate submission retains stable acceptance", duplicate["request_id"] == request and
                   duplicate["accepted_revision"] == receipt["accepted_revision"], duplicate)
    acceptance_once(runtime, evidence, session, request)
    evidence.check("retry does not repeat the effect", contents(runtime, marker) == data)
    if follow_marker:
        evidence.check("retry does not repeat the next tool", contents(runtime, follow_marker) == b"once\n")
    evidence.check("old worker kernel lease released", runtime.exited(worker))
    if supervisor:
        evidence.check("old Supervisor kernel lease released", runtime.exited(supervisor))
    runtime.recover(session)


def delivery_case(runtime: Runtime, evidence: Evidence, *, pause: bool = False) -> None:
    session = runtime.session(evidence.name)
    request = secrets.token_hex(8)
    text = "/shell " + marker_command(request)
    fault = runtime.arm("host", "delivery", session_id=session, request_id=request)
    pending = runtime.send(session, request, text)
    reached = fault.reached()
    if pause:
        require(runtime.process is not None, "Missing owned Host")
        evidence.check("pause target matches owned Popen", (reached["pid"], reached["instance"]) ==
                       (runtime.process.pid, runtime.ready["instance_id"]))
        runtime.process.send_signal(signal.SIGSTOP)
        runtime.host_paused = True
        time.sleep(0.4)
        runtime.process.send_signal(signal.SIGCONT)
        runtime.host_paused = False
        fault.release()
        evidence.observe("simulation", "SIGSTOP/SIGCONT of owned Host only; not hardware sleep")
    else:
        runtime.kill_host(reached)
        # Finish the old in-flight HTTP request and close its captured client before reconnecting.
        pending.finish(runtime, lost_reply=True)
        runtime.start()
    if pause:
        pending.finish(runtime)
    receipt = runtime.terminal(session, request)
    duplicate = runtime.submit(session, request, text)
    evidence.check("delivery lost ACK keeps original acceptance", receipt["status"] == "succeeded" and
                   receipt["accepted_revision"] == duplicate["accepted_revision"], receipt)
    evidence.check("delivery retry has exactly one external effect", contents(runtime, request) == b"once\n")
    acceptance_once(runtime, evidence, session, request)
    check_clean(runtime, evidence, session)
    runtime.poll(runtime.health, lambda h: h["pending_deliveries"] == 0, "delivery ACK adopted")


def takeover_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    old = worker_info(runtime, session)
    old_fence, old_headers = runtime.fence(), runtime.headers(session=session)
    runtime.kill_host()
    runtime.start()
    new = worker_info(runtime, session)
    evidence.check("same surviving worker receives higher Host fence", old["worker_id"] == new["worker_id"] and
                   new["host_epoch"] == runtime.ready["host_epoch"] > old_fence["host_epoch"], new)
    body = {**old_fence, "session_id": session, "worker_id": old["worker_id"],
            "execution_epoch": old["execution_epoch"], "reason": "shutdown"}
    response = runtime.private(runtime.ipc() / "supervisor.sock", "POST", "/workers/stop", body)
    evidence.check("late old-Host stop rejected by Supervisor", response.status_code == 409 and
                   response.json().get("code") == "stale_host_epoch", response.text)
    response = runtime.private(Path(old["socket"]), "POST", "/stop", body)
    evidence.check("late old-Host stop rejected by worker", response.status_code == 409 and
                   response.json().get("code") == "stale_host_epoch", response.text)
    response = runtime.raw("POST", f"/api/v1/sessions/{session}/submissions",
                           {"request_id": "stale", "text": "must not be accepted"}, headers=old_headers)
    evidence.check("old client binding rejected after takeover", response.status_code == 409 and
                   response.json().get("code") == "stale_client_binding", response.text)
    name = secrets.token_hex(8)
    runtime.submit(session, name, "/shell " + marker_command(name))
    receipt = runtime.terminal(session, name)
    evidence.check("fresh attachment can still write", receipt["status"] == "succeeded" and
                   contents(runtime, name) == b"once\n", receipt)
    evidence.check("stale stop did not replace worker", worker_info(runtime, session)["worker_id"] == old["worker_id"])


def scheduled_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    request = secrets.token_hex(8)
    deadline_ms = int(time.time() * 1000) + 30000
    fault = runtime.arm("worker", "accepted", session_id=session, request_id=request)
    pending = runtime.send(session, request, "/shell " + marker_command(request), not_before_ms=deadline_ms)
    actor = runtime.actor(fault.reached())
    evidence.check("scheduled acceptance does not execute early", not contents(runtime, request))
    runtime.signal_actor(actor, signal.SIGKILL)
    pending.finish(runtime, lost_reply=True)
    samples = []
    while int(time.time() * 1000) < deadline_ms:
        data = contents(runtime, request)
        timestamp = int(time.time() * 1000)
        if timestamp >= deadline_ms:
            break
        samples.append({"unix_ms": timestamp, "bytes": len(data)})
        require(not data, f"Scheduled request executed before deadline {deadline_ms}: {timestamp}")
        time.sleep(0.25)
    evidence.check("scheduled effect absent throughout observed pre-deadline interval", bool(samples), samples)
    receipt = runtime.terminal(session, request)
    evidence.check("scheduled intent survives worker replacement", receipt["not_before_ms"] == deadline_ms and
                   receipt["status"] == "succeeded" and contents(runtime, request) == b"once\n", receipt)
    acceptance_once(runtime, evidence, session, request)
    check_clean(runtime, evidence, session)
    runtime.recover(session)


def children_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    request, first, second = (secrets.token_hex(8) for _ in range(3))
    fault = runtime.arm("worker", "child_join", session_id=session, request_id=request)
    pending = runtime.send(session, request, "/delegate " + json.dumps([
        "/shell " + marker_command(first), "/shell " + marker_command(second)]))
    actor = runtime.actor(fault.reached())
    snapshot = runtime.snapshot(session)
    children = [r for r in snapshot["requests"] if r["parent_id"] == request and r["kind"] == "child"]
    parent = next(r for r in snapshot["requests"] if r["request_id"] == request)
    evidence.check("parent has not reported early success at join", parent["status"] != "succeeded", parent)
    evidence.check("both required children completed before join", len(children) == 2 and
                   all(r["status"] == "succeeded" for r in children), children)
    runtime.signal_actor(actor, signal.SIGKILL)
    pending.finish(runtime, lost_reply=True)
    receipt = runtime.terminal(session, request)
    evidence.check("parent joins the same persisted children after crash", receipt["status"] == "succeeded" and
                   set(receipt["children"]) == {r["request_id"] for r in children}, receipt)
    evidence.check("child effects are not replayed", contents(runtime, first) == contents(runtime, second) == b"once\n")
    for r in children:
        acceptance_once(runtime, evidence, session, r["request_id"])
    check_clean(runtime, evidence, session)
    runtime.recover(session)


def cleanup_before_terminal(runtime: Runtime, evidence: Evidence, session: str, request: str) -> None:
    rows = runtime.sql(runtime.profile / "sessions" / session / "session.sqlite",
                       "SELECT payload FROM batches ORDER BY seq")
    cleanup_seq: int | None = None
    terminal_seq: int | None = None
    for row in rows:
        batch = json.loads(row["payload"])
        seq = int(batch["seq"])
        for event in batch["events"]:
            if event.get("request_id") != request:
                continue
            if event.get("kind") == "cleanup" and "proof_id" in str(event.get("text", "")):
                proof = json.loads(event["text"])
                if (proof.get("state") == "clean" and proof.get("proof_id")
                        and proof.get("session_id") == session):
                    cleanup_seq = seq
            receipt = event.get("receipt") or {}
            if receipt.get("request_id") == request and receipt.get("status") in TERMINAL:
                terminal_seq = seq
    evidence.check("cleanup proof is durable before the terminal status",
                   cleanup_seq is not None and terminal_seq is not None and cleanup_seq < terminal_seq,
                   {"request_id": request, "cleanup_seq": cleanup_seq, "terminal_seq": terminal_seq})


def children_cancel_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    parent, queued = secrets.token_hex(8), secrets.token_hex(8)
    runtime.submit(session, parent, "/delegate " + json.dumps(["/shell " + ticker_command(parent)]))
    runtime.poll(lambda: contents(runtime, parent + ".ticks"), lambda data: len(data) > 2,
                 "child setsid descendant is writing")
    snapshot = runtime.snapshot(session)
    children = [r for r in snapshot["requests"] if r["parent_id"] == parent and r["kind"] == "child"]
    parent_row = next(r for r in snapshot["requests"] if r["request_id"] == parent)
    evidence.check("parent has not settled before cancellation", parent_row["status"] not in TERMINAL, parent_row)
    evidence.check("required child is still running", len(children) == 1 and children[0]["status"] not in TERMINAL,
                   children)
    child = children[0]["request_id"]
    runtime.submit(session, queued, "unrelated queued input must survive child cancellation")
    acknowledged = runtime.api("POST", f"/api/v1/sessions/{session}/requests/{parent}/cancel", {}, session=session)
    evidence.check("cancel acknowledgement is not a cleanup completion",
                   acknowledged["status"] not in TERMINAL and acknowledged["cancel_requested"] is True, acknowledged)
    receipt = runtime.terminal(session, parent)
    child_receipt = runtime.receipt(session, child)
    evidence.check("cancelled parent and child are terminal and not successful",
                   receipt["status"] in {"cancelled", "unknown"} and child_receipt["status"] in {"cancelled", "unknown"}
                   and child in receipt["children"], {"parent": receipt, "child": child_receipt})
    cleanup_before_terminal(runtime, evidence, session, child)
    check_clean(runtime, evidence, session)
    stopped = contents(runtime, parent + ".ticks")
    time.sleep(0.4)
    evidence.check("cancelled child descendants stop after cleanup",
                   bool(stopped) and contents(runtime, parent + ".ticks") == stopped)
    evidence.check("child shell effect happened once before cancellation", contents(runtime, parent) == b"once\n")
    reconcile(runtime, evidence, session, child, parent, required=True)
    queued_receipt = runtime.terminal(session, queued)
    evidence.check("unrelated queued input survives child cancellation", queued_receipt["status"] == "succeeded",
                   queued_receipt)
    runtime.recover(session)


def ticker_command(name: str) -> str:
    script = f"""import os,pathlib,time
root=pathlib.Path('/workspace')
end=time.monotonic()+90
if os.fork()==0:
 os.setsid()
 if os.fork()!=0: os._exit(0)
 with (root/{name!r}).open('ab',buffering=0) as f:
  f.write(b'once\\n');os.fsync(f.fileno())
 while time.monotonic()<end:
  with (root/{(name + '.ticks')!r}).open('ab',buffering=0) as f:
   f.write(b'.');os.fsync(f.fileno())
  time.sleep(.1)
 os._exit(0)
while not (root/{(name + '.release')!r}).exists():
 if time.monotonic()>end: raise RuntimeError('runner did not release ticker')
 time.sleep(.1)
print('released')
"""
    return "python -I -c " + shlex.quote(script)


def sibling_case(runtime: Runtime, evidence: Evidence) -> None:
    left, right = runtime.session("sibling target"), runtime.session("sibling survivor")
    a, b, queued = (secrets.token_hex(8) for _ in range(3))
    runtime.submit(left, a, "/shell " + ticker_command(a))
    runtime.submit(right, b, "/shell " + ticker_command(b))
    runtime.poll(lambda: (contents(runtime, a + ".ticks"), contents(runtime, b + ".ticks")),
                 lambda pair: all(len(v) > 2 for v in pair), "both session writers are live")
    sibling = worker_info(runtime, right)
    fault = runtime.arm("worker", "accepted", session_id=left, request_id=queued)
    pending = runtime.send(left, queued, "unrelated queued input must survive")
    actor = runtime.actor(fault.reached())
    runtime.signal_actor(actor, signal.SIGKILL)
    pending.finish(runtime, lost_reply=True)
    receipt = runtime.terminal(left, a)
    evidence.check("killed writer has unknown outcome", receipt["status"] == "unknown", receipt)
    check_clean(runtime, evidence, left)
    stopped, moving = contents(runtime, a + ".ticks"), contents(runtime, b + ".ticks")
    time.sleep(0.6)
    evidence.check("target writer stops while sibling keeps progressing", contents(runtime, a + ".ticks") == stopped and
                   len(contents(runtime, b + ".ticks")) > len(moving))
    evidence.check("sibling process was not replaced", worker_info(runtime, right)["worker_id"] == sibling["worker_id"])
    (runtime.workspace / (b + ".release")).touch(mode=0o600)
    evidence.check("already-running sibling finishes", runtime.terminal(right, b)["status"] == "succeeded")
    evidence.check("unrelated queued input retained", runtime.terminal(left, queued)["status"] == "succeeded")
    reconcile(runtime, evidence, left, a, a, required=True)
    runtime.recover(left)


def approval_auto_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    name = secrets.token_hex(8)
    runtime.submit(session, name, "/shell " + marker_command(name))
    receipt = runtime.terminal(session, name)
    evidence.check("explicit auto policy executes deterministic faux work", receipt["status"] == "succeeded" and
                   contents(runtime, name) == b"once\n", receipt)
    response = runtime.raw("POST", f"/api/v1/sessions/{session}/approvals", {
        "decision_id": secrets.token_hex(8), "approval_id": secrets.token_hex(16),
        "expected_revision": receipt["revision"], "proposal_digest": "0" * 64, "approve": True}, session=session)
    evidence.check("an invented late approval cannot authorize a tool", response.status_code == 404 and
                   response.json().get("code") == "approval_not_found", response.text)
    evidence.check("late decision added no effect", contents(runtime, name) == b"once\n")
    evidence.observe("coverage_limit", "No pending approval was produced: profile policy is auto")


def approval_wait_case(runtime: Runtime, evidence: Evidence) -> None:
    evidence.check("approval wait uses its own real mutations profile",
                   read_json(runtime.profile / "config.json")["approval_policy"] == "mutations",
                   str(runtime.profile))
    session = runtime.session(evidence.name)
    request = secrets.token_hex(8)
    fault = runtime.arm("worker", "approval", session_id=session, request_id=request)
    pending = runtime.send(session, request, "/shell " + marker_command(request))
    actor = runtime.actor(fault.reached())
    snapshot = runtime.snapshot(session)
    approvals = [a for a in snapshot["approvals"] if a["request_id"] == request and a["state"] == "pending"]
    evidence.check("actual durable pending approval exists", len(approvals) == 1, approvals)
    proposal = approvals[0]
    evidence.check("tool has no effect before approval", not contents(runtime, request))
    runtime.signal_actor(actor, signal.SIGKILL)
    pending.finish(runtime, lost_reply=True)
    runtime.kill_host()
    runtime.start()
    restored = runtime.poll(lambda: runtime.snapshot(session), lambda s: any(
        a["approval_id"] == proposal["approval_id"] and a["state"] == "pending" for a in s["approvals"]),
        "approval wait restored")
    current = next(a for a in restored["approvals"] if a["approval_id"] == proposal["approval_id"])
    evidence.check("worker and Host crash preserve exact proposal and approval revision", current == proposal, current)
    evidence.check("recovery cannot authorize the pending write", not contents(runtime, request))
    value = {"decision_id": secrets.token_hex(8), "approval_id": current["approval_id"],
             "expected_revision": current["revision"], "proposal_digest": current["proposal_digest"], "approve": True}
    invalid = {**value, "decision_id": secrets.token_hex(8), "proposal_digest": "0" * 64}
    response = runtime.raw("POST", f"/api/v1/sessions/{session}/approvals", invalid, session=session)
    evidence.check("altered proposal digest cannot authorize a write", response.status_code == 409 and
                   response.json().get("code") == "stale_approval", response.text)
    evidence.check("invalid approval produced no effect", not contents(runtime, request))
    runtime.api("POST", f"/api/v1/sessions/{session}/approvals", value, session=session)
    receipt = runtime.terminal(session, request)
    evidence.check("exact approved proposal executes once", receipt["status"] == "succeeded" and
                   contents(runtime, request) == b"once\n", receipt)
    repeated = runtime.api("POST", f"/api/v1/sessions/{session}/approvals", value, session=session)
    evidence.check("same decision ID is idempotent", repeated["request_id"] == request and
                   repeated["status"] == "succeeded" and contents(runtime, request) == b"once\n", repeated)
    response = runtime.raw("POST", f"/api/v1/sessions/{session}/approvals",
                           {**value, "decision_id": secrets.token_hex(8)}, session=session)
    evidence.check("new late decision for consumed proposal is rejected", response.status_code == 409 and
                   response.json().get("code") == "stale_approval", response.text)
    acceptance_once(runtime, evidence, session, request)
    check_clean(runtime, evidence, session)
    runtime.recover(session)


def live_supervisor(runtime: Runtime) -> Actor:
    matches = [actor for actor in runtime.registry() if actor.role == "supervisor" and not runtime.exited(actor)]
    require(len(matches) == 1, f"Expected one live owned supervisor, found {len(matches)}")
    return matches[0]


def execution_transaction(runtime: Runtime, change: Callable[[sqlite3.Connection], None], *, pause: bool) -> None:
    database = runtime.profile / "execution.sqlite"
    require(database.resolve().is_relative_to(runtime.profile), "Execution database escaped the owned profile")

    def once(actor: Actor | None) -> None:
        if actor is not None:
            runtime.signal_actor(actor, signal.SIGSTOP)
        try:
            with contextlib.closing(sqlite3.connect(database, timeout=1, isolation_level=None)) as db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA busy_timeout=300")
                db.execute("BEGIN IMMEDIATE")
                try:
                    change(db)
                    db.execute("COMMIT")
                except BaseException:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                    raise
        finally:
            if actor is not None:
                runtime.signal_actor(actor, signal.SIGCONT)

    if not pause:
        once(None)
        return
    last_lock = ""
    for _ in range(8):
        try:
            once(live_supervisor(runtime))
            return
        except sqlite3.OperationalError as error:
            last_lock = str(error)
            if "locked" not in last_lock.lower():
                raise
            time.sleep(0.05)
    raise AssertionError(f"Execution database stayed locked across supervisor pauses: {last_lock}")


def resume_rejection(runtime: Runtime, evidence: Evidence, update_id: str, code: str, worker_id: str) -> None:
    response = runtime.raw("POST", f"/control/updates/{update_id}/resume", {}, control=True)
    body = response.json()
    evidence.check("update resume rejects " + code, response.status_code == 503 and body.get("code") == code,
                   {"status": response.status_code, "body": body})
    record = runtime.api("GET", f"/control/updates/{update_id}", control=True)
    evidence.check("rejected update keeps the participant and stays inactive",
                   any(worker["worker_id"] == worker_id for worker in record["roster"])
                   and not record["activated"] and record["phase"] != "completed", record)


def exercise_update_roster_rejections(runtime: Runtime, evidence: Evidence, update_id: str,
                                      source: Build, target: Build) -> None:
    """Inject durable roster/probe defects, prove the running target rejects them, then restore."""
    record = runtime.api("GET", f"/control/updates/{update_id}", control=True)
    stopped = [worker for worker in record["roster"] if worker["state"] == "stopped" and worker["process_lease"]]
    require(bool(stopped), "Prepared update has no stopped participant to hide")
    participant = stopped[0]
    worker_id = str(participant["worker_id"])
    original_build = str(participant["build_id"])
    replacement_build = target.build_id if original_build == source.build_id else source.build_id
    require(replacement_build != original_build, "Roster injection needs two distinct builds")
    saved: dict[str, object] = {}

    def hide(db: sqlite3.Connection) -> None:
        row = db.execute("SELECT worker,session,info,retirement,failure_counted FROM workers WHERE worker=?",
                         (worker_id,)).fetchone()
        require(row is not None, "Roster participant is already absent from the execution store")
        info = json.loads(row["info"])
        require(info["build_id"] == original_build and info["state"] == "stopped", info)
        saved["row"] = (row["worker"], row["session"], row["info"], row["retirement"], row["failure_counted"])
        db.execute("DELETE FROM workers WHERE worker=?", (worker_id,))

    execution_transaction(runtime, hide, pause=True)
    try:
        resume_rejection(runtime, evidence, update_id, "participant_missing", worker_id)
    finally:
        def restore_hidden(db: sqlite3.Connection) -> None:
            row = saved.get("row")
            require(isinstance(row, tuple), "Hidden participant row was not captured")
            db.execute("INSERT INTO workers(worker,session,info,retirement,failure_counted) VALUES(?,?,?,?,?)", row)
        execution_transaction(runtime, restore_hidden, pause=True)

    def rewrite_build(db: sqlite3.Connection) -> None:
        row = db.execute("SELECT info FROM workers WHERE worker=?", (worker_id,)).fetchone()
        require(row is not None, "Restored participant disappeared")
        saved["info"] = str(row["info"])
        info = json.loads(row["info"])
        require(info["build_id"] == original_build and info["state"] == "stopped", info)
        info["build_id"] = replacement_build
        db.execute("UPDATE workers SET info=? WHERE worker=?", (json.dumps(info), worker_id))

    execution_transaction(runtime, rewrite_build, pause=True)
    try:
        resume_rejection(runtime, evidence, update_id, "participant_identity_mismatch", worker_id)
        current = runtime.api("GET", f"/control/updates/{update_id}", control=True)
        kept = next(worker for worker in current["roster"] if worker["worker_id"] == worker_id)
        evidence.check("historical participant build is not rewritten to the target",
                       kept["build_id"] == original_build, kept)
    finally:
        def restore_build(db: sqlite3.Connection) -> None:
            info = saved.get("info")
            require(isinstance(info, str), "Original participant payload was not captured")
            db.execute("UPDATE workers SET info=? WHERE worker=?", (info, worker_id))
        execution_transaction(runtime, restore_build, pause=True)

    fault = runtime.arm("supervisor", "closed")
    pending = runtime.pending("POST", f"/control/updates/{update_id}/resume", {}, control=True)
    reached = fault.reached()
    probe_session = str(reached["context"]["session_id"])
    original_receipt = ""
    probe_epoch = -1

    def corrupt_probe(db: sqlite3.Connection) -> None:
        nonlocal original_receipt, probe_epoch
        row = db.execute("SELECT epoch,receipt FROM epochs WHERE session=? ORDER BY epoch DESC LIMIT 1",
                         (probe_session,)).fetchone()
        require(row is not None and row["receipt"], "Validation probe epoch has no cleanup receipt")
        original_receipt = str(row["receipt"])
        probe_epoch = int(row["epoch"])
        receipt = json.loads(original_receipt)
        require(receipt["state"] == "clean" and receipt["containers"] == [] and receipt["proof_id"]
                and receipt["session_id"] == probe_session and receipt["execution_epoch"] == probe_epoch, receipt)
        receipt["containers"] = ["injected-uncleaned-container"]
        db.execute("UPDATE epochs SET receipt=? WHERE session=? AND epoch=?",
                   (json.dumps(receipt), probe_session, probe_epoch))

    try:
        execution_transaction(runtime, corrupt_probe, pause=False)
        fault.release()
        try:
            pending.finish(runtime)
            raise AssertionError("Validation probe with a nonempty container receipt was accepted")
        except HTTPFailure as error:
            evidence.check("wrong validation cleanup receipt is rejected",
                           error.status == 503 and error.code == "validation_probe_unproven", error.body)
        record = runtime.api("GET", f"/control/updates/{update_id}", control=True)
        evidence.check("bad validation receipt does not activate the update",
                       not record["activated"] and record["phase"] != "completed", record)
    finally:
        fault.release()

        def restore_probe(db: sqlite3.Connection) -> None:
            require(original_receipt and probe_epoch >= 0, "Probe receipt was not captured")
            db.execute("UPDATE epochs SET receipt=? WHERE session=? AND epoch=?",
                       (original_receipt, probe_session, probe_epoch))

        if original_receipt:
            execution_transaction(runtime, restore_probe, pause=True)


def update_case(runtime: Runtime, evidence: Evidence, builds: tuple[Build, Build], point: str) -> None:
    source = runtime.build
    target = next(b for b in builds if b.build_id != source.build_id)
    session = runtime.session(evidence.name)
    update_id = secrets.token_hex(16)
    prepare = {"update_id": update_id, "target_build": target.build_id, "cancel_work": False}
    unauthorized = runtime.raw("POST", "/control/updates/prepare", prepare)
    evidence.check("web bearer cannot prepare an update", unauthorized.status_code in {401, 403}, unauthorized.text)
    if point in {"update_freeze", "update_prepared"}:
        fault = runtime.arm("host", point, update_id=update_id)
        pending = runtime.pending("POST", "/control/updates/prepare", prepare, control=True)
        reached = fault.reached()
        at_fault = runtime.health()
        evidence.check("source is frozen at the update boundary", at_fault["state"] == "frozen" and
                       at_fault["update"]["update_id"] == update_id and not at_fault["update"]["activated"], at_fault)
        runtime.kill_host(reached)
        pending.finish(runtime, lost_reply=True)
        runtime.start(expected_states=("frozen", "blocked"))
        restarted = runtime.health()
        evidence.check("source restart retains its unactivated update", restarted["state"] == "frozen" and
                       restarted["update"]["update_id"] == update_id and not restarted["update"]["activated"], restarted)
        prepared = runtime.api("POST", f"/control/updates/{update_id}/resume", {}, control=True)
    else:
        prepared = runtime.api("POST", "/control/updates/prepare", prepare, control=True)
    evidence.check("source preparation accounts for stopped participants", prepared["phase"] == "prepared" and
                   bool(prepared["roster"]) and all(w["state"] == "stopped" for w in prepared["roster"]), prepared)
    runtime.registry()
    source_actors = [a for a in runtime.actors.values() if a.build_id == source.build_id]
    evidence.check("all source process leases exited before target launch",
                   bool(source_actors) and all(runtime.exited(a) for a in source_actors),
                   [a.__dict__ for a in source_actors])
    runtime.kill_host()
    runtime.start(target, expected_states=("frozen", "blocked"))
    health = runtime.health()
    evidence.check("target readiness is frozen with exact target update", health["state"] == "frozen" and
                   health["update"]["update_id"] == update_id and health["update"]["target_build"] == target.build_id and
                   not health["update"]["activated"], health)
    marker = secrets.token_hex(8)
    response = runtime.raw("POST", f"/api/v1/sessions/{session}/submissions",
                           {"request_id": marker, "text": "/shell " + marker_command(marker)}, session=session)
    evidence.check("frozen target rejects business delivery", response.status_code == 503 and
                   response.json().get("code") == "update_frozen", response.text)
    evidence.check("frozen target produced no business effect", not contents(runtime, marker))
    if point == "update_roster":
        exercise_update_roster_rejections(runtime, evidence, update_id, source, target)
    # That rejected HTTP delivery may still be durably queued in Host's outbox.
    # Keep its ID and prove its single effect only after explicit completion.
    record = runtime.api("GET", f"/control/updates/{update_id}", control=True)
    unauthorized = runtime.raw("POST", "/control/updates/complete",
                               {"update_id": update_id, "expected_revision": record["revision"]})
    evidence.check("web bearer cannot complete an update", unauthorized.status_code in {401, 403}, unauthorized.text)
    if point == "update_health":
        fault = runtime.arm("host", point, update_id=update_id)
        pending = runtime.pending("POST", f"/control/updates/{update_id}/resume", {}, control=True)
        reached = fault.reached()
        runtime.kill_host(reached)
        pending.finish(runtime, lost_reply=True)
        runtime.start(expected_states=("frozen", "blocked"))
        record = runtime.api("GET", f"/control/updates/{update_id}", control=True)
        evidence.check("health checkpoint survives without activating", record["phase"] == "validating" and
                       not record["activated"] and runtime.health()["state"] == "frozen", record)
    record = runtime.api("POST", f"/control/updates/{update_id}/resume", {}, control=True)
    validation = record.get("validation")
    evidence.check("target validation is a real stopped worker with matching fingerprint",
                   bool(validation) and validation["state"] == "stopped" and
                   validation["build_id"] == validation["fingerprint"] == target.build_id and
                   bool(validation["process_lease"]) and validation["storage_ready"], validation)
    stale = runtime.raw("POST", "/control/updates/complete",
                        {"update_id": update_id, "expected_revision": "-1"}, control=True)
    evidence.check("completion rejects a stale revision", stale.status_code == 409 and
                   stale.json().get("code") == "update_revision_conflict", stale.text)
    complete = {"update_id": update_id, "expected_revision": record["revision"]}
    if point == "update_completed":
        fault = runtime.arm("host", point, update_id=update_id)
        pending = runtime.pending("POST", "/control/updates/complete", complete, control=True)
        reached = fault.reached()
        checkpoint = runtime.api("GET", f"/control/updates/{update_id}", control=True)
        evidence.check("complete commit is still unactivated before thaw ACK adoption",
                       checkpoint["phase"] == "completed" and not checkpoint["activated"], checkpoint)
        evidence.check("complete-commit crash boundary still blocks business effects", not contents(runtime, marker))
        runtime.kill_host(reached)
        pending.finish(runtime, lost_reply=True)
        runtime.start(expected_states=("frozen", "blocked"))
        health = runtime.health()
        evidence.check("completed-but-unactivated restart remains frozen", health["state"] == "frozen" and
                       health["update"]["phase"] == "completed" and not health["update"]["activated"], health)
        complete["expected_revision"] = health["update"]["revision"]
    result = runtime.api("POST", "/control/updates/complete", complete, control=True)
    evidence.check("private completion activates after full validation", result["phase"] == "completed" and
                   result["activated"], result)
    repeated = runtime.api("POST", "/control/updates/complete", complete, control=True)
    evidence.check("private complete is idempotent", repeated == result, repeated)
    def activated(health: dict) -> bool:
        supervisor = health.get("supervisor") or {}
        workers = supervisor.get("workers") or []
        return health["state"] == "ready" and bool(workers) and all(
            worker["state"] not in {"starting", "unknown"} for worker in workers)

    ready = runtime.poll(runtime.health, activated, "target activation")
    evidence.check("no mixed-build ready participants", ready["identity"]["build_id"] == target.build_id and
                   ready["supervisor"]["identity"]["build_id"] == target.build_id and all(
                       worker["state"] == "stopped" or worker["build_id"] == worker["fingerprint"] == target.build_id
                       for worker in ready["supervisor"]["workers"]), ready)
    runtime.submit(session, marker, "/shell " + marker_command(marker))
    receipt = runtime.terminal(session, marker)
    evidence.check("frozen delivery executes exactly once after activation", receipt["status"] == "succeeded" and
                   contents(runtime, marker) == b"once\n", receipt)
    acceptance_once(runtime, evidence, session, marker)
    check_clean(runtime, evidence, session)
    runtime.kill_host()
    runtime.start()
    evidence.check("fully activated restart has no pending update", runtime.health()["update"] is None)


def vm_force_stop_case(runtime: Runtime, evidence: Evidence) -> None:
    session = runtime.session(evidence.name)
    request = secrets.token_hex(8)
    before_boot = runtime.health()["supervisor"]["boot_id"]
    fault = runtime.arm("supervisor", "permitted", session_id=session, request_id=request)
    pending = runtime.send(session, request, "/shell " + ticker_command(request))
    supervisor = runtime.actor(fault.reached())
    runtime.poll(lambda: contents(runtime, request), bool, "writer started before virtual power-off")
    runtime.signal_actor(supervisor, signal.SIGSTOP)
    try:
        locator = runtime.vm_owner()
        home = Path(locator["home"])
        manager = runtime.build.executable.parent / "runtime/lima/bin/limactl"
        env = {**runtime.env, "LIMA_HOME": str(home), "PATH": str(manager.parent) + ":" + runtime.env["PATH"]}
        fd = os.open(home / "operation.lock", os.O_RDWR | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            info = os.fstat(fd)
            require(read_json(home / "operation-identity.json") ==
                    {"device": info.st_dev, "inode": info.st_ino, "vm_id": locator["vm_id"]},
                    "VM operation lease identity mismatch")
            stopped = subprocess.run([str(manager), "stop", "--tty=false", "--force", "execution"],
                                     env=env, capture_output=True, text=True, timeout=90, pass_fds=(fd,))
            evidence.check("owned VM force-stop command succeeds", stopped.returncode == 0, stopped.stderr[-1500:])
            queried = subprocess.run([str(manager), "list", "--json"], env=env,
                                     capture_output=True, text=True, timeout=20)
            require(queried.returncode == 0, "Cannot query forced-stop VM")
            machines = [json.loads(line) for line in queried.stdout.splitlines() if line.strip()]
            matches = [m for m in machines if m["name"] == "execution"]
            require(len(matches) == 1, "Owned VM absent or ambiguous after force-stop")
            machine = matches[0]
            evidence.check("VM manager proves exact instance is stopped", machine["name"] == "execution" and
                           Path(machine["dir"]).resolve() == (home / "execution").resolve() and
                           machine["status"] == "Stopped" and not machine.get("hostAgentPID") and
                           not machine.get("driverPID"), machine)
        finally:
            os.close(fd)
    finally:
        runtime.signal_actor(supervisor, signal.SIGCONT)
        fault.release()
    evidence.observe("simulation", "Owned Lima VM force-stop; not physical host sleep or power loss")
    pending.finish(runtime, lost_reply=True)
    receipt = runtime.terminal(session, request)
    evidence.check("VM interruption does not report tool success", receipt["status"] == "unknown", receipt)
    check_clean(runtime, evidence, session)
    ticks = contents(runtime, request + ".ticks")
    time.sleep(0.4)
    evidence.check("old container has not restarted", contents(runtime, request + ".ticks") == ticks)
    reconcile(runtime, evidence, session, request, request, required=True)
    runtime.recover(session)
    probe = secrets.token_hex(8)
    runtime.submit(session, probe, "/shell " + marker_command(probe))
    evidence.check("new work resumes after real recovery", runtime.terminal(session, probe)["status"] == "succeeded" and
                   contents(runtime, probe) == b"once\n")
    evidence.check("VM boot incarnation changed", runtime.health()["supervisor"]["boot_id"] != before_boot)


def replaced_bundle_case(runtime: Runtime, evidence: Evidence) -> None:
    source = runtime.build.executable.parent
    clone = runtime.root / "replaced-bundle"
    subprocess.run(["/bin/cp", "-cR", str(source), str(clone)], check=True, timeout=180)
    try:
        name = "_internal/amazme_backend/web/style.css"
        manifest = json.loads((clone / "build.json").read_text())
        require(name in manifest["files"], "Frozen manifest has no web stylesheet")
        with (clone / name).open("ab") as stream:
            stream.write(b"\n/* tamper */\n")
        runtime.build.unchanged()
        home, workspace, profile = (runtime.root / "replaced-home", runtime.root / "replaced-workspace",
                                    runtime.root / "replaced-profile")
        home.mkdir(mode=0o700)
        workspace.mkdir(mode=0o700)
        faux = runtime.root / "replaced-faux.json"
        faux.write_text('{"provider":"faux","api_key":""}\n')
        env = {**runtime.env, "HOME": str(home)}
        executable = clone / "amazme-backend"
        init = subprocess.run([str(executable), "init", "--profile", str(profile), "--workspace", str(workspace),
                               "--provider-config", str(faux), "--test-mode", "--approval-policy", "auto"],
                              env=env, cwd=runtime.root, capture_output=True, text=True, timeout=30)
        evidence.check("init does not hash the frozen payload", init.returncode == 0, init.stderr[-800:])
        serve = subprocess.run([str(executable), "serve", "--profile", str(profile)],
                               env=env, cwd=runtime.root, capture_output=True, text=True, timeout=120)
        output = (serve.stdout + "\n" + serve.stderr)[-4000:]
        evidence.check("a replaced bundle file is refused before readiness",
                       serve.returncode != 0 and name in output and not (profile / "ready.json").exists(),
                       {"returncode": serve.returncode, "output": output})
        ipc_key = hashlib.sha256(str(profile.resolve()).encode()).hexdigest()[:16]
        ipc = Path(f"/tmp/amazme-{os.getuid()}-{ipc_key}")
        if ipc.exists():
            require(not any(ipc.iterdir()), "Refused bundle left an IPC socket")
            ipc.rmdir()
        runtime.build.unchanged()
    finally:
        subprocess.run(["/bin/rm", "-rf", str(clone)], check=False)


CORE_CASES = [*("worker." + p for p in WORKER_POINTS), *("supervisor." + p for p in SUPERVISOR_POINTS),
              "host.lost_delivery", "host.takeover_stale_stop", "sessions.sibling", "scheduled.worker_crash",
              "children.join_crash", "children.cancel_descendants", "approval.auto", "storage.commit_crash",
              "events.ack_resync", "workers.restart_budget", "cleanup.unavailable"]
UPDATE_CASES = ["update." + p for p in ("freeze", "prepared", "health", "complete_crash", "roster")]
CASES = [*CORE_CASES, *UPDATE_CASES, "host.pause_delivery", "vm.force_stop", "bundle.replaced_file", "approval.wait"]
LIMITS = [
    "storage.commit_crash kills the real Worker before COMMIT; SQLite FULL and corrupt-format cases are exercised by the isolated storage test suite.",
    "supervisor.closed has only session_id and also fires for startup empty epochs; checkpoint cases prewarm before arming. update.roster arms it on the validation probe.",
    "approval.wait uses a separate fresh mutations profile; other cases use auto. No user profile is loaded.",
    "children.cancel_descendants cancels a live delegated shell whose setsid/double-fork grandchild is writing. cleanup.unavailable and sessions.sibling cover the same descendant shape for cleanup failure and sibling isolation.",
    "update.roster deletes one stopped participant, rewrites another's historical build_id, and adds a container id to the live validation probe receipt. Each rejection is restored before the successful activation.",
    "supervisor.* kills the paused worker and supervisor together. That is the double-crash window; worker.* kills only the worker.",
    "SIGSTOP/SIGCONT and owned VM force-stop are simulations, not hardware sleep or physical power-loss evidence.",
    "bundle.replaced_file clones the source bundle, tampers with one stylesheet, and requires startup to refuse it. The original bundles stay unmodified.",
]


def select_cases(patterns: list[str]) -> list[str]:
    selected: set[str] = set()
    for expression in patterns or ["core"]:
        for pattern in expression.split(","):
            matches = CORE_CASES if pattern == "core" else CASES if pattern == "all" else [
                name for name in CASES if fnmatch.fnmatchcase(name, pattern)]
            require(bool(matches), f"No case matches {pattern!r}; use --list")
            selected.update(matches)
    return [name for name in CASES if name in selected]


def execute_case(runtime: Runtime, evidence: Evidence, builds: tuple[Build, ...]) -> None:
    name = evidence.name
    if name.startswith("worker.") or name.startswith("supervisor."):
        role, point = name.split(".", 1)
        checkpoint_case(runtime, evidence, role, point)
    elif name == "cleanup.unavailable":
        cleanup_unavailable_case(runtime, evidence)
    elif name == "events.ack_resync":
        stream_case(runtime, evidence)
    elif name == "workers.restart_budget":
        restart_budget_case(runtime, evidence)
    elif name == "storage.commit_crash":
        commit_crash_case(runtime, evidence)
    elif name == "host.lost_delivery":
        delivery_case(runtime, evidence)
    elif name == "host.pause_delivery":
        delivery_case(runtime, evidence, pause=True)
    elif name == "host.takeover_stale_stop":
        takeover_case(runtime, evidence)
    elif name == "sessions.sibling":
        sibling_case(runtime, evidence)
    elif name == "scheduled.worker_crash":
        scheduled_case(runtime, evidence)
    elif name == "children.join_crash":
        children_case(runtime, evidence)
    elif name == "children.cancel_descendants":
        children_cancel_case(runtime, evidence)
    elif name == "approval.auto":
        approval_auto_case(runtime, evidence)
    elif name == "approval.wait":
        approval_wait_case(runtime, evidence)
    elif name == "vm.force_stop":
        vm_force_stop_case(runtime, evidence)
    elif name == "bundle.replaced_file":
        replaced_bundle_case(runtime, evidence)
    elif name.startswith("update."):
        require(len(builds) == 2, "Update case requires --target-executable")
        point = "update_completed" if name == "update.complete_crash" else name.replace(".", "_")
        update_case(runtime, evidence, (builds[0], builds[1]), point)
    else:
        raise ValueError(f"No implementation for {name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--executable", type=Path, help="Required immutable onedir executable; no source default")
    parser.add_argument("--target-executable", type=Path, help="Second immutable P2 0.1.0 executable for update cases")
    parser.add_argument("--case", action="append", default=[], help="Repeatable case/glob/comma list, core (default), all")
    parser.add_argument("--all", action="store_true", help="Run all cases; requires --target-executable")
    parser.add_argument("--list", action="store_true", help="List without reading builds or starting processes")
    parser.add_argument("--timeout", type=float, default=90, help="Per-operation seconds (10..110; fault TTL is 120)")
    args = parser.parse_args(argv)
    if args.list:
        print(json.dumps({"cases": CASES, "default": CORE_CASES, "limits": LIMITS}, ensure_ascii=False, indent=2))
        return 0
    if args.executable is None:
        parser.error("--executable is required; mutable source execution is intentionally unsupported")
    if not 10 <= args.timeout <= 110:
        parser.error("--timeout must be between 10 and 110 seconds")
    if args.all and args.case:
        parser.error("Use --all or --case, not both")
    try:
        selected = select_cases(["all"] if args.all else args.case)
    except AssertionError as error:
        parser.error(str(error))
    if any(name in UPDATE_CASES for name in selected) and args.target_executable is None:
        parser.error("Selected update/all cases require --target-executable; no case will be skipped")
    os.umask(0o077)
    # Keep HOME short enough for Lima's Darwin Unix socket paths. Never use the caller's HOME.
    root = Path(tempfile.mkdtemp(prefix="am2-", dir="/tmp"))
    (root / "cases").mkdir(mode=0o700)
    report = {"format": 1, "status": "running", "root": str(root), "started_unix": time.time(),
              "selected": selected, "cases": [], "limits": LIMITS, "builds": [],
              "scope": "faux test-mode; auto plus isolated mutations approval case; fresh HOME/profile/workspace",
              "owned_roots": [],
              "cleanup": {"status": "not_started"}}
    report_path = root / "report.json"
    write_json(report_path, report)
    print(json.dumps({"event": "started", "report": str(report_path), "cases": selected}), flush=True)
    runtime: Runtime | None = None
    runtimes: list[Runtime] = []
    builds: tuple[Build, ...] = ()
    active: Evidence | None = None
    failed = False
    previous_sigterm = signal.getsignal(signal.SIGTERM)

    def terminate(_signum, _frame):
        raise KeyboardInterrupt("termination requested; cleaning owned resources")
    signal.signal(signal.SIGTERM, terminate)
    try:
        build = Build.load(args.executable)
        builds = (build,)
        if args.target_executable:
            target = Build.load(args.target_executable)
            require(target.build_id != build.build_id and target.executable.parent != build.executable.parent,
                    "Two distinct immutable bundles/build IDs are required")
            builds += (target,)
        report["builds"] = [{"executable": str(b.executable), "build_id": b.build_id} for b in builds]
        write_json(report_path, report)
        for name in selected:
            active = Evidence(name, root / "cases" / (name + ".json"))
            report["cases"].append({"case": name, "status": "running", "evidence": str(active.path)})
            if name == "approval.wait":
                approval_root = Path(tempfile.mkdtemp(prefix="am2-", dir="/tmp"))
                current_runtime = Runtime(approval_root, build, args.timeout)
                runtimes.append(current_runtime)
                report["owned_roots"].append(str(approval_root))
                current_runtime.evidence = active
                current_runtime.init(approval_policy="mutations")
                current_runtime.start()
            else:
                if runtime is None:
                    runtime = Runtime(root, build, args.timeout)
                    runtimes.append(runtime)
                    report["owned_roots"].append(str(root))
                    runtime.evidence = active
                    runtime.init()
                    runtime.start()
                current_runtime = runtime
            current_runtime.evidence = active
            current_runtime.case_sessions.clear()
            execute_case(current_runtime, active, builds)
            health = current_runtime.health()
            active.check("case ended without unresolved effect holds", health.get("supervisor") is not None and all(
                h["reconciled"] for h in health["supervisor"]["effects"]))
            active.check("case ended with healthy Host", health["state"] == "ready", health)
            current_runtime.registry()
            active.finish("passed")
            report["cases"][-1]["status"] = active.data["status"]
            write_json(report_path, report)
            print(json.dumps({"event": "case", **report["cases"][-1]}), flush=True)
            active = None
    except (Exception, KeyboardInterrupt) as error:
        failed = True
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()
        if active:
            active.finish("failed", str(error))
            report["cases"][-1]["status"] = "failed"
        completed = {item["case"] for item in report["cases"]}
        for name in selected:
            if name not in completed:
                omitted = Evidence(name, root / "cases" / (name + ".json"))
                omitted.finish("not_run", "Earlier failure stopped the shared-profile group")
                report["cases"].append({"case": name, "status": "not_run", "evidence": str(omitted.path)})
    finally:
        # A second Ctrl-C must not skip destruction after the first requested cancellation.
        previous_sigint = signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            if runtimes:
                report["cleanup"] = {"status": "running", "profiles": []}
                for owned in reversed(runtimes):
                    owned.evidence = None
                    try:
                        cleaned = owned.close()
                    except Exception as error:
                        cleaned = {"status": "failed", "unhandled_error": str(error)}
                    report["cleanup"]["profiles"].append({"root": str(owned.root), **cleaned})
                    failed |= cleaned["status"] != "passed"
                report["cleanup"]["status"] = "passed" if all(
                    p["status"] == "passed" for p in report["cleanup"]["profiles"]) else "failed"
            else:
                report["cleanup"] = {"status": "not_needed", "reason": "No runtime initialized"}
            for build in builds:
                build.unchanged()
        except Exception as error:
            failed = True
            report["cleanup"]["status"] = "failed"
            report["cleanup"]["unhandled_error"] = str(error)
        finally:
            signal.signal(signal.SIGINT, previous_sigint)
            signal.signal(signal.SIGTERM, previous_sigterm)
            report.update(status="failed" if failed else "passed", ended_unix=time.time())
            write_json(report_path, report)
            print(json.dumps({"event": "finished", "status": report["status"], "report": str(report_path)}), flush=True)
    # Legacy verify_runtime may import main() without wrapping its return value.
    # A failed matrix must still produce a nonzero CLI exit in that adapter.
    if failed:
        raise SystemExit(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
