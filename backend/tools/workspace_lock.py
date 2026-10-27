"""One process lock for source desktop builds and resource-owning verifiers."""

from __future__ import annotations

import fcntl
import os
import sys
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV_FD = "AMAZME_WORKSPACE_LOCK_FD"
ENV_OWNER = "AMAZME_WORKSPACE_LOCK_OWNER"


class WorkspaceLockBusy(RuntimeError):
    pass


@contextmanager
def workspace_lock(root: Path = ROOT):
    path = root / ".artifacts/workspace-verification.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if fd < 3:
        duplicate = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 3)
        os.close(fd)
        fd = duplicate
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise WorkspaceLockBusy("已有构建或验证正在运行，请等待结束后重试") from None
        yield fd
    finally:
        os.close(fd)


def run_locked(main):
    try:
        with workspace_lock() as fd:
            previous = {name: os.environ.get(name) for name in (ENV_FD, ENV_OWNER)}
            os.environ[ENV_FD] = str(fd)
            os.environ[ENV_OWNER] = str(os.getpid())
            try:
                main()
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
    except WorkspaceLockBusy as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    if sys.argv[1:] == ["--require"]:
        try:
            owner = int(os.environ[ENV_OWNER])
            if owner <= 0:
                raise ValueError()
            os.kill(owner, 0)
            with workspace_lock():
                raise RuntimeError("workspace lock is not held")
        except WorkspaceLockBusy:
            raise SystemExit(0) from None
        except (KeyError, ValueError, OSError, RuntimeError):
            raise SystemExit("内部构建任务必须由持锁入口调用") from None
    root = Path(sys.argv[1])
    command = sys.argv[2:]
    if not command:
        raise SystemExit("missing command")
    try:
        with workspace_lock(root) as fd:
            os.set_inheritable(fd, True)
            os.environ[ENV_FD] = str(fd)
            os.environ[ENV_OWNER] = str(os.getpid())
            os.execvpe(command[0], command, os.environ)
    except WorkspaceLockBusy as error:
        raise SystemExit(str(error)) from None
