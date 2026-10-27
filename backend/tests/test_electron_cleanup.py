"""A failed Electron start may leave a detached backend, but not a user's backend."""

import subprocess
import sys
from pathlib import Path

import pytest

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
    try:
        verify_electron.stop_owned_profile(root)
        assert owned.poll() is not None
        assert unrelated.poll() is None
        assert ambiguous.poll() is None
        with pytest.raises(RuntimeError, match="refusing"):
            verify_electron.stop_owned_profile(tmp_path)
        assert unrelated.poll() is None
    finally:
        for process in (owned, unrelated, ambiguous):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
