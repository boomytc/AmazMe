"""Tear down only the fresh profiles created by live client tests."""

import subprocess
from pathlib import Path


def stop_and_destroy(command: list[str], profile: Path) -> None:
    # Native profiles have no VM disk to destroy. Stop only the owned backend.
    for mode in ("stop",):
        result = subprocess.run([*command, mode, "--profile", str(profile)],
                                capture_output=True, text=True, timeout=90, check=False)
        if result.returncode:
            raise AssertionError(f"test profile {mode} failed: {profile}: {result.stderr[-1500:]}")
