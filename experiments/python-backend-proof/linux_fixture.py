"""Disposable container PID 1, with direct and daemonized marker writers."""

import json
import os
import signal
import subprocess
import time
from pathlib import Path

ROOT = Path("/proof")
DEADLINE = time.monotonic() + 120


def writer(name):
    # A bounded lifetime also contains the fixture if the test controller fails.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (ROOT / f"{name}.json").write_text(
        json.dumps({"pid": os.getpid(), "ppid": os.getppid(), "sid": os.getsid(0), "pgid": os.getpgrp()})
    )
    with (ROOT / f"{name}.log").open("ab", buffering=0) as stream:
        while time.monotonic() < DEADLINE:
            stream.write(b"effect\n")
            os.fsync(stream.fileno())
            time.sleep(0.02)
    os._exit(0)


while not (ROOT / "permit").exists():
    if time.monotonic() >= DEADLINE:
        raise TimeoutError("test permit was never issued")
    time.sleep(0.01)

subprocess.run(
    ["/bin/sh", "-c", "printf '%s\\n' alpha beta | tr a-z A-Z > /proof/shell.txt"], check=True
)
if os.fork() == 0:
    writer("direct")
if os.fork() == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    while os.getppid() != 1 and time.monotonic() < DEADLINE:
        time.sleep(0.01)
    writer("detached")

while time.monotonic() < DEADLINE:
    try:
        os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        pass
    time.sleep(0.02)
