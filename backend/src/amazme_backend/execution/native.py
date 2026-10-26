"""One registered local invocation. Process observations are not a sandbox proof."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import pwd
import select
import signal
import subprocess
import sys
import time
from pathlib import Path

import psutil
from pydantic import Field

from amazme_backend.contracts.execution import ProcessLease, ReadFile, ToolResult, WriteFile
from amazme_backend.contracts.workspaces import FileWrite
from amazme_backend.execution.processes import ProcessReservation, exited, retain_inherited
from amazme_backend.platform.ipc import child_command
from amazme_backend.platform.private_files import private_write
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model
from amazme_backend.workspaces.files import read_file, write_file

LIMIT = 65536


class ProcessIdentity(Model):
    pid: int
    created: float

    @classmethod
    def capture(cls, process: psutil.Process) -> ProcessIdentity:
        return cls(pid=process.pid, created=process.create_time())

    def live(self) -> psutil.Process | None:
        try:
            process = psutil.Process(self.pid)
            if process.create_time() != self.created or process.status() == psutil.STATUS_ZOMBIE:
                return None
            return process
        except psutil.NoSuchProcess:
            return None


class LocalPermit(Model):
    call_id: str
    cwd: str
    command: str
    timeout_seconds: int = Field(ge=1, le=120)
    file: WriteFile | ReadFile | None = None
    expected_digest: str | None = None


class LocalReport(Model):
    call_id: str
    result: ToolResult | None = None
    stopped: bool
    reason: str = ""
    tracked: list[ProcessIdentity] = Field(default_factory=lambda: list[ProcessIdentity]())


def tool_environment() -> dict[str, str]:
    # Tool discovery is allowed; provider/control capabilities are never inherited.
    keys = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM")
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.setdefault("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    env.setdefault("HOME", pwd.getpwuid(os.getuid()).pw_dir)
    return env


def stop_tracked(tracked: list[ProcessIdentity]) -> bool:
    freeze = sys.platform == "darwin"
    if freeze:
        # Stop parents first so a child's exit cannot wake its shell into the next command.
        # A failed stop must still reach SIGKILL, which also terminates stopped processes.
        for identity in tracked:
            try:
                process = identity.live()
                if process:
                    process.send_signal(signal.SIGSTOP)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    signals = [(signal.SIGKILL, 1.5)] if freeze else [(signal.SIGTERM, 0.4), (signal.SIGKILL, 1.5)]
    for sig, delay in signals:
        waiting: list[psutil.Process] = []
        for identity in reversed(tracked):
            try:
                process = identity.live()
                if process:
                    process.send_signal(sig)
                    waiting.append(process)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        # Only subprocess.Popen may reap our direct child; psutil.wait_procs would consume its exit code.
        deadline = time.monotonic() + delay
        while waiting and time.monotonic() < deadline:
            remaining: list[psutil.Process] = []
            for process in waiting:
                with contextlib.suppress(psutil.NoSuchProcess):
                    if process.is_running() and process.status() != psutil.STATUS_ZOMBIE:
                        remaining.append(process)
            waiting = remaining
            if waiting:
                time.sleep(0.02)
    try:
        return all(identity.live() is None for identity in tracked)
    except psutil.AccessDenied:
        return False


def runner(profile: Path, instance: str, lifetime_fd: int, directory: Path) -> None:
    retain_inherited(lifetime_fd, profile, "execution", instance)
    # Scope is registered before this process is spawned; no user bytes run before the permit.
    private_write(directory / "runner.json", ProcessIdentity.capture(psutil.Process()).model_dump_json())
    line = sys.stdin.buffer.readline(262145)
    if not line or len(line) > 262144 or not line.endswith(b"\n"):
        return
    permit = LocalPermit.model_validate_json(line)
    tracked: dict[int, ProcessIdentity] = {}
    child: subprocess.Popen[bytes] | None = None
    report = LocalReport(call_id=permit.call_id, stopped=True)
    try:
        if permit.file is not None:
            root = Path(permit.cwd)
            if isinstance(permit.file, WriteFile):
                if permit.expected_digest is None:
                    raise BackendError("file_write_unprepared")
                changed = write_file(root, FileWrite(path=permit.file.path, content=permit.file.content,
                                                     expected_digest=permit.expected_digest))
                output = json.dumps({"path": changed.path, "digest": changed.digest})
            else:
                content = read_file(root, permit.file.path)
                output = content.content + ("\n[truncated]" if content.truncated else "")
            report.result = ToolResult(call_id=permit.call_id, exit_code=0, stdout=output, stderr="")
        else:
            shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
            child = subprocess.Popen([shell, "-c", permit.command], cwd=permit.cwd, env=tool_environment(),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     start_new_session=True)
            tracked[child.pid] = ProcessIdentity.capture(psutil.Process(child.pid))
            assert child.stdout is not None and child.stderr is not None
            streams = {child.stdout.fileno(): bytearray(), child.stderr.fileno(): bytearray()}
            out_fd, err_fd = child.stdout.fileno(), child.stderr.fileno()
            for fd in streams:
                os.set_blocking(fd, False)
            deadline = time.monotonic() + permit.timeout_seconds
            truncated, reason = False, ""
            observed: tuple[int, ...] = ()
            while child.poll() is None:
                for identity in list(tracked.values()):
                    try:
                        process = identity.live()
                        if process:
                            for descendant in process.children(recursive=True):
                                if len(tracked) >= 256:
                                    reason = "process_tracking_limit"
                                    break
                                tracked.setdefault(descendant.pid, ProcessIdentity.capture(descendant))
                    except psutil.NoSuchProcess:
                        pass
                    except psutil.AccessDenied:
                        reason = "process_observation_denied"
                if tuple(tracked) != observed:
                    observed = tuple(tracked)
                    private_write(directory / "tracked.json", json.dumps([p.model_dump() for p in tracked.values()]))
                readable, _, _ = select.select([0, *streams], [], [], 0.05)
                if 0 in readable:
                    reason = "cancelled" if os.read(0, 1) else "owner_disconnected"
                if time.monotonic() >= deadline:
                    reason = "timeout"
                for fd in readable:
                    if fd in streams:
                        data = os.read(fd, 8192)
                        buffer = streams[fd]
                        truncated |= len(buffer) + len(data) > LIMIT
                        buffer.extend(data[:max(0, LIMIT - len(buffer))])
                if reason:
                    break
            report.tracked = list(tracked.values())
            report.stopped = stop_tracked(report.tracked)
            try:
                code = child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                code = None
            # Descendants may retain pipes. Drain only available bytes, never wait for EOF.
            for fd, buffer in streams.items():
                drain_deadline = time.monotonic() + 0.2
                while time.monotonic() < drain_deadline and select.select([fd], [], [], 0)[0]:
                    data = os.read(fd, 8192)
                    if not data:
                        break
                    truncated |= len(buffer) + len(data) > LIMIT
                    buffer.extend(data[:max(0, LIMIT - len(buffer))])
            report.reason = reason
            if code is not None:
                report.result = ToolResult(call_id=permit.call_id, exit_code=code,
                    stdout=bytes(streams[out_fd]).decode(errors="replace"),
                    stderr=bytes(streams[err_fd]).decode(errors="replace"), truncated=truncated,
                    stop_reason=reason)
    except BaseException as error:
        report.reason = error.code if isinstance(error, BackendError) else type(error).__name__
        report.stopped = stop_tracked(list(tracked.values()))
        if isinstance(error, BackendError):
            report.result = ToolResult(call_id=permit.call_id, exit_code=1, stdout="", stderr=error.code)
    finally:
        if child:
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()
        private_write(directory / "result.json", report.model_dump_json())


class LocalProcess:
    def __init__(self, process: asyncio.subprocess.Process, directory: Path, lease: ProcessLease):
        self.process, self.directory, self.lease = process, directory, lease

    @classmethod
    async def start(cls, profile: Path, instance: str, directory: Path,
                    reservation: ProcessReservation) -> LocalProcess:
        process = await asyncio.create_subprocess_exec(*child_command(
            "execute", "--profile", str(profile), "--instance", instance,
            "--lifetime-fd", str(reservation.fd), "--directory", str(directory)),
            pass_fds=(reservation.fd,), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            env=tool_environment(), start_new_session=True)
        return cls(process, directory, reservation.lease)

    async def permit(self, value: LocalPermit) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(value.model_dump_json().encode() + b"\n")
        await self.process.stdin.drain()

    async def collect(self) -> LocalReport:
        await self.process.wait()
        return read_report(self.directory)

    async def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            await asyncio.wait_for(self.process.wait(), 6)
        except TimeoutError:
            # This handle still names our direct child; no PID-name scan or adopted signal.
            self.process.kill()
            await self.process.wait()


def read_report(directory: Path) -> LocalReport:
    try:
        data = (directory / "result.json").read_bytes()
        if len(data) > 2 * 1024 * 1024:
            raise BackendError("execution_report_invalid")
        return LocalReport.model_validate_json(data)
    except (OSError, ValueError) as error:
        raise BackendError("tool_outcome_unknown") from error


async def reconcile(directory: Path, lease: ProcessLease, *, permitted: bool) -> bool:
    for _ in range(60):
        if exited(lease):
            break
        await asyncio.sleep(0.1)
    if not exited(lease):
        return False
    with contextlib.suppress(BackendError):
        if read_report(directory).stopped:
            return True
    if not permitted:
        return True
    # A killed runner cannot attest its child stopped. Observed identities are diagnostics;
    # recovery never sends a signal to an adopted bare PID.
    path = directory / "tracked.json"
    if not path.exists():
        return False
    try:
        return all(ProcessIdentity.model_validate(item).live() is None for item in json.loads(path.read_bytes()))
    except (OSError, ValueError, psutil.AccessDenied):
        return False
