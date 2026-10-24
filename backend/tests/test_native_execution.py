"""Native process behavior, without VM, credentials or user projects."""
import asyncio
import json
import os
import sys

import psutil
import pytest

from amazme_backend.native_execution import (
    LocalPermit,
    LocalProcess,
    ProcessIdentity,
    reconcile,
    tool_environment,
)
from amazme_backend.processes import ProcessReservation


async def launch(tmp_path, command, timeout=5):
    directory = tmp_path / "scope"
    directory.mkdir()
    with ProcessReservation(tmp_path, "execution", "runner") as reservation:
        process = await LocalProcess.start(tmp_path, "runner", directory, reservation)
    await process.permit(LocalPermit(call_id="call", cwd=str(tmp_path), command=command, timeout_seconds=timeout))
    return process


async def test_real_shell_cwd_toolchain_output_and_exit(tmp_path):
    process = await launch(tmp_path, "pwd; command -v git; printf native; printf problem >&2; exit 7")
    try:
        result = await asyncio.wait_for(process.collect(), 10)
        assert result.stopped and result.result.exit_code == 7
        assert str(tmp_path) in result.result.stdout and "git" in result.result.stdout
        assert result.result.stdout.endswith("native") and result.result.stderr == "problem"
        assert await reconcile(process.directory, process.lease, permitted=True)
    finally:
        await process.close()


async def test_no_permit_no_user_effect_and_owner_eof_cancels(tmp_path):
    directory = tmp_path / "scope"
    directory.mkdir()
    with ProcessReservation(tmp_path, "execution", "runner") as reservation:
        process = await LocalProcess.start(tmp_path, "runner", directory, reservation)
    await process.close()
    assert await reconcile(directory, process.lease, permitted=False)
    assert not (directory / "result.json").exists()


@pytest.mark.parametrize("cancel", [False, True])
async def test_timeout_or_cancel_stops_observed_child_without_touching_user_service(tmp_path, cancel):
    import subprocess
    user = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    process = await launch(tmp_path, "echo $$ > pid; sleep 30", timeout=1 if not cancel else 30)
    try:
        for _ in range(100):
            if (tmp_path / "pid").exists():
                break
            await asyncio.sleep(.02)
        assert (tmp_path / "pid").exists()
        if cancel:
            await process.close()
        report = await asyncio.wait_for(process.collect(), 10)
        assert report.result.exit_code != 0
        assert report.stopped and report.reason == ("owner_disconnected" if cancel else "timeout")
        assert all(identity.live() is None for identity in report.tracked)
        assert user.poll() is None
    finally:
        await process.close()
        user.terminate()
        user.wait(timeout=3)


async def test_output_is_drained_but_bounded(tmp_path):
    process = await launch(tmp_path, "yes line | head -c 300000")
    try:
        report = await asyncio.wait_for(process.collect(), 10)
        assert report.result.truncated and len(report.result.stdout.encode()) == 65536
    finally:
        await process.close()


def test_identity_reuse_and_environment_are_not_trusted(monkeypatch):
    identity = ProcessIdentity.capture(psutil.Process())
    identity.created -= 1
    assert identity.live() is None
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    monkeypatch.setenv("AMAZME_CONTROL_TOKEN", "secret")
    monkeypatch.setenv("SSH_AUTH_SOCK", "secret")
    env = tool_environment()
    assert env["HOME"] == os.environ["HOME"]
    assert not {"OPENAI_API_KEY", "AMAZME_CONTROL_TOKEN", "SSH_AUTH_SOCK"}.intersection(env)


async def test_killed_runner_does_not_invent_a_stop_receipt(tmp_path):
    directory = tmp_path / "scope"
    directory.mkdir()
    with ProcessReservation(tmp_path, "execution", "runner") as reservation:
        process = await LocalProcess.start(tmp_path, "runner", directory, reservation)
    process.process.kill()
    await process.process.wait()
    assert not await reconcile(directory, process.lease, permitted=True)
    # A recorded identity which is still alive cannot be counted as stopped.
    (directory / "tracked.json").write_text(json.dumps([ProcessIdentity.capture(psutil.Process()).model_dump()]))
    assert not await reconcile(directory, process.lease, permitted=True)
