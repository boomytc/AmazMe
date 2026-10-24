"""The shipped PTY gate, driven through PtyClient and the supervisor. No host shell."""

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from amazme_backend.contracts import BackendError
from amazme_backend.pty_gate import WINDOW
from amazme_backend.pty_session import PtyClient

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
