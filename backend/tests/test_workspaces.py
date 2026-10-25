"""Granted workspaces are real local directories. grant/name is only a logical path."""

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    CodeRun,
    CodeView,
    CreateSession,
    HostFence,
    McpCallRequest,
    McpDecision,
    McpOpen,
    OpenMcp,
    OpenTerminal,
    PluginCallRequest,
    PluginCallView,
    ProcessLease,
    ReadFile,
    RemoteOpen,
    RemoteRun,
    RunTool,
    SupervisorHealth,
    TerminalInput,
    TerminalOpen,
    TerminalQuery,
    TerminalType,
    UpdateRecord,
    WorkerInfo,
    WorkerRequest,
    WorkspaceGrantRequest,
    WorkspaceSelect,
    WriteFile,
)
from amazme_backend.host import Host, application
from amazme_backend.processes import ProcessReservation
from amazme_backend.rpc import RpcCall, RpcParams, handle_rpc
from amazme_backend.sdk import Client
from amazme_backend.supervisor import Supervisor

SESSION = "b" * 32


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "maps", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def _ready(host: Host) -> None:
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(host.profile.path),
                         path=str(host.profile.path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build, "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def test_grant_maps_the_same_absolute_path_for_files_and_tools(tmp_path: Path) -> None:
    host = _host(tmp_path)
    other = tmp_path.parent / f"grant-{tmp_path.name}"
    other.mkdir()
    (other / "note.txt").write_text("from-other\n")
    (tmp_path / "primary" / "note.txt").write_text("from-primary\n")
    await _ready(host)
    try:
        async with _client(host) as client:
            created = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(other)})
            assert created.status_code == 200
            assert created.json()["host_path"] == str(other)
            listed = await client.get("/api/v1/files", params={"path": "grant/docs"})
            assert listed.json()["absolute_path"] == str(other)
            assert any(item["name"] == "note.txt" for item in listed.json()["entries"])
            primary = await client.get("/api/v1/files/content", params={"path": "note.txt"})
            assert primary.json()["content"] == "from-primary\n"
            assert primary.json()["absolute_path"] == str(tmp_path / "primary/note.txt")
            extra = await client.get("/api/v1/files/content", params={"path": "grant/docs/note.txt"})
            assert extra.json()["content"] == "from-other\n"
            assert extra.json()["absolute_path"] == str(other / "note.txt")
            saved = await client.post("/api/v1/files/content", json={
                "path": "grant/docs/note.txt", "content": "changed\n", "expected_digest": extra.json()["digest"]})
            assert saved.status_code == 200
            assert (other / "note.txt").read_text() == "changed\n"
            assert (tmp_path / "primary" / "note.txt").read_text() == "from-primary\n"
            removed = await client.delete("/api/v1/workspaces/docs")
            assert removed.status_code == 200
            missing = await client.get("/api/v1/files/content", params={"path": "grant/docs/note.txt"})
            assert missing.status_code == 404
        assert (other / "note.txt").read_text() == "changed\n"
    finally:
        shutil.rmtree(other, ignore_errors=True)
        await host.supervisor.close()
        await host.store.db.close()


async def test_grant_rejects_home_symlink_profile_and_socket(tmp_path: Path) -> None:
    host = _host(tmp_path)
    await _ready(host)
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path / "primary", target_is_directory=True)
    socket_dir = tmp_path / "docker.sock"
    socket_dir.mkdir()
    try:
        async with _client(host) as client:
            for path in (Path.home(), host.profile.path, linked, socket_dir):
                rejected = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(path)})
                assert rejected.status_code == 409
                assert rejected.json()["code"] in {"workspace_grant_forbidden", "workspace_symlink"}
            again = await client.get("/api/v1/workspaces")
            assert [item["name"] for item in again.json()["workspaces"]] == ["primary"]
    finally:
        await host.supervisor.close()
        await host.store.db.close()


