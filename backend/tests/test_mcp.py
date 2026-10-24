"""Native MCP wire behavior; all service processes are explicitly owned."""

import contextlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

from amazme_backend.common import child_command
from amazme_backend.mcp_session import McpClient
from amazme_backend.processes import ProcessReservation

ECHO = """
import json, sys
marker = sys.argv[1]
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"demo","version":"0"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"echo","description":"回声","inputSchema":{"type":"object"}}]}})
    elif method == "tools/call":
        text = msg["params"]["arguments"].get("text", "")
        open(marker, "a").write(text)
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":text}]}})
"""
HOLDER = """
import json, os, sys, time
late = sys.argv[1]
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"hold","version":"0"}}})
    elif method == "tools/list":
        if os.fork() == 0:
            time.sleep(1)
            open(late, "w").write("late")
            os._exit(0)
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"hold","description":"等待","inputSchema":{"type":"object"}}]}})
"""


@contextlib.contextmanager
def running(command: str):
    root = Path(tempfile.mkdtemp(prefix="amazme-mcp-test-"))
    gate, peer = socket.socketpair()
    with ProcessReservation(root, "execution", "mcp-test") as reservation:
        process = subprocess.Popen(child_command("service-runner", "--kind", "mcp", "--profile", str(root),
            "--instance", "mcp-test", "--lifetime-fd", str(reservation.fd), "--directory", str(root)),
            stdin=gate.fileno(), stdout=gate.fileno(), stderr=subprocess.PIPE, pass_fds=(reservation.fd,))
    gate.close()
    client = McpClient(peer)
    try:
        client.permit(command, os.getuid(), os.getgid(), str(root))
        yield process, client, root
    finally:
        peer.close()
        process.wait(timeout=8)
        report = json.loads((root / "result.json").read_text())
        assert report["stopped"]
        shutil.rmtree(root)


def test_call_hits_the_server_once_and_conflict_does_not(tmp_path: Path) -> None:
    script = tmp_path / "echo_server.py"
    script.write_text(ECHO)
    marker = tmp_path / "calls.txt"
    with running(f"/usr/bin/python3 {script} {marker}") as (_process, mcp, _root):
        assert mcp.tools[0].name == "echo" and mcp.tools[0].input_schema == {"type":"object"}
        assert not marker.exists()
        mcp.call("call-1", "echo", {"text": "hi"})
        mcp.pump(2, lambda: "call-1" in mcp.results)
        assert mcp.results["call-1"].text == "hi"
        assert marker.read_text() == "hi"
        mcp.call("call-1", "echo", {"text": "hi"})
        mcp.pump(0.3)
        assert marker.read_text() == "hi"
        mcp.call("call-1", "echo", {"text": "no"})
        mcp.pump(0.5, lambda: "call-1" in mcp.conflicts)
        assert "call-1" in mcp.conflicts and marker.read_text() == "hi"
        assert mcp.exit_code is None


def test_cancel_waits_for_native_server_and_tracked_descendants(tmp_path: Path) -> None:
    script = tmp_path / "hold_server.py"
    script.write_text(HOLDER)
    late = tmp_path / "late.txt"
    with running(f"/usr/bin/python3 {script} {late}") as (process, mcp, root):
        assert any(item.name == "hold" for item in mcp.tools)
        for _ in range(30):
            if len(json.loads((root / "tracked.json").read_text())) >= 3:
                break
            time.sleep(.01)
        assert len(json.loads((root / "tracked.json").read_text())) >= 3
        mcp.cancel()
        assert mcp.exit_code == 0  # Closing stdin lets this server exit normally.
        process.wait(timeout=5)
        time.sleep(1.1)
        assert not late.exists()


SLOW = """
import json, sys
marker = sys.argv[1]
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"slow","version":"0"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"slow","description":"慢","inputSchema":{"type":"object"}}]}})
    elif method == "tools/call":
        open(marker, "a").write("called")
    elif method == "notifications/cancelled":
        open(marker, "a").write(" cancelled")
"""


def test_cancel_call_does_not_stop_the_service(tmp_path: Path) -> None:
    script = tmp_path / "slow_server.py"
    script.write_text(SLOW)
    marker = tmp_path / "calls.txt"
    with running(f"/usr/bin/python3 {script} {marker}") as (process, mcp, _root):
        mcp.call("call-1", "slow", {})
        for _ in range(50):
            if marker.exists() and "called" in marker.read_text():
                break
            time.sleep(0.05)
        assert marker.read_text() == "called"
        mcp.cancel_call("call-1")
        for _ in range(50):
            if "cancelled" in marker.read_text():
                break
            time.sleep(0.05)
        assert marker.read_text() == "called cancelled"
        assert process.poll() is None and mcp.exit_code is None
        mcp.cancel()


def test_socket_loss_does_not_emit_an_exit(tmp_path: Path) -> None:
    script = tmp_path / "hold_server.py"
    script.write_text(HOLDER)
    with running(f"/usr/bin/python3 {script} {tmp_path / 'unused.txt'}") as (process, mcp, _root):
        mcp.sock.close()
        process.wait(timeout=5)
        assert mcp.exit_code is None


def test_browser_approves_an_mcp_call() -> None:
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
    digest = "ab" * 32
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst boundSession=" + json.dumps(session) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/?host=host-1&session='+boundSession+'&workspace=primary'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage,WebSocket:class{send(){}close(){}}});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        const seen = []; let serverState = null, callState = null;
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          if (method !== 'GET') seen.push({path, body: options.body ? JSON.parse(options.body) : {}});
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.endsWith('/mcp') && method==='GET') return response({servers:serverState?[serverState]:[],calls:callState?[callState]:[]});
          if(path.endsWith('/mcp') && method==='POST') {
            serverState={server_id:seen.at(-1).body.server_id,command:'python3 demo.py',workspace:'primary',phase:'ready',protocol_version:'2025-11-25',exit_code:null,tools:[{name:'echo',description:'回声',input_schema:{type:'object'}}],clean:false};
            return response(serverState);
          }
          if(path.endsWith('/calls') && method==='POST') {
            callState={...seen.at(-1).body,server_id:serverState.server_id,phase:'waiting_approval',result:'',digest:"abababababababababababababababababababababababababababababababab"};
            return response(callState);
          }
          if(path.includes('/decision')) { callState={...callState,phase:'done',result:'hi'}; return response(callState); }
          if(path.endsWith('/cancel')) { serverState={...serverState,phase:'exited',exit_code:137,clean:true}; return response(serverState); }
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
        $('mcp-command').value = 'python3 demo.py';
        $('mcp-form').requestSubmit();
        await until(()=>[...$('mcp-tools').children].some(node=>node.textContent==='echo'));
        [...$('mcp-tools').children].find(node=>node.textContent==='echo').click();
        $('mcp-arguments').value = JSON.stringify({text:'hi'});
        $('mcp-request').click();
        await until(()=>$('mcp-approval').querySelector('button'));
        $('mcp-approval').querySelector('button').click();
        await until(()=>$('mcp-result').textContent.includes('hi'));
        $('mcp-cancel').click();
        await until(()=>$('mcp-state').textContent.includes('137'));
        const call = seen.find(item=>item.path.endsWith('/calls'));
        assert.equal(call.body.arguments.text, 'hi');
        const decision = seen.find(item=>item.path.includes('/decision'));
        assert.equal(decision.body.approve, true);
        assert.equal(decision.body.digest, ''' + json.dumps(digest) + r''');
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
