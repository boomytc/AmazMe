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
    stop_tracked,
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


@pytest.mark.skipif(sys.platform != 'darwin', reason='macOS stop-before-kill behavior')
async def test_cancel_does_not_wake_a_waiting_shell_into_its_next_command(tmp_path, monkeypatch):
    import signal
    import subprocess
    import time

    marker = tmp_path / 'must-not-run'
    child = subprocess.Popen(['/bin/sh', '-c', 'sleep 30; printf continued > must-not-run'],
        cwd=tmp_path, env=tool_environment(), start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tracked = [ProcessIdentity.capture(psutil.Process(child.pid))]
    try:
        for _ in range(100):
            descendants = psutil.Process(child.pid).children()
            if descendants:
                tracked.extend(ProcessIdentity.capture(process) for process in descendants)
                break
            await asyncio.sleep(.01)
        assert len(tracked) > 1
        send_signal = psutil.Process.send_signal

        def allow_shell_to_wake(process, sig):
            send_signal(process, sig)
            if process.pid != child.pid and sig in {signal.SIGTERM, signal.SIGKILL}:
                # Give the real shell time to observe its child's exit before the next signal.
                time.sleep(.1)

        monkeypatch.setattr(psutil.Process, 'send_signal', allow_shell_to_wake)
        assert stop_tracked(tracked)
        child.wait(timeout=3)
        assert not marker.exists()
    finally:
        for identity in reversed(tracked):
            process = identity.live()
            if process:
                process.kill()
        child.wait(timeout=3)


@pytest.mark.skipif(sys.platform != 'darwin', reason='macOS stop-before-kill behavior')
def test_cancel_still_kills_when_stopping_is_denied(monkeypatch):
    import signal
    import subprocess

    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], env=tool_environment())
    identity = ProcessIdentity.capture(psutil.Process(child.pid))
    send_signal = psutil.Process.send_signal

    def deny_stop(process, sig):
        if sig == signal.SIGSTOP:
            raise psutil.AccessDenied(process.pid)
        send_signal(process, sig)

    monkeypatch.setattr(psutil.Process, 'send_signal', deny_stop)
    try:
        assert stop_tracked([identity])
        child.wait(timeout=3)
        assert child.returncode == -signal.SIGKILL
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)