async def test_missing_session_does_not_start_work_in_the_primary_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path)
    await _ready(host)
    missing = "e" * 32
    calls: list[str] = []

    async def blocked(_method: str, path: str, _model: object, _body: object) -> object:
        calls.append(path)
        raise AssertionError(path)

    monkeypatch.setattr(host.supervisor, "call", blocked)
    remote = RemoteOpen(remote_id="a" * 32, host="remote-a", host_key="k" * 16)
    refused = [
        lambda: host.open_terminal(missing, TerminalOpen(terminal_id="f" * 32, command="sh", workspace="primary")),
        lambda: host.open_mcp(missing, McpOpen(server_id="a" * 32, command="python3 demo.py")),
        lambda: host.run_code(missing, CodeRun(run_id="b" * 32, source="1")),
        lambda: host.call_plugin(missing, "c" * 32, PluginCallRequest(call_id="d" * 32, name="hello", arguments={"name":"hi"})),
        lambda: host.open_remote(missing, remote),
        lambda: host.submit_remote(missing, RemoteRun(**remote.model_dump(), call_id="1" * 32, command="echo")),
        lambda: host.request_mcp(missing, "a" * 32, McpCallRequest(call_id="2" * 32, name="echo")),
        lambda: host.decide_mcp(missing, "a" * 32, "2" * 32, McpDecision(
            decision_id="once", approve=True, digest="ab" * 32)),
        lambda: host.type_terminal(missing, "f" * 32, TerminalType(input_id="typed", data="pwd\n")),
    ]
    try:
        for attempt in refused:
            with pytest.raises(BackendError, match="session_not_found"):
                await attempt()
        assert calls == []
        assert not (tmp_path / "executions").exists()
        assert not (tmp_path / "plugin-work").exists()
        present = "a" * 32
        await host.store.create_session(present, CreateSession(title="在", workspace="primary"))

        async def reached(_method: str, path: str, _model: object, _body: object) -> object:
            calls.append(path)
            raise BackendError("stopped_after_check")

        monkeypatch.setattr(host.supervisor, "call", reached)
        with pytest.raises(BackendError, match="stopped_after_check"):
            await host.open_terminal(present, TerminalOpen(terminal_id="f" * 32, command="sh"))
        assert calls == ["/pty/open"]
    finally:
        await host.supervisor.close()
        await host.store.db.close()


async def test_update_freeze_returns_finished_code_and_plugin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path)
    await _ready(host)
    session = "a" * 32
    await host.store.create_session(session, CreateSession(title="冻结", workspace="primary"))
    update = UpdateRecord(update_id="upd-1", source_build="a" * 64, target_build="b" * 64,
                          phase="freezing", revision="1", cancel_work=False)
    calls: list[str] = []

    async def active() -> UpdateRecord:
        return update

    async def supervisor(method: str, path: str, _model: object, body: object = None) -> object:
        calls.append(path)
        if path == "/health":
            return SupervisorHealth(identity=host.identity(), registry_revision="1", freeze_id=update.update_id,
                                    workers=[], epochs=[])
        if path == "/code/run" and getattr(body, "run_id") == "b" * 32:
            return CodeView(run_id="b" * 32, phase="success", value="3")
        if path == "/plugins/call" and getattr(body, "call_id") == "d" * 32:
            return PluginCallView.model_validate({"call_id":"d" * 32, "phase":"done", "result":{"content":[{"type":"text","text":"ok"}]}})
        raise BackendError("supervisor_frozen", status=503)

    monkeypatch.setattr(host.store, "active_update", active)
    monkeypatch.setattr(host.supervisor, "call", supervisor)
    try:
        code = await host.run_code(session, CodeRun(run_id="b" * 32, source="1+2"))
        plugin = await host.call_plugin(session, "c" * 32, PluginCallRequest(call_id="d" * 32, name="hello", arguments={"name":"hi"}))
        assert code.value == "3" and plugin.result.content[0]["text"] == "ok"
        with pytest.raises(BackendError, match="update_frozen"):
            await host.run_code(session, CodeRun(run_id="e" * 32, source="9"))
        with pytest.raises(BackendError, match="update_frozen"):
            await host.call_plugin(session, "c" * 32, PluginCallRequest(call_id="f" * 32, name="hello", arguments={"name":"no"}))
        assert calls == ["/health", "/code/run", "/health", "/plugins/call", "/health", "/code/run", "/health", "/plugins/call"]

        async def unmatched() -> UpdateRecord:
            return update.model_copy(update={"update_id": "other"})

        monkeypatch.setattr(host.store, "active_update", unmatched)
        with pytest.raises(BackendError, match="update_frozen"):
            await host.run_code(session, CodeRun(run_id="b" * 32, source="1+2"))
        assert calls[-1] == "/health" and "/code/run" not in calls[8:]

        async def retired(_method: str, path: str, _model: object, _body: object = None) -> object:
            calls.append(path)
            raise httpx.TransportError("supervisor socket closed")

        monkeypatch.setattr(host.supervisor, "call", retired)
        with pytest.raises(BackendError, match="update_prepared"):
            await host.run_code(session, CodeRun(run_id="b" * 32, source="1+2"))
        assert calls[-1] == "/health"
        async with _client(host) as client:
            attached = await client.post(f"/api/v1/sessions/{session}/attachments")
            assert attached.status_code == 201
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            blocked = await client.post(
                f"/api/v1/sessions/{session}/terminals/{'f' * 32}/input",
                json={"input_id": "typed", "data": "pwd\n"},
            )
            assert blocked.status_code == 503 and blocked.json()["code"] == "update_prepared"
    finally:
        await host.supervisor.close()
        await host.store.db.close()


