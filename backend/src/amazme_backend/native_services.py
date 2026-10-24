"""Registered native PTY and stdio MCP process ownership, with observed descendants."""
from __future__ import annotations

import asyncio
import contextlib
import json
import select
import socket
import subprocess
import time
from pathlib import Path
from typing import Literal

import psutil

from .common import child_command, private_write
from .native_execution import LocalReport, ProcessIdentity, stop_tracked, tool_environment
from .processes import ProcessReservation, retain_inherited


def runner(profile: Path, instance: str, lifetime_fd: int, directory: Path, kind: Literal["pty", "mcp"]) -> None:
    retain_inherited(lifetime_fd, profile, "execution", instance)
    control = socket.socket(fileno=0)
    gate = subprocess.Popen(child_command("pty-gate" if kind == "pty" else "mcp-gate"), stdin=0, stdout=1,
                            stderr=subprocess.DEVNULL, env=tool_environment(), start_new_session=True)
    tracked = {gate.pid: ProcessIdentity.capture(psutil.Process(gate.pid))}
    observed: tuple[int, ...] = ()
    reason = ""
    try:
        while gate.poll() is None:
            for identity in list(tracked.values()):
                process = identity.live()
                if process:
                    with contextlib.suppress(psutil.NoSuchProcess):
                        for child in process.children(recursive=True):
                            if len(tracked) >= 256:
                                raise RuntimeError("process_tracking_limit")
                            tracked.setdefault(child.pid, ProcessIdentity.capture(child))
            if tuple(tracked) != observed:
                observed = tuple(tracked)
                private_write(directory / "tracked.json", json.dumps([p.model_dump() for p in tracked.values()]))
            if select.select([control], [], [], 0)[0]:
                with contextlib.suppress(BlockingIOError):
                    if not control.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT):
                        reason = "owner_disconnected"
                        break
            time.sleep(0.03)
    except BaseException as error:
        reason = type(error).__name__
    finally:
        stopped = stop_tracked(list(tracked.values()))
        with contextlib.suppress(subprocess.TimeoutExpired):
            gate.wait(timeout=2)
        private_write(directory / "result.json", LocalReport(call_id=instance, stopped=stopped,
                      reason=reason, tracked=list(tracked.values())).model_dump_json())


class ServiceProcess:
    def __init__(self, process: asyncio.subprocess.Process, sock: socket.socket):
        self.process, self.sock = process, sock

    @classmethod
    async def start(cls, profile: Path, instance: str, directory: Path,
                    reservation: ProcessReservation, kind: Literal["pty", "mcp"]) -> ServiceProcess:
        parent, child = socket.socketpair()
        try:
            process = await asyncio.create_subprocess_exec(*child_command(
                "service-runner", "--kind", kind, "--profile", str(profile), "--instance", instance,
                "--lifetime-fd", str(reservation.fd), "--directory", str(directory)),
                stdin=child.fileno(), stdout=child.fileno(), stderr=asyncio.subprocess.DEVNULL,
                pass_fds=(reservation.fd,), env=tool_environment(), start_new_session=True)
            return cls(process, parent)
        except BaseException:
            parent.close()
            raise
        finally:
            child.close()

    async def close(self) -> None:
        with contextlib.suppress(OSError):
            self.sock.shutdown(socket.SHUT_RDWR)
        self.sock.close()
        try:
            await asyncio.wait_for(self.process.wait(), 6)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()
