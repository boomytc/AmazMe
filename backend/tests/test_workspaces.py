"""Granted workspaces are real local directories. grant/name is only a logical path."""

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    CodeRun,
    CreateSession,
    HostFence,
    McpCallRequest,
    McpDecision,
    McpOpen,
    OpenMcp,
    OpenTerminal,
    PluginCallRequest,
    ProcessLease,
    ReadFile,
    RemoteOpen,
    RemoteRun,
    RunTool,
    TerminalInput,
    TerminalOpen,
    TerminalQuery,
    TerminalType,
    WorkerInfo,
    WorkerRequest,
    WriteFile,
)
from amazme_backend.host import Host, application
from amazme_backend.processes import ProcessReservation
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
    remote = RemoteOpen(remote_id="a" * 32, host="remote-a", host_key="k" * 16, endpoint="127.0.0.1:9")
    refused = [
        lambda: host.open_terminal(missing, TerminalOpen(terminal_id="f" * 32, command="sh", workspace="primary")),
        lambda: host.open_mcp(missing, McpOpen(server_id="a" * 32, command="python3 demo.py")),
        lambda: host.run_code(missing, CodeRun(run_id="b" * 32, source="1")),
        lambda: host.call_plugin(missing, "c" * 32, PluginCallRequest(call_id="d" * 32, text="hi")),
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
        database.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL DEFAULT 'primary')")
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


def _seed_host(profile: Path, session: str, grant: Path) -> None:
    database = sqlite3.connect(profile / "host.sqlite")
    try:
        database.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL DEFAULT 'primary');
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


def test_browser_switches_to_the_granted_absolute_path() -> None:
    node = __import__("shutil").which("node")
    if node is None:
        pytest.skip("node unavailable")
    import base64
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    schema = __import__("amazme_backend.contracts", fromlist=["Stream"]).Stream.model_json_schema()
    contract = "const root = " + json.dumps(schema) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [], posted = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          if (method !== 'GET') posted.push({path, body: options.body ? JSON.parse(options.body) : {}});
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(SESSION) + r''',title:'工作区',archived:false,workspace:'primary'}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(SESSION) + r''',build_id:'build',host_epoch:1});
          if(path==='/api/v1/workspaces' && method==='GET') return response({workspaces:[
            {name:'primary',host_path:'/var/primary-work',primary:true},
            {name:'docs',host_path:'/var/docs-work',primary:false}]});
          if(path.endsWith('/read')) return response({terminal_id:'t', cols:80, rows:24, queued:0, written:0, exit_code:null, output:'', phase:'running'});
          if(path.endsWith('/terminals') && method==='GET') return response({terminals:[]});
          if(path.endsWith('/terminals') && method==='POST') {
            const body = posted.at(-1).body;
            return response({terminal_id:body.terminal_id, workspace:body.workspace, cols:80, rows:24, queued:0, written:0, exit_code:null, output:'', phase:'running'});
          }
          if(path.endsWith('/mcp') && method==='GET') return response({servers:[], calls:[]});
          if(path.endsWith('/mcp') && method==='POST') {
            const body = posted.at(-1).body;
            return response({server_id:body.server_id, command:body.command, workspace:body.workspace, phase:'ready', protocol_version:'2025-11-25', exit_code:null, tools:[], clean:false});
          }
          if(path==='/api/v1/files' || path.startsWith('/api/v1/files?')) {
            seen.push(path);
            if(path.includes('grant%2Fdocs') || path.includes('grant/docs')) return response({path:'grant/docs',absolute_path:'/var/docs-work',entries:[{name:'note.txt',kind:'file',size:4}],truncated:false});
            return response({path:'',absolute_path:'/var/primary-work',entries:[{name:'keep.txt',kind:'file',size:4}],truncated:false});
          }
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        assert.equal($('session-workspace').textContent, '本机工作区');
        $('files').open = true;
        $('files').dispatchEvent(new window.Event('toggle'));
        await until(()=>$('workspace-location').textContent==='/var/primary-work' && [...$('file-list').children].some(node=>node.textContent==='keep.txt'));
        [...$('workspace-list').children].find(node=>node.textContent==='docs').click();
        await until(()=>$('workspace-location').textContent==='/var/docs-work' && [...$('file-list').children].some(node=>node.textContent==='note.txt'));
        assert.equal($('workspace-location').textContent.includes('grant/'), false);
        assert.equal($('session-workspace').textContent, '本机工作区');
        assert.ok(seen.some(path=>path.includes('grant')));
        [...$('sessions').children].find(node=>node.textContent==='工作区').click();
        await until(()=>$('session-workspace').textContent==='/var/primary-work');
        assert.equal($('workspace-location').textContent, '/var/docs-work');
        $('terminal-new').click();
        await until(()=>posted.some(item=>item.path.endsWith('/terminals')));
        $('mcp-command').value = 'python3 demo.py';
        $('mcp-form').requestSubmit();
        await until(()=>posted.some(item=>item.path.endsWith('/mcp')));
        assert.equal(posted.find(item=>item.path.endsWith('/terminals')).body.workspace, '');
        assert.equal(posted.find(item=>item.path.endsWith('/mcp')).body.workspace, '');
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
