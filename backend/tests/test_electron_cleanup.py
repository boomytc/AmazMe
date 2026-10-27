"""A failed Electron start may leave a detached backend, but not a user's backend."""

import subprocess
import sys
from pathlib import Path

import pytest
import psutil

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import verify_electron  # noqa: E402


def test_cleanup_stops_only_the_owned_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(verify_electron, "ROOT", tmp_path)
    root = tmp_path / ".artifacts/native/desktop-restart-owned"
    root.mkdir(parents=True)
    profile = root / "python-profile"
    other = tmp_path / "other-profile"
    command = [sys.executable, "-c", "import time; time.sleep(60)", "--profile"]
    owned = subprocess.Popen([*command, str(profile)])
    unrelated = subprocess.Popen([*command, str(other), "--reference", str(profile)])
    ambiguous = subprocess.Popen([*command, str(profile), "--profile", str(other)])
    same_profile = subprocess.Popen([*command, str(profile)])
    try:
        verify_electron.stop_owned_profile(root, [psutil.Process(owned.pid)])
        assert owned.poll() is not None
        assert unrelated.poll() is None
        assert ambiguous.poll() is None
        assert same_profile.poll() is None
        with pytest.raises(RuntimeError, match="refusing"):
            verify_electron.stop_owned_profile(tmp_path, [psutil.Process(unrelated.pid)])
        assert unrelated.poll() is None
    finally:
        for process in (owned, unrelated, ambiguous, same_profile):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)


def test_cleanup_remembers_children_before_parent_exits(tmp_path, monkeypatch):
    monkeypatch.setattr(verify_electron, "ROOT", tmp_path)
    root = tmp_path / ".artifacts/native/desktop-restart-owned"
    root.mkdir(parents=True)
    parent = subprocess.Popen([sys.executable, "-c",
        "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(p.pid,flush=True); time.sleep(60)"],
        stdout=subprocess.PIPE, text=True)
    child = psutil.Process(int(parent.stdout.readline()))
    try:
        run = verify_electron.ElectronRun(root, root, root / "backend")
        run.owned.append(psutil.Process(parent.pid))
        run._remember_descendants()
        parent.kill()
        parent.wait(timeout=5)
        verify_electron.stop_owned_profile(root, run.owned)
        assert not child.is_running() or child.status() == psutil.STATUS_ZOMBIE
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if child.is_running() and child.status() != psutil.STATUS_ZOMBIE:
            child.kill()
