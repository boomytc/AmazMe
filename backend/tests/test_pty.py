"""The shipped PTY gate, driven through PtyClient and the supervisor. No host shell."""

import hashlib
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, OpenTerminal, TerminalInput, TerminalQuery, TerminalResize
from amazme_backend.pty_gate import WINDOW
from amazme_backend.pty_session import PtyClient, pty_container
from amazme_backend.supervisor import Supervisor
from amazme_backend.vm import Container

GATE = Path(__file__).parents[1] / "src/amazme_backend/pty_gate.py"
SOURCE = GATE.read_text()


def start(command: str, cols: int = 80, rows: int = 24) -> tuple[subprocess.Popen[bytes], PtyClient]:
    gate, client = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, "-I", "-c", SOURCE],
        stdin=gate.fileno(), stdout=gate.fileno(), stderr=subprocess.PIPE, pass_fds=(gate.fileno(),),
    )
    gate.close()
    pty = PtyClient(client)
    try:
        pty.permit(command, os.getuid(), os.getgid(), cols, rows)
    except BaseException:
        process.kill()
        raise
    return process, pty


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)


def test_input_resize_and_waitpid_exit() -> None:
    command = (
        "python3 -c 'import fcntl,struct,sys,termios; sys.stdin.readline(); "
        "size=struct.unpack(\"HHHH\", fcntl.ioctl(1, termios.TIOCGWINSZ, bytes(8))); "
        "sys.stdout.write(\"%d %d\\n\" % (size[0], size[1])); sys.stdout.flush()'"
    )
    process, pty = start(command)
    try:
        pty.resize(100, 40)
        pty.send_input(b"\n")
        pty.pump(3, lambda: pty.exit_code is not None)
        text = pty.output.decode(errors="replace")
        assert "40 100" in text
        assert pty.exit_code == 0
    finally:
        stop(process)


def test_output_stops_at_the_window_until_the_client_grants_credit() -> None:
    command = "python3 -c 'import sys; sys.stdout.write(\"x\"*200000); sys.stdout.flush()'"
    process, pty = start(command)
    try:
        pty.pump(1)
        assert 0 < len(pty.output) <= WINDOW
        held = len(pty.output)
        pty.pump(0.3)
        assert len(pty.output) == held
        for _ in range(40):
            pty.grant(WINDOW)
            pty.pump(0.3)
            if len(pty.output) >= 200000:
                break
        assert pty.output.count(ord("x")) == 200000
        pty.pump(1, lambda: pty.exit_code is not None)
        assert pty.exit_code == 0
    finally:
        stop(process)


def test_input_is_accounted_as_written_or_queued() -> None:
    process, pty = start("sleep 30")
    try:
        payload = b"y" * 8192
        pty.send_input(payload)
        pty.pump(1, lambda: pty.written + pty.queued >= len(payload))
        assert pty.written + pty.queued == len(payload)
        assert pty.queued <= WINDOW
        assert pty.exit_code is None
    finally:
        stop(process)


def test_socket_loss_is_not_an_exit_proof() -> None:
    process, pty = start("sleep 30")
    try:
        pty.sock.close()
        process.wait(timeout=3)
        assert pty.exit_code is None
    finally:
        stop(process)


def test_window_full_is_refused_before_another_frame() -> None:
    process, pty = start("sleep 30")
    try:
        pty.credit = 0
        with pytest.raises(BackendError, match="pty_window_full"):
            pty.send_input(b"more")
    finally:
        stop(process)


class RecordingVM:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.image_id = "sha256:image"
        self.socket = profile.path / "docker.sock"
        self.containers: dict[str, Container] = {}
        self.specs: list[dict[str, object]] = []
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self.request), base_url="http://docker")

    def request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/containers/create":
            spec = json.loads(request.content.decode())
            self.specs.append(spec)
            cid = hashlib.sha256(request.url.params["name"].encode()).hexdigest()
            item = Container.model_validate({"Id": cid, "Config": spec,
                "State": {"Running": False, "Pid": 0, "ExitCode": 0, "Status": "created"}})
            self.containers[cid] = item
            return httpx.Response(201, json={"Id": cid})
        cid = path.split("/")[2]
        if path.endswith("/start"):
            self.containers[cid].State.Running = True
            return httpx.Response(204)
        raise AssertionError(path)

    async def inspect(self, identity: str) -> Container | None:
        return self.containers.get(identity)

    async def cgroup(self, container: Container) -> str:
        return "/sys/fs/cgroup/" + container.Id

    async def close(self) -> None:
        await self.http.aclose()


def spawn_gate(spec: dict[str, object], procs: list[subprocess.Popen[bytes]]) -> PtyClient:
    command = spec["Cmd"]
    assert command == ["python", "-I", "-c", SOURCE]
    assert spec["Tty"] is False
    host = spec["HostConfig"]
    assert isinstance(host, dict) and host["NetworkMode"] == "none"
    gate, client = socket.socketpair()
    process = subprocess.Popen([sys.executable, "-I", "-c", SOURCE], stdin=gate.fileno(), stdout=gate.fileno(),
                               stderr=subprocess.PIPE, pass_fds=(gate.fileno(),))
    gate.close()
    procs.append(process)
    return PtyClient(client)