async def test_supervisor_refuses_a_missing_session_row_before_primary(tmp_path: Path) -> None:
    primary = tmp_path / "primary"
    primary.mkdir()
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "missing-row", "workspace": str(primary), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "test-token")
    session = "e" * 32
    terminal = "f" * 32
    owner = Supervisor(Profile(tmp_path), "missing-row")
    await owner.initialize()
    database = sqlite3.connect(tmp_path / "host.sqlite")
    try:
        database.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL DEFAULT 'primary', archived INTEGER NOT NULL DEFAULT 0)")
        database.commit()
    finally:
        database.close()
    reservation: ProcessReservation | None = None
    try:
        fence = {"build_id": owner.build, "host_epoch": owner.host_epoch, "session_id": session}
        with pytest.raises(BackendError, match="session_not_found"):
            await owner.open_terminal(OpenTerminal(
                **fence, terminal_id=terminal, command="printf z > leaked.txt"))
        named = "d" * 32
        with pytest.raises(BackendError, match="session_not_found"):
            await owner.open_terminal(OpenTerminal(
                **fence, terminal_id=named, command="printf z > leaked.txt", workspace="primary"))
        server = "c" * 32
        with pytest.raises(BackendError, match="session_not_found"):
            await owner.open_mcp(OpenMcp(
                **fence, server_id=server, command="python3 demo.py", workspace="primary"))
        for suffix in (terminal, named):
            instance = hashlib.sha256(("terminal:" + suffix).encode()).hexdigest()[:32]
            assert not (tmp_path / "executions" / instance).exists()
        mcp_instance = hashlib.sha256(("mcp:" + server).encode()).hexdigest()[:32]
        assert not (tmp_path / "executions" / mcp_instance).exists()
        worker_id = os.urandom(16).hex()
        reservation = ProcessReservation(owner.profile.path, "worker", worker_id)
        info = WorkerInfo(
            session_id=session, worker_id=worker_id, pid=123, socket=str(owner.profile.worker_socket(session)),
            build_id=owner.build, process_lease=reservation.lease, state="ready", purpose="business",
            host_epoch=owner.host_epoch, fingerprint=owner.build)
        await owner.db.call(lambda db: db.execute(
            "INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
            (worker_id, session, info.model_dump_json())), write=True)
        epoch = await owner.open_epoch(WorkerRequest(session_id=session, worker_id=worker_id, build_id=owner.build))
        with pytest.raises(BackendError, match="session_not_found"):
            await owner.run_tool(RunTool(
                **epoch.model_dump(), call_id="missing-shell", request_id="request",
                command="printf z > leaked.txt", effect="write"))
        assert not (primary / "leaked.txt").exists()
    finally:
        if reservation is not None:
            reservation.close()
        await owner.close()


