"""Fixed container PID 1. It reads one private runtime permit before executing user code.

This file is copied verbatim into the container command by the supervisor. Workload
code runs as the granted workspace UID, with a separate session and no capabilities.
"""

import json
import os
import sys

line = sys.stdin.buffer.readline(262145)
if not line or len(line) > 262144:
    sys.exit(125)
permit = json.loads(line)
command = permit["command"]
uid = int(permit["uid"])
gid = int(permit["gid"])
if uid == 0 or not isinstance(command, str):
    sys.exit(125)
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
_, status = os.waitpid(pid, 0)
# Exiting namespace PID 1 also terminates daemonized descendants of the command.
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
