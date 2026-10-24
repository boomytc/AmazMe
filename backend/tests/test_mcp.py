"""Shipped MCP gate and supervisor approval. No host shell."""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from amazme_backend.mcp_session import McpClient

GATE = (Path(__file__).parents[1] / "src/amazme_backend/mcp_gate.py").read_text()
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
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"echo","description":"回声"}]}})
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
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"hold","description":"等待"}]}})
"""


def start(command: str) -> tuple[subprocess.Popen[bytes], McpClient]:
    gate, client = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, "-I", "-c", GATE],
        stdin=gate.fileno(), stdout=gate.fileno(), stderr=subprocess.PIPE, pass_fds=(gate.fileno(),),
    )
    gate.close()
    mcp = McpClient(client)
    try:
        mcp.permit(command, os.getuid(), os.getgid())
    except BaseException:
        process.kill()
        raise
    return process, mcp


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)


def test_call_hits_the_server_once_and_conflict_does_not(tmp_path: Path) -> None:
    script = tmp_path / "echo_server.py"
    script.write_text(ECHO)
    marker = tmp_path / "calls.txt"
    process, mcp = start(f"/usr/bin/python3 {script} {marker}")
    try:
        assert mcp.tools == [{"name": "echo", "description": "回声"}]
        assert not marker.exists()
        mcp.call("call-1", "echo", {"text": "hi"})
        mcp.pump(2, lambda: "call-1" in mcp.results)
        assert mcp.results["call-1"] == "hi"
        assert marker.read_text() == "hi"
        mcp.call("call-1", "echo", {"text": "hi"})
        mcp.pump(0.5)
        assert marker.read_text() == "hi"
        mcp.call("call-1", "echo", {"text": "no"})
        mcp.pump(0.5, lambda: "call-1" in mcp.conflicts)
        assert "call-1" in mcp.conflicts
        assert marker.read_text() == "hi"
        assert mcp.exit_code is None
    finally:
        stop(process)


def test_cancel_kills_the_process_group_and_reports_waitpid(tmp_path: Path) -> None:
    script = tmp_path / "hold_server.py"
    script.write_text(HOLDER)
    late = tmp_path / "late.txt"
    process, mcp = start(f"/usr/bin/python3 {script} {late}")
    try:
        assert any(item["name"] == "hold" for item in mcp.tools)
        mcp.cancel()
        assert mcp.exit_code == 137
        time.sleep(1.2)
        assert not late.exists()
    finally:
        stop(process)


def test_socket_loss_does_not_emit_an_exit(tmp_path: Path) -> None:
    script = tmp_path / "hold_server.py"
    script.write_text(HOLDER)
    process, mcp = start(f"/usr/bin/python3 {script} {tmp_path / 'unused.txt'}")
    try:
        mcp.sock.close()
        process.wait(timeout=3)
        assert mcp.exit_code is None
    finally:
        stop(process)


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
        const seen = [];
        globalThis.fetch = async (path, options={})=>{
          const method = options.method || 'GET';
          if (method !== 'GET') seen.push({path, body: options.body ? JSON.parse(options.body) : {}});
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
          if(path==='/api/v1/sessions') return response({sessions:[{session_id:''' + json.dumps(session) + r''',title:'工作区',archived:false}]});
          if(path.endsWith('/attachments') && method==='POST') return response({attachment_id:'attach',session_id:''' + json.dumps(session) + r''',build_id:'build',host_epoch:1});
          if(path.endsWith('/mcp') && method==='POST') return response({server_id:'s',phase:'ready',exit_code:null,tools:[{name:'echo',description:'回声'}],clean:false});
          if(path.endsWith('/calls') && method==='POST') return response({call_id:'c',server_id:'s',name:'echo',phase:'waiting_approval',result:'',digest:''' + json.dumps(digest) + r'''});
          if(path.includes('/decision')) return response({call_id:'c',server_id:'s',name:'echo',phase:'done',result:'hi',digest:''' + json.dumps(digest) + r'''});
          if(path.endsWith('/cancel')) return response({server_id:'s',phase:'exited',exit_code:137,tools:[],clean:true});
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
        await until(()=>$('mcp-approval').textContent==='等待批准');
        $('mcp-approval').click();
        await until(()=>$('mcp-result').textContent==='hi');
        $('mcp-cancel').click();
        await until(()=>$('mcp-result').textContent.includes('137'));
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