async def test_unreadable_workspace_does_not_start_shell_terminal_or_mcp(tmp_path: Path) -> None:
    session = "e" * 32
    owners: list[Supervisor] = []

    async def start(name: str) -> tuple[Supervisor, Path]:
        root = tmp_path / name
        primary = root / "primary"
        primary.mkdir(parents=True)
        private_write(root / "config.json", json.dumps({
            "format": 2, "profile_id": name, "workspace": str(primary), "resources": "unused",
            "provider": {"provider": "faux"}}))
        private_write(root / "control.token", "test-token")
        owner = Supervisor(Profile(root), name)
        await owner.initialize()
        owners.append(owner)
        return owner, primary

    async def refuse(owner: Supervisor, primary: Path, code: str) -> None:
        fence = {"build_id": owner.build, "host_epoch": owner.host_epoch, "session_id": session}
        terminal = os.urandom(16).hex()
        server = os.urandom(16).hex()
        with pytest.raises(BackendError, match=code):
            await owner.open_terminal(OpenTerminal(
                **fence, terminal_id=terminal, command="printf z > leaked.txt", workspace="primary"))
        with pytest.raises(BackendError, match=code):
            await owner.open_mcp(OpenMcp(
                **fence, server_id=server, command="python3 demo.py", workspace="primary"))
        worker_id = os.urandom(16).hex()
        reservation = ProcessReservation(owner.profile.path, "worker", worker_id)
        try:
            info = WorkerInfo(
                session_id=session, worker_id=worker_id, pid=123, socket=str(owner.profile.worker_socket(session)),
                build_id=owner.build, process_lease=reservation.lease, state="ready", purpose="business",
                host_epoch=owner.host_epoch, fingerprint=owner.build)
            await owner.db.call(lambda db: db.execute(
                "INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
                (worker_id, session, info.model_dump_json())), write=True)
            epoch = await owner.open_epoch(WorkerRequest(session_id=session, worker_id=worker_id, build_id=owner.build))
            with pytest.raises(BackendError, match=code):
                await owner.run_tool(RunTool(
                    **epoch.model_dump(), call_id="unreadable-shell", request_id="request",
                    command="printf z > leaked.txt", effect="write"))
        finally:
            reservation.close()
        assert not (primary / "leaked.txt").exists()
        for suffix, kind in ((terminal, "terminal:"), (server, "mcp:")):
            instance = hashlib.sha256((kind + suffix).encode()).hexdigest()[:32]
            assert not (owner.profile.path / "executions" / instance).exists()

    try:
        missing_db, primary = await start("missing-db")
        await refuse(missing_db, primary, "workspace_unresolved")

        missing_table, primary = await start("missing-table")
        sqlite3.connect(missing_table.profile.path / "host.sqlite").close()
        await refuse(missing_table, primary, "workspace_unresolved")

        corrupt, primary = await start("corrupt")
        (corrupt.profile.path / "host.sqlite").write_bytes(b"not a database")
        await refuse(corrupt, primary, "workspace_unresolved")

        blank, primary = await start("blank")
        connection = sqlite3.connect(blank.profile.path / "host.sqlite")
        try:
            connection.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)")
            connection.execute("INSERT INTO sessions(id, workspace) VALUES(?, '')", (session,))
            connection.commit()
        finally:
            connection.close()
        await refuse(blank, primary, "workspace_unresolved")

        present, primary = await start("present")
        connection = sqlite3.connect(present.profile.path / "host.sqlite")
        try:
            connection.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)")
            connection.execute("INSERT INTO sessions(id, workspace) VALUES(?, 'primary')", (session,))
            connection.commit()
        finally:
            connection.close()
        fence = {"build_id": present.build, "host_epoch": present.host_epoch, "session_id": session}
        terminal = "f" * 32
        opened = await present.open_terminal(OpenTerminal(
            **fence, terminal_id=terminal, command="sh", workspace="primary"))
        assert opened.workspace == "primary" and opened.phase == "running"
        (present.profile.path / "host.sqlite").unlink()
        query = TerminalQuery(**fence, terminal_id=terminal)
        assert (await present.read_terminal(query)).phase == "running"
        closed = await present.close_terminal(query)
        assert closed.phase == "exited" and closed.clean
        with pytest.raises(BackendError, match="workspace_unresolved"):
            await present.open_terminal(OpenTerminal(
                **fence, terminal_id="a" * 32, command="printf z > after.txt", workspace="primary"))
        assert not (primary / "after.txt").exists()
        assert (await present.read_terminal(query)).phase == "exited"
    finally:
        for owner in owners:
            await owner.close()


