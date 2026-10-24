import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from runtime_cleanup import stop_and_destroy


def test_live_profile_cleanup_deletes_disks_only_after_successful_stop(tmp_path, monkeypatch):
    run = Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
    monkeypatch.setattr(subprocess, "run", run)
    stop_and_destroy(["owned-backend"], tmp_path)
    assert [call.args[0] for call in run.call_args_list] == [
        ["owned-backend", mode, "--profile", str(tmp_path)] for mode in ("stop",)]
    run.reset_mock()
    run.return_value = subprocess.CompletedProcess([], 1, "", "cleanup unproven")
    with pytest.raises(AssertionError, match="stop failed"):
        stop_and_destroy(["owned-backend"], tmp_path)
    assert run.call_count == 1


def test_destroy_vm_is_rejected_and_creates_nothing(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    rejected = subprocess.run(
        [sys.executable, "-m", "amazme_backend", "destroy-vm", "--profile", str(profile)],
        capture_output=True, text=True, timeout=15, check=False)
    assert rejected.returncode != 0
    assert "destroy-vm" in rejected.stderr
    assert not profile.exists()
    shown = subprocess.run(
        [sys.executable, "-m", "amazme_backend", "--help"],
        capture_output=True, text=True, timeout=15, check=False)
    assert shown.returncode == 0
    assert "destroy-vm" not in shown.stdout
    assert "init" in shown.stdout and "serve" in shown.stdout and "stop" in shown.stdout
