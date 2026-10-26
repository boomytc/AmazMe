import asyncio
import json
import sqlite3

import pytest
import pytest_asyncio

from amazme_backend.bootstrap.supervisor import create_supervisor
from amazme_backend.contracts import (
    BackendError,
    FreezeSupervisor,
    OpenMcp,
    OpenTerminal,
    TerminalInput,
    TerminalQuery,
    TerminalResize,
    TerminalSession,
)
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile


@pytest_asyncio.fixture
async def terminal_owner(tmp_path):
    private_write(tmp_path / "config.json", json.dumps({"format": 2, "profile_id": "native-terminal",
        "workspace": str(tmp_path), "resources": "unused", "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "test-token")
    owner = create_supervisor(Profile(tmp_path), "terminal-owner")
    await owner.initialize()
    connection = sqlite3.connect(tmp_path / "host.sqlite")
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)")
        connection.execute("INSERT INTO sessions(id, workspace) VALUES(?, 'primary')", ("a" * 32,))
        connection.commit()
    finally:
        connection.close()
    try:
        yield owner
    finally:
        await owner.close()


def query(owner, terminal="b" * 32):
    return TerminalQuery(build_id=owner.build, host_epoch=owner.host_epoch,
                         session_id="a" * 32, terminal_id=terminal)


async def opened(owner, terminal="b" * 32, command="sh"):
    value = OpenTerminal(**query(owner, terminal).model_dump(), command=command, workspace="primary")
    return value, await owner.pty.open(value)


async def test_native_terminal_input_is_durable_once_resize_and_close(terminal_owner, monkeypatch):
    owner = terminal_owner
    monkeypatch.setenv("AMAZME_PRIVATE_TEST_KEY", "must-not-inherit")
    value, view = await opened(owner)
    assert view.phase == "running" and not view.clean
    assert (await owner.pty.open(value)).terminal_id == view.terminal_id
    q = query(owner)
    await owner.pty.resize(TerminalResize(**q.model_dump(), cols=100, rows=40))
    command = "printf x >> once.txt; stty size; pwd; command -v git; printf '%s' \"${AMAZME_PRIVATE_TEST_KEY-unset}\"\n"
    typed = TerminalInput(**q.model_dump(), input_id="once", data=command)
    results = await asyncio.gather(owner.pty.write(typed), owner.pty.write(typed))
    assert all(v.input_status == "accepted" for v in results)
    for _ in range(20):
        view = await owner.pty.read(q)
        if "40 100" in view.output and "unset" in view.output:
            break
    assert "40 100" in view.output and str(owner.profile.path) in view.output
    assert "must-not-inherit" not in view.output
    assert (owner.profile.path / "once.txt").read_text() == "x"
    with pytest.raises(BackendError, match="terminal_input_conflict"):
        await owner.pty.write(typed.model_copy(update={"data": "echo bad\n"}))
    with pytest.raises(BackendError, match="stale_host_epoch"):
        await owner.pty.close(q.model_copy(update={"host_epoch": q.host_epoch + 1}))
    listing = await owner.pty.list(TerminalSession(build_id=owner.build, host_epoch=owner.host_epoch, session_id=q.session_id))
    assert len(listing.terminals) == 1
    closed = await owner.pty.close(q)
    assert closed.clean and closed.phase == "exited"
    assert (await owner.pty.write(typed)).input_status == "accepted"
    assert (await owner.pty.open(value)).phase == "exited"  # no automatic restart


async def test_terminal_failed_input_send_is_not_replayed(terminal_owner, monkeypatch):
    owner = terminal_owner
    await opened(owner)
    client = owner.pty.clients["b" * 32]
    original = client.send_input

    def lost(_data):
        raise OSError("connection lost after uncertain send")

    monkeypatch.setattr(client, "send_input", lost)
    value = TerminalInput(**query(owner).model_dump(), input_id="lost", data="echo bad > replayed\n")
    with pytest.raises(OSError):
        await owner.pty.write(value)
    monkeypatch.setattr(client, "send_input", original)
    assert (await owner.pty.write(value)).input_status == "unknown"
    await asyncio.sleep(.1)
    assert not (owner.profile.path / "replayed").exists()


async def test_session_terminal_survives_worker_cleanup_and_only_own_terminal_is_closed(terminal_owner):
    owner = terminal_owner
    await opened(owner)
    other, _ = await opened(owner, "c" * 32)
    # A completed response or idle worker closes execution epochs, not session resources.
    await owner.cleanup("a" * 32)
    assert (await owner.pty.read(query(owner))).phase == "running"
    await owner.pty.close(query(owner))
    assert (await owner.pty.read(query(owner, "c" * 32))).phase == "running"
    with pytest.raises(BackendError, match="terminal_not_found"):
        await owner.pty.close(query(owner, "c" * 32).model_copy(update={"session_id": "d" * 32}))
    await owner.pty.close(query(owner, other.terminal_id))


async def test_session_retirement_closes_only_its_terminals_and_blocks_new_archived_input(terminal_owner):
    owner = terminal_owner
    first, _ = await opened(owner)
    with sqlite3.connect(owner.profile.path / "host.sqlite") as db:
        db.execute("INSERT INTO sessions(id,workspace) VALUES(?, 'primary')", ("d" * 32,))
    other = first.model_copy(update={"session_id": "d" * 32, "terminal_id": "c" * 32})
    await owner.pty.open(other)
    with sqlite3.connect(owner.profile.path / "host.sqlite") as db:
        db.execute("UPDATE sessions SET archived=1 WHERE id=?", (first.session_id,))
    typed = TerminalInput(**query(owner).model_dump(), input_id="new", data="echo should-not-run\n")
    with pytest.raises(BackendError, match="session_archived"):
        await owner.pty.write(typed)
    receipt = await owner.retire_session(TerminalSession(
        build_id=owner.build, host_epoch=owner.host_epoch, session_id=first.session_id))
    assert receipt.state == "clean" and receipt.proof_id
    assert (await owner.pty.read(query(owner))).clean is True
    other_query = query(owner, "c" * 32).model_copy(update={"session_id": "d" * 32})
    assert (await owner.pty.read(other_query)).phase == "running"
    assert (await owner.retire_session(TerminalSession(
        build_id=owner.build, host_epoch=owner.host_epoch, session_id=first.session_id))).state == "clean"
    assert (await owner.pty.read(other_query)).phase == "running"


async def test_terminal_restart_marks_channel_unknown_without_relaunch(terminal_owner):
    owner = terminal_owner
    value, _ = await opened(owner, command="printf x >> launched; sleep 60")
    directory = owner.profile.path
    for _ in range(50):
        if (directory / "launched").exists():
            break
        await asyncio.sleep(.05)
    assert (directory / "launched").read_text() == "x"

    # Closing the owned transport models a lost supervisor; the native runner observes EOF.
    process = owner.pty.processes.pop(value.terminal_id)
    owner.pty.clients.pop(value.terminal_id)
    await process.close()
    row = await owner.pty._terminal_row(value.terminal_id)
    assert row is not None
    view = await owner.pty._close_terminal(row, interrupted=True)
    assert view.phase == "unknown" and view.clean
    assert (await owner.pty.open(value)).phase == "unknown"
    assert (directory / "launched").read_text() == "x"


async def test_terminal_exit_cleanup_survives_missing_execution_store(terminal_owner):
    owner = terminal_owner
    await opened(owner)
    process = owner.pty.processes["b" * 32]
    owner.db.path.unlink()
    with pytest.raises(BackendError):
        await owner.health()
    await owner.close()
    assert process.process.returncode is not None


async def test_one_unconfirmed_terminal_does_not_prevent_other_owned_terminal_cleanup(terminal_owner, monkeypatch):
    from amazme_backend.execution.native import reconcile

    owner = terminal_owner
    await opened(owner)
    await opened(owner, "c" * 32)
    processes = list(owner.pty.processes.values())
    first = await owner.pty._terminal_row("b" * 32)
    assert first is not None

    async def incomplete(directory, lease, *, permitted):
        if str(directory) == first["directory"]:
            return False
        return await reconcile(directory, lease, permitted=permitted)

    monkeypatch.setattr("amazme_backend.execution.pty.operations.reconcile", incomplete)
    with pytest.raises(BackendError, match="terminal_stop_unconfirmed"):
        await owner.pty.close_all()
    assert all(process.process.returncode is not None for process in processes)
    second = await owner.pty._terminal_row("c" * 32)
    assert second is not None and second["clean"]


async def test_freeze_blocks_new_terminal_work_and_keeps_the_recorded_input(terminal_owner):
    owner = terminal_owner
    value, view = await opened(owner)
    typed = TerminalInput(**query(owner).model_dump(), input_id="once", data="printf x > frozen.txt\n")
    await owner.pty.write(typed)
    for _ in range(40):
        if (owner.profile.path / "frozen.txt").exists():
            break
        await asyncio.sleep(0.05)
    assert (owner.profile.path / "frozen.txt").read_text() == "x"
    fence = FreezeSupervisor(build_id=owner.build, host_epoch=owner.host_epoch, freeze_id="hold")
    await owner.freeze(fence)
    with pytest.raises(BackendError, match="supervisor_frozen"):
        await owner.pty.write(TerminalInput(**query(owner).model_dump(), input_id="again", data="printf y >> frozen.txt\n"))
    assert (owner.profile.path / "frozen.txt").read_text() == "x"
    replay = await owner.pty.write(typed)
    assert replay.input_status == "accepted"
    assert (await owner.pty.read(query(owner))).phase == "running"
    assert (await owner.pty.open(value)).terminal_id == view.terminal_id
    with pytest.raises(BackendError, match="supervisor_frozen"):
        await owner.pty.open(OpenTerminal(**query(owner, "c" * 32).model_dump(), command="printf z > new.txt", workspace="primary"))
    with pytest.raises(BackendError, match="supervisor_frozen"):
        await owner.mcp.open(OpenMcp(build_id=owner.build, host_epoch=owner.host_epoch, session_id="a" * 32,
                                      server_id="d" * 32, command="printf z > mcp.txt", workspace="primary"))
    assert not (owner.profile.path / "new.txt").exists()
    assert not (owner.profile.path / "mcp.txt").exists()
    closed = await owner.pty.close(query(owner))
    assert closed.phase == "exited" and closed.clean
    health = await owner.health()
    await owner.thaw(fence.model_copy(update={"expected_revision": health.registry_revision}))
    _, thawed = await opened(owner, "e" * 32, command="printf w > thawed.txt")
    for _ in range(40):
        if (owner.profile.path / "thawed.txt").exists():
            break
        await asyncio.sleep(0.05)
    assert thawed.phase == "running"
    assert (owner.profile.path / "thawed.txt").read_text() == "w"
    await owner.pty.close(query(owner, "e" * 32))
