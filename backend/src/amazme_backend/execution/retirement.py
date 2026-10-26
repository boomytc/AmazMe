from __future__ import annotations

import contextlib
import fcntl
import os
import stat
from collections.abc import Generator

from amazme_backend.contracts.execution import (
    ProcessLease,
    WorkerInfo,
)
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.layout import SessionRuntimeFile
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError


@contextlib.contextmanager
def retirement_proof(profile: Profile, worker: WorkerInfo) -> Generator[None]:
    """Keep exact lifetime inode AND session writer lock held through retirement commit."""
    lease = worker.process_lease
    if lease is None:
        raise BackendError("process_exit_unproven", status=503)
    expected = profile.path / "processes" / f"worker-{worker.worker_id}.lock"
    if (lease.instance_id, lease.role, lease.profile_path, lease.path) != (
        worker.worker_id, "worker", str(profile.path), str(expected)
    ):
        raise BackendError("process_lease_owner_mismatch", status=503)
    try:
        fd = os.open(lease.path, os.O_RDWR | os.O_NOFOLLOW)
    except OSError as error:
        raise BackendError("process_exit_unproven", status=503) from error
    try:
        info, current = os.fstat(fd), expected.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or not stat.S_ISREG(current.st_mode)
                or (info.st_dev, info.st_ino) != (lease.device, lease.inode)
                or (current.st_dev, current.st_ino) != (lease.device, lease.inode)
                or ProcessLease.model_validate_json(os.pread(fd, 8192, 0)) != lease):
            raise BackendError("process_lease_identity_mismatch", status=503)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with lock(profile.path / "sessions" / worker.session_id / SessionRuntimeFile.WRITER_LOCK):
                yield
        except BlockingIOError as error:
            raise BackendError("worker_retirement_unproven", status=503) from error
    finally:
        os.close(fd)
