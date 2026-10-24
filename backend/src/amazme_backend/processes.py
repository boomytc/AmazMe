"""A pre-spawn kernel lease retained by a fixed child until process exit."""

from __future__ import annotations

import asyncio
import fcntl
import os
import stat
import time
from pathlib import Path
from types import TracebackType
from typing import IO, Literal

from .contracts import BackendError, ProcessLease


class ProcessReservation:
    def __init__(self, profile: Path, role: Literal["host", "worker", "supervisor", "execution"], instance: str):
        directory = profile / "processes"
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise BackendError("unsafe_process_directory")
        path = directory / f"{role}-{instance}.lock"
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.stream: IO[str] = os.fdopen(fd, "w+")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            info = os.fstat(fd)
            self.lease = ProcessLease(instance_id=instance, role=role, profile_path=str(profile), path=str(path),
                                      device=info.st_dev, inode=info.st_ino)
            self.stream.write(self.lease.model_dump_json())
            self.stream.flush()
            os.fsync(fd)
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except BaseException:
            self.stream.close()
            raise

    @property
    def fd(self) -> int:
        return self.stream.fileno()

    def close(self) -> None:
        # Closing this duplicate must not LOCK_UN the child's shared open-file description.
        self.stream.close()

    def __enter__(self) -> ProcessReservation:
        return self

    def __exit__(self, kind: type[BaseException] | None, error: BaseException | None,
                 traceback: TracebackType | None) -> None:
        self.close()


def _validate(fd: int, lease: ProcessLease) -> None:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (info.st_dev, info.st_ino) != (lease.device, lease.inode):
        raise BackendError("process_lease_identity_mismatch", status=503)
    current = Path(lease.path).lstat()
    if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (lease.device, lease.inode):
        raise BackendError("process_lease_replaced", status=503)
    if ProcessLease.model_validate_json(os.pread(fd, 8192, 0)) != lease:
        raise BackendError("process_lease_content_mismatch", status=503)


def retain_inherited(fd: int, profile: Path, role: Literal["host", "worker", "supervisor", "execution"], instance: str) -> ProcessLease:
    lease = ProcessLease.model_validate_json(os.pread(fd, 8192, 0))
    expected = profile / "processes" / f"{role}-{instance}.lock"
    if (lease.instance_id, lease.profile_path, lease.role, lease.path) != (instance, str(profile), role, str(expected)):
        raise BackendError("process_lease_owner_mismatch")
    _validate(fd, lease)
    os.set_inheritable(fd, False)
    # Deliberately leave the raw descriptor open. Never wrap/close/unlock it in Python;
    # only kernel process exit releases this inherited reference. Return no descriptor.
    return lease


def exited(lease: ProcessLease) -> bool:
    try:
        fd = os.open(lease.path, os.O_RDWR | os.O_NOFOLLOW)
    except OSError as error:
        raise BackendError("process_exit_unproven", status=503) from error
    try:
        _validate(fd, lease)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        _validate(fd, lease)
        return True
    finally:
        os.close(fd)


async def wait_exited(lease: ProcessLease, timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    while not exited(lease):
        if time.monotonic() >= deadline:
            raise BackendError("process_exit_pending", status=503)
        await asyncio.sleep(0.05)