def _seed_host(profile: Path, session: str, grant: Path) -> None:
    database = sqlite3.connect(profile / "host.sqlite")
    try:
        database.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL DEFAULT 'primary', archived INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE workspace_grants(name TEXT PRIMARY KEY, host_path TEXT NOT NULL);
        """)
        database.execute("INSERT INTO sessions(id, workspace) VALUES(?, 'docs')", (session,))
        database.execute("INSERT INTO workspace_grants(name, host_path) VALUES('docs', ?)", (str(grant),))
        database.commit()
    finally:
        database.close()


async def test_session_shell_and_terminal_run_in_the_granted_directory(tmp_path: Path) -> None:
    primary = tmp_path / "primary"
    grant = tmp_path / "docs-dir"
    primary.mkdir()
    grant.mkdir()
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "granted", "workspace": str(primary), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "test-token")
    session = "c" * 32
    _seed_host(tmp_path, session, grant)
    owner = Supervisor(Profile(tmp_path), "grant-supervisor")
    await owner.initialize()
    reservation: ProcessReservation | None = None
    try:
        instance = os.urandom(16).hex()
        reservation = ProcessReservation(owner.profile.path, "worker", instance)
        info = WorkerInfo(
            session_id=session, worker_id=instance, pid=123, socket=str(owner.profile.worker_socket(session)),
            build_id=owner.build, process_lease=reservation.lease, state="ready", purpose="business",
            host_epoch=owner.host_epoch, fingerprint=owner.build)
        await owner.db.call(lambda db: db.execute(
            "INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
            (instance, session, info.model_dump_json())), write=True)
        epoch = await owner.open_epoch(WorkerRequest(session_id=session, worker_id=instance, build_id=owner.build))
        result = await owner.run_tool(RunTool(
            **epoch.model_dump(), call_id="grant-shell", request_id="request",
            command="pwd; printf y > granted.txt", effect="write"))
        assert result.exit_code == 0 and str(grant) in result.stdout
        assert (grant / "granted.txt").read_text() == "y"
        assert not (primary / "granted.txt").exists()
        other = tmp_path / "other-dir"
        other.mkdir()
        (grant / "from-grant.txt").write_text("grant-only\n")
        (primary / "from-grant.txt").write_text("primary-only\n")
        database = sqlite3.connect(tmp_path / "host.sqlite")
        try:
            database.execute("INSERT INTO workspace_grants(name, host_path) VALUES('other', ?)", (str(other),))
            database.commit()
        finally:
            database.close()
        written = await owner.run_tool(RunTool(
            **epoch.model_dump(), call_id="grant-write", request_id="request", command="write_file",
            effect="write", file=WriteFile(path="from-tool.txt", content="tool\n"), expected_digest=""))
        assert written.exit_code == 0, written.stderr
        assert (grant / "from-tool.txt").read_text() == "tool\n"
        assert not (primary / "from-tool.txt").exists()
        read = await owner.run_tool(RunTool(
            **epoch.model_dump(), call_id="grant-read", request_id="request", command="read_file",
            effect="read", file=ReadFile(path="from-grant.txt")))
        assert read.exit_code == 0 and read.stdout == "grant-only\n"
        explicit = await owner.run_tool(RunTool(
            **epoch.model_dump(), call_id="other-write", request_id="request", command="write_file",
            effect="write", file=WriteFile(path="grant/other/explicit.txt", content="other\n"), expected_digest=""))
        assert explicit.exit_code == 0, explicit.stderr
        assert (other / "explicit.txt").read_text() == "other\n"
        assert not (grant / "explicit.txt").exists()
        assert not (primary / "explicit.txt").exists()

        terminal = "d" * 32
        opened = await owner.open_terminal(OpenTerminal(
            build_id=owner.build, host_epoch=owner.host_epoch, session_id=session, terminal_id=terminal, command="sh"))
        assert opened.workspace == "docs" and opened.phase == "running"
        query = TerminalQuery(build_id=owner.build, host_epoch=owner.host_epoch, session_id=session, terminal_id=terminal)
        await owner.write_terminal(TerminalInput(**query.model_dump(), input_id="pwd", data="pwd; printf t > from-terminal.txt\n"))
        view = opened
        for _ in range(40):
            view = await owner.read_terminal(query)
            if str(grant) in view.output and (grant / "from-terminal.txt").exists():
                break
            await asyncio.sleep(0.05)
        assert str(grant) in view.output
        assert (grant / "from-terminal.txt").read_text() == "t"
        assert not (primary / "from-terminal.txt").exists()
        closed = await owner.close_terminal(query)
        assert closed.phase == "exited" and closed.clean

        database = sqlite3.connect(tmp_path / "host.sqlite")
        try:
            database.execute("DELETE FROM workspace_grants WHERE name='docs'")
            database.commit()
        finally:
            database.close()
        fresh = await owner.open_epoch(WorkerRequest(session_id=session, worker_id=instance, build_id=owner.build))
        with pytest.raises(BackendError, match="workspace_not_found"):
            await owner.run_tool(RunTool(
                **fresh.model_dump(), call_id="after-revoke", request_id="request",
                command="printf z > after.txt", effect="write"))
        assert (grant / "granted.txt").read_text() == "y"
        assert not (grant / "after.txt").exists()
    finally:
        if reservation is not None:
            reservation.close()
        await owner.close()


def test_tool_path_uses_the_session_workspace_unless_the_grant_is_explicit() -> None:
    from amazme_backend.workspace_map import tool_path
    assert tool_path("docs", "note.txt") == ("docs", "note.txt")
    assert tool_path("docs", "dir/note.txt") == ("docs", "dir/note.txt")
    assert tool_path("docs", "grant/other/note.txt") == ("other", "note.txt")
    assert tool_path("primary", "note.txt") == ("primary", "note.txt")


def test_terminal_gate_uses_native_cwd_and_rejects_relative_path() -> None:
    from amazme_backend.pty_gate import _allowed_cwd
    assert _allowed_cwd("/tmp") == "/tmp"
    with pytest.raises(SystemExit):
        _allowed_cwd("relative/path")
    with pytest.raises(SystemExit):
        _allowed_cwd("/tmp/invalid\0path")




async def test_select_launch_directory_is_stable_and_never_replaces_existing_grants(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    host = _host(profile)
    await _ready(host)
    launch = tmp_path / "another-project"
    launch.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(launch, target_is_directory=True)
    try:
        assert (await host.select_workspace(WorkspaceSelect(host_path=str(profile / "primary")))).primary
        selected = await asyncio.gather(*(host.select_workspace(WorkspaceSelect(host_path=str(launch))) for _ in range(8)))
        assert len({item.name for item in selected}) == 1
        chosen = selected[0]
        assert chosen.host_path == str(launch.resolve())
        assert await host.select_workspace(WorkspaceSelect(host_path=str(alias))) == chosen
        for index in range(7):
            folder = tmp_path / f"other-{index}"
            folder.mkdir()
            await host.add_workspace(WorkspaceGrantRequest(name=f"other-{index}", host_path=str(folder)))
        # Capacity must not turn an identical retry into an error.
        assert await host.add_workspace(WorkspaceGrantRequest(name=chosen.name, host_path=str(launch))) == chosen
        assert await host.select_workspace(WorkspaceSelect(host_path=str(launch))) == chosen
        assert (await host.select_workspace(WorkspaceSelect(host_path=str(launch), name="primary"))).primary
        missing = tmp_path / "ninth"
        missing.mkdir()
        with pytest.raises(BackendError, match="workspace_capacity"):
            await host.select_workspace(WorkspaceSelect(host_path=str(missing)))
        assert len((await host.workspaces()).workspaces) == 9  # primary plus eight grants
        with pytest.raises(BackendError, match="workspace_not_found"):
            await host.select_workspace(WorkspaceSelect(host_path=str(launch), name="absent"))
    finally:
        await host.store.db.close()


async def test_workspace_selection_is_shared_by_sdk_rpc_and_stable_session_creation(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    host = _host(profile)
    await _ready(host)
    launch = tmp_path / "another-project"
    launch.mkdir()
    client = Client(host.origin, "web-only")
    await client._http.aclose()
    client._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin)
    client.build_id, client.host_epoch = host.build, host.fence.host_epoch
    try:
        chosen = await client.select_workspace(str(launch))
        rpc = await handle_rpc(host, RpcCall(id="select", method="workspace.select", params=RpcParams(path=str(launch))))
        assert rpc["result"] == chosen.model_dump()
        session = await client.create_session(title="stable", workspace=chosen.name, session_id=SESSION)
        duplicate = await handle_rpc(host, RpcCall(id="same", method="session.create", params=RpcParams(
            session_id=SESSION, title="stable", workspace=chosen.name)))
        assert duplicate["result"] == session.model_dump()
        assert (await client.workspaces()).workspaces[-1] == chosen
        assert len((await client.sessions()).sessions) == 1
        for index in range(205):
            (launch / f"a{index:03}.txt").touch()
        page = await client.list_files(f"grant/{chosen.name}", offset=200)
        assert page.offset == 200 and page.total == 205 and len(page.entries) == 5
        binding = await client.attach(SESSION)
        rpc_page = await handle_rpc(host, RpcCall(id="files", method="file.list", params=RpcParams(
            session_id=SESSION, workspace=chosen.name, attachment_id=binding.attachment_id, path=f"grant/{chosen.name}", offset=200)))
        assert rpc_page["result"] == page.model_dump()
        instructions = launch / "AGENTS.md"
        instructions.write_text("project instructions")
        host.profile.config.user_resources = str(tmp_path / "agent")
        resources = await client.resources(SESSION)
        assert resources.context_files[-1] == str(instructions)
        listed = await handle_rpc(host, RpcCall(id="resources", method="resource.list", params=RpcParams(
            session_id=SESSION, workspace=chosen.name)))
        assert listed["result"] == resources.model_dump()
    finally:
        await client._http.aclose()
        await host.store.db.close()
