"""Run a command on a pseudo-terminal, then hang the terminal up like a closed window.

Usage: python3 pty-hangup.py <command> [args...]

The command's terminal output is drained and discarded. A `hangup` line on stdin closes the master
side: the kernel then sends SIGHUP to the command, the session leader of that terminal. The exit
status is written to stdout as one JSON line: {"code": <int|null>, "signal": <int|null>}.
"""

import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
stdin = sys.stdin.fileno()
open_master = True
while open_master:
    ready, _, _ = select.select([master, stdin], [], [])
    if master in ready:
        try:
            if not os.read(master, 65536):
                break
        except OSError:
            break
    if stdin in ready:
        line = os.read(stdin, 1024)
        if not line or b"hangup" in line:
            os.close(master)
            open_master = False

if open_master:
    os.close(master)
_, status = os.waitpid(pid, 0)
result = {
    "code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
    "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
}
sys.stdout.write(json.dumps(result) + "\n")
sys.stdout.flush()