async def test_supervisor_keeps_exit_unknown_until_waitpid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "pty", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    monkeypatch.setattr("amazme_backend.supervisor.VM", RecordingVM)
    owner = Supervisor(Profile(tmp_path), "supervisor-pty")
    await owner.initialize()
    owner.monitor_task.cancel()
    procs: list[subprocess.Popen[bytes]] = []

    async def connect(cid: str, spec: dict[str, object]) -> PtyClient:
        del cid
        return spawn_gate(spec, procs)

    owner.connect_gate = connect  # type: ignore[method-assign]
    session = "a" * 32
    fence = {"host_epoch": owner.host_epoch, "build_id": owner.build, "session_id": session}
    try:
        opened = await owner.open_terminal(OpenTerminal(
            **fence, terminal_id="b" * 32, command="exit 3", cols=80, rows=24))
        assert owner.vm.specs and owner.vm.specs[0]["Cmd"][2] == "-c"
        view = opened
        for _ in range(15):
            view = await owner.read_terminal(TerminalQuery(**fence, terminal_id="b" * 32))
            if view.exit_code is not None:
                break
        assert view.exit_code == 3 and view.phase == "exited"
        stored = await owner._terminal_row("b" * 32)
        assert stored is not None and stored["exit_code"] == 3
        typed = await owner.open_terminal(OpenTerminal(
            **fence, terminal_id="c" * 32, command="sleep 30", cols=80, rows=24))
        assert typed.phase == "running" and typed.exit_code is None
        first = await owner.write_terminal(TerminalInput(
            **fence, terminal_id="c" * 32, input_id="input-1", data="hi"))
        again = await owner.write_terminal(TerminalInput(
            **fence, terminal_id="c" * 32, input_id="input-1", data="hi"))
        assert again.written == first.written and again.queued == first.queued
        resized = await owner.resize_terminal(TerminalResize(**fence, terminal_id="c" * 32, cols=100, rows=40))
        assert resized.cols == 100 and resized.rows == 40
        with pytest.raises(BackendError, match="terminal_input_conflict"):
            await owner.write_terminal(TerminalInput(**fence, terminal_id="c" * 32, input_id="input-1", data="no"))
        owner.terminals["c" * 32].sock.close()
        lost = await owner.read_terminal(TerminalQuery(**fence, terminal_id="c" * 32))
        assert lost.exit_code is None and lost.phase == "unknown"
    finally:
        for process in procs:
            stop(process)
        await owner.close()


def test_browser_sends_terminal_input_and_resize() -> None:
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
    session = "d" * 32
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst boundSession=" + json.dumps(session) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session='+boundSession+'&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          if (method !== 'GET') seen.push({path, body: options.body ? JSON.parse(options.body) : {}});
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.endsWith('/terminals') && method==='POST') return response({terminal_id:seen.at(-1).body.terminal_id,cols:80,rows:24,queued:0,written:0,exit_code:null,output:'',phase:'running'});
          if(path.endsWith('/input')) return response({terminal_id:'t',cols:80,rows:24,queued:0,written:3,exit_code:null,output:'',phase:'running'});
          if(path.endsWith('/read')) return response({terminal_id:'t',cols:80,rows:24,queued:0,written:3,exit_code:null,output:'hi',phase:'running'});
          if(path.endsWith('/resize')) return response({terminal_id:'t',cols:100,rows:40,queued:0,written:3,exit_code:null,output:'hi',phase:'running'});
          if(path==='/api/v1/files') return response({path:'',entries:[],truncated:false});
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        await until(()=>$('sessions').textContent.includes('工作区'));
        $('terminal').open = true;
        $('terminal').dispatchEvent(new window.Event('toggle'));
        await until(()=>seen.some(item=>item.path.endsWith('/terminals')));
        $('terminal-input').value = 'hi';
        $('terminal-form').requestSubmit();
        await until(()=>$('terminal-output').textContent.includes('hi'));
        $('terminal-resize').click();
        await until(()=>seen.some(item=>item.path.endsWith('/resize') && item.body.cols===100 && item.body.rows===40));
        const typed = seen.find(item=>item.path.endsWith('/input'));
        assert.equal(typed.body.data, 'hi\n');
        assert.equal(typed.body.input_id.length, 32);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]


def test_container_spec_is_the_gate_without_a_host_shell() -> None:
    spec = pty_container(SOURCE, "sha256:image", {"amazme.scope": "pty"})
    assert spec["Tty"] is False
    assert spec["Cmd"] == ["python", "-I", "-c", SOURCE]
    host = spec["HostConfig"]
    assert isinstance(host, dict)
    assert host["NetworkMode"] == "none"
    assert host["Binds"] == ["/workspace:/workspace:rw"]
    assert host["CapDrop"] == ["ALL"]
    assert "sh" not in spec["Cmd"]
