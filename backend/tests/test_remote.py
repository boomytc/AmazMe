"""Remote daemon identity and disconnect. EOF is not a stop proof."""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, OpenRemote, RemoteCallRequest
from amazme_backend.supervisor import Supervisor

DAEMON = Path(__file__).parent / "helpers/remote_probe.py"
PIN = "correct-host-key"


def start_daemon(state: Path, generation: str = "1") -> tuple[subprocess.Popen[bytes], str]:
    state.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([sys.executable, "-I", str(DAEMON), str(state), PIN, generation], stderr=subprocess.PIPE)
    port = state / "port"
    for _ in range(50):
        if port.exists():
            return process, "127.0.0.1:" + port.read_text().strip()
        time.sleep(0.05)
    raise AssertionError(process.stderr.read() if process.stderr else b"daemon did not listen")


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)




async def supervisor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Supervisor:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "remote", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    from helpers.remote_probe_client import RemoteClient as ProbeClient
    monkeypatch.setattr("amazme_backend.supervisor.RemoteClient.connect", lambda target, *args: ProbeClient.connect(target.host))
    owner = Supervisor(Profile(tmp_path), "supervisor-remote")
    await owner.initialize()
    owner.monitor_task.cancel()
    return owner


def opener(owner: Supervisor, endpoint: str, *, key: str = PIN, generation: int = 1) -> OpenRemote:
    return OpenRemote(host_epoch=owner.host_epoch, build_id=owner.build, session_id="a" * 32,
                      remote_id="b" * 32, host=endpoint, host_key=key,
                      daemon_id=__import__("hashlib").sha256(DAEMON.read_bytes()).hexdigest(), generation=generation)


async def test_wrong_daemon_identity_sends_no_work(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    process, endpoint = start_daemon(tmp_path / "daemon")
    owner = await supervisor(tmp_path, monkeypatch)
    try:
        with pytest.raises(BackendError, match="remote_identity_mismatch"):
            await owner.open_remote(opener(owner, endpoint).model_copy(update={"daemon_id": "0" * 64}))
        view = await owner._remote_row("b" * 32)
        assert view is not None and view["phase"] == "blocked"
        assert not (tmp_path / "daemon" / "effects.txt").exists()
    finally:
        stop(process)
        await owner.close()


async def test_disconnect_keeps_the_daemon_and_does_not_replay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = tmp_path / "daemon"
    process, endpoint = start_daemon(state)
    owner = await supervisor(tmp_path, monkeypatch)
    opened = opener(owner, endpoint)
    try:
        assert (await owner.open_remote(opened)).phase == "connected"
        first = await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="drop"))
        assert first.phase == "unknown"
        assert (state / "effects.txt").read_text() == "drop\n"
        assert process.poll() is None
        remote = await owner._remote_row("b" * 32)
        assert remote is not None and remote["phase"] == "disconnected"
        with pytest.raises(BackendError, match="remote_unreachable"):
            await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="drop"))
        assert (state / "effects.txt").read_text() == "drop\n"
        again = await owner.reconnect_remote(opened)
        assert again.phase == "connected"
        stored = await owner.db.call(lambda db: db.execute("SELECT phase,result FROM remote_calls WHERE id=?", ("c" * 32,)).fetchone())
        assert stored is not None and stored["phase"] == "done" and stored["result"] == "ran:drop"
        assert (state / "effects.txt").read_text() == "drop\n"
        with pytest.raises(BackendError, match="remote_call_conflict"):
            await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="other"))
        assert (state / "effects.txt").read_text() == "drop\n"
    finally:
        stop(process)
        await owner.close()


async def test_generation_change_blocks_without_marking_the_call_stopped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = tmp_path / "daemon"
    process, endpoint = start_daemon(state)
    owner = await supervisor(tmp_path, monkeypatch)
    opened = opener(owner, endpoint)
    try:
        await owner.open_remote(opened)
        await owner.submit_remote(opened, RemoteCallRequest(call_id="c" * 32, command="drop"))
        (state / "generation").write_text("2")
        with pytest.raises(BackendError, match="remote_identity_mismatch"):
            await owner.reconnect_remote(opened)
        remote = await owner._remote_row("b" * 32)
        call = await owner.db.call(lambda db: db.execute("SELECT phase FROM remote_calls WHERE id=?", ("c" * 32,)).fetchone())
        assert remote is not None and remote["phase"] == "blocked"
        assert call is not None and call["phase"] == "unknown"
        assert (state / "effects.txt").read_text() == "drop\n"
        with pytest.raises(BackendError, match="remote_unreachable"):
            await owner.submit_remote(opened, RemoteCallRequest(call_id="d" * 32, command="next"))
        assert (state / "effects.txt").read_text() == "drop\n"
    finally:
        stop(process)
        await owner.close()
