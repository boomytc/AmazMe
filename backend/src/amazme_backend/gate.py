"""Fixed namespace PID 1: one permit, no reconnect, exit when its owner disconnects."""

import json
import os
import select
import sys


def main() -> int:
    # Unbuffered reads leave post-permit bytes visible to the revocation poll below.
    line = bytearray()
    while b"\n" not in line:
        part = os.read(0, min(8192, 262145 - len(line)))
        if not part:
            return 125
        line.extend(part)
        if len(line) > 262144:
            return 125
    if line.count(b"\n") != 1 or not line.endswith(b"\n"):
        return 125
    try:
        permit = json.loads(line)
        command, uid, gid = permit["command"], permit["uid"], permit["gid"]
        if (type(uid) is not int or type(gid) is not int or uid <= 0 or gid < 0
                or not isinstance(command, str) or not command or "\0" in command
                or set(permit) != {"command", "uid", "gid"}):
            return 125
    except (ValueError, TypeError, KeyError):
        return 125
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
        fd = os.open("/dev/null", os.O_RDONLY)
        os.dup2(fd, 0)
        os.close(fd)
        os.chdir("/workspace")
        os.execve("/bin/sh", ["sh", "-c", command], {
            "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8",
        })
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
        if select.select([0], [], [], 0.1)[0]:
            # EOF or additional input revokes the channel. PID 1 exit kills every namespace descendant.
            return 137


if __name__ == "__main__":
    sys.exit(main())
