from __future__ import annotations

import ctypes
import fcntl
import os
import secrets
import sys
from pathlib import Path
from typing import IO


def copy_extended_metadata(source: int, destination: int) -> None:
    if sys.platform == "darwin":
        library = ctypes.CDLL(None, use_errno=True)
        copy = library.fcopyfile
        copy.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)
        copy.restype = ctypes.c_int
        # Darwin copyfile.h: COPYFILE_ACL | COPYFILE_XATTR, without content or timestamps.
        if copy(source, destination, None, 5) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
    else:
        for attribute in os.listxattr(source):
            os.setxattr(destination, attribute, os.getxattr(source, attribute))


def private_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + "." + secrets.token_hex(4))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def lock(path: Path) -> IO[str]:
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    stream = os.fdopen(fd, "a+")
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        stream.close()
        raise
    return stream
