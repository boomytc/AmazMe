"""Native PTY gate, protocol and bounded client buffers."""

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from amazme_backend.contracts import BackendError
from amazme_backend.pty_gate import EXIT, OUTPUT, WINDOW
from amazme_backend.pty_session import SCROLLBACK, PtyClient, utf16_tail, utf16_units

GATE = Path(__file__).parents[1] / "src/amazme_backend/pty_gate.py"
SOURCE = GATE.read_text()


def start(command: str, cols: int = 80, rows: int = 24) -> tuple[subprocess.Popen[bytes], PtyClient]:
    gate, client = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, "-m", "amazme_backend", "pty-gate"],
        stdin=gate.fileno(), stdout=gate.fileno(), stderr=subprocess.PIPE, pass_fds=(gate.fileno(),),
    )
    gate.close()
    pty = PtyClient(client)
    try:
        pty.permit(command, os.getuid(), os.getgid(), cols, rows)
    except BaseException:
        client.close()
        process.wait(timeout=5)
        raise
    return process, pty


def stop(process: subprocess.Popen[bytes], pty: PtyClient) -> None:
    pty.sock.close()
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
        stop(process, pty)


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
            if pty.received >= 200000:
                break
        assert pty.received == 200000
        assert len(pty.output) <= WINDOW
        assert set(pty.output) == {ord("x")}
        pty.pump(1, lambda: pty.exit_code is not None)
        assert pty.exit_code == 0
    finally:
        stop(process, pty)


def test_replenish_keeps_scrollback_past_the_protocol_window() -> None:
    command = "python3 -c 'import sys; sys.stdout.write(\"ab\"*100000); sys.stdout.flush()'"
    process, pty = start(command)
    try:
        for _ in range(40):
            pty.replenish()
            pty.pump(0.2)
            if pty.received >= 200000:
                break
        assert pty.received == 200000
        assert len(pty.output) <= WINDOW
        assert pty.text_seq == 200000
        assert "ab" * 10 in pty.text
        assert len(pty.text) <= SCROLLBACK
        pty.pump(1, lambda: pty.exit_code is not None)
        assert pty.exit_code == 0
    finally:
        stop(process, pty)


def test_split_utf8_and_output_after_exit_stay_in_scrollback() -> None:
    left, right = socket.socketpair()
    pty = PtyClient(left)
    try:
        encoded = "你".encode()
        pty._apply(OUTPUT, encoded[:2])
        pty._apply(OUTPUT, encoded[2:])
        pty._apply(EXIT, (0).to_bytes(4, "big", signed=True) + b"\x01")
        pty._apply(OUTPUT, b"OK")
        assert pty.text == "你OK"
        assert pty.text_seq == 3
        emoji = "🙂".encode()
        other = PtyClient(right)
        other._apply(OUTPUT, emoji[:1])
        assert other.text == "" and other.text_seq == 0
        other._apply(OUTPUT, emoji[1:])
        assert other.text == "🙂" and other.text_seq == utf16_units("🙂") == 2
        assert utf16_tail("A🙂", 2) == "🙂"
        assert utf16_tail("A🙂", 1) == ""
        assert utf16_units("你") == 1 and utf16_units("e\u0301") == 2
        assert pty.exit_code == 0
        assert pty.pending_output is True
    finally:
        left.close()
        right.close()


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
        stop(process, pty)


def test_socket_loss_is_not_an_exit_proof() -> None:
    process, pty = start("sleep 30")
    try:
        pty.sock.close()
        process.wait(timeout=3)
        assert pty.exit_code is None
    finally:
        stop(process, pty)


def test_window_full_is_refused_before_another_frame() -> None:
    process, pty = start("sleep 30")
    try:
        pty.credit = 0
        with pytest.raises(BackendError, match="pty_window_full"):
            pty.send_input(b"more")
    finally:
        stop(process, pty)


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
    xterm_url = (web / "xterm-terminal.js").resolve().as_uri()
    script = "const appURL=" + json.dumps(app_url) + ";\nconst xtermURL=" + json.dumps(xterm_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\nconst boundSession=" + json.dumps(session) + ";\n" + r'''
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
          if(path.endsWith('/terminals') && method==='GET') {
            const opened = seen.find(item=>item.path.endsWith('/terminals'));
            return response({terminals:opened?[{terminal_id:opened.body.terminal_id,workspace:'primary',cols:80,rows:24,queued:0,written:0,exit_code:null,output:'',phase:'running'}]:[]});
          }
          if(path.endsWith('/terminals') && method==='POST') return response({terminal_id:seen.at(-1).body.terminal_id,cols:80,rows:24,queued:0,written:0,exit_code:null,output:'',phase:'running'});
          if(path.endsWith('/input')) {
            const posted = seen.at(-1).body;
            if (posted && posted.data === '\u001b[1;1R' && globalThis.allowReport === false) throw new Error('lost');
            return response({terminal_id:'t',cols:80,rows:24,queued:0,written:3,exit_code:null,output:'',phase:'running',input_status:'accepted'});
          }
          if(path.endsWith('/read')) return response({terminal_id:'t',cols:80,rows:24,queued:0,written:3,exit_code:null,output:'\x1b[2J\x1b[Hhi',output_seq:9,phase:'running'});
          if(path.endsWith('/resize')) return response({terminal_id:'t',cols:100,rows:40,queued:0,written:3,exit_code:null,output:'\x1b[2J\x1b[Hhi',output_seq:9,phase:'running'});
          if(path==='/api/v1/files') return response({path:'',entries:[],truncated:false});
          throw Error('unexpected '+method+' '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
            globalThis.AMAZME_XTERM_URL = xtermURL;
            await import(appURL);
        await until(()=>$('sessions').textContent.includes('工作区'));
        $('terminal').open = true;
        $('terminal').dispatchEvent(new window.Event('toggle'));
        await until(()=>$('terminal-state').textContent.includes('尚无终端'));
        $('terminal-new').click();
        await until(()=>seen.some(item=>item.path.endsWith('/terminals')) && !$('terminal-new').disabled);
        $('terminal-input').value = 'hi';
        $('terminal-form').requestSubmit();
        await until(()=>$('terminal-output').textContent.includes('hi') && $('terminal-input').value === '');
        assert.equal($('terminal-output').textContent.includes('[2J'), false);
        await new Promise(resolve => setTimeout(resolve, 5));
        $('terminal-output').querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown', {key:'Enter', keyCode:13, bubbles:true}));
        await until(()=>seen.filter(item=>item.path.endsWith('/input')).length === 2);
        $('terminal-resize').click();
        await until(()=>seen.some(item=>item.path.endsWith('/resize') && item.body.cols===100 && item.body.rows===40));
        const typed = seen.filter(item=>item.path.endsWith('/input'));
        assert.equal(typed[0].body.data, 'hi\n');
        assert.equal(typed[0].body.input_id.length, 32);
        assert.equal(typed[1].body.data, '\r');
        assert.equal(typed[1].body.input_id.length, 32);
        assert.notEqual(typed[0].body.input_id, typed[1].body.input_id);
        $('terminal-output').querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown', {key:'c', keyCode:67, ctrlKey:true, bubbles:true}));
        await until(()=>seen.some(item=>item.path.endsWith('/input') && item.body.data==='\x03'));

        const emojiView = {id:'emoji'};
        await globalThis.renderTerminal(emojiView, {cols:80, rows:24, output:'A', output_seq:1});
        const second = await globalThis.renderTerminal(emojiView, {cols:80, rows:24, output:'A🙂', output_seq:3});
        assert.equal(second.includes('🙂'), true);
        assert.equal(second.includes('\uDE42') && !second.includes('🙂'), false);
        const third = await globalThis.renderTerminal(emojiView, {cols:80, rows:24, output:'A🙂', output_seq:3});
        assert.equal(third, second);
        const cjk = {id:'cjk'};
        await globalThis.renderTerminal(cjk, {cols:80, rows:24, output:'你', output_seq:1});
        assert.equal((await globalThis.renderTerminal(cjk, {cols:80, rows:24, output:'你好', output_seq:2})).includes('你好'), true);
        const mark = {id:'mark'};
        await globalThis.renderTerminal(mark, {cols:40, rows:4, output:'e', output_seq:1});
        assert.equal((await globalThis.renderTerminal(mark, {cols:40, rows:4, output:'e\u0301', output_seq:2})).includes('e\u0301'), true);
        const resized = await globalThis.renderTerminal(emojiView, {cols:100, rows:40, output:'A🙂', output_seq:3});
        assert.equal(resized.includes('🙂'), true);
        const longView = {id:'long'};
        await globalThis.renderTerminal(longView, {cols:80, rows:8, output:'hello', output_seq:5});
        const replaced = await globalThis.renderTerminal(longView, {cols:80, rows:8, output:'xy', output_seq:100});
        assert.equal(replaced.includes('xy'), true);
        assert.equal(replaced.includes('hello'), false);
        const altText = 'top\r\n\x1b[?1049h\x1b[2J\x1b[HALT\x1b[?1049l';
        const altShown = await globalThis.renderTerminal({id:'alt'}, {cols:4, rows:3, output:altText, output_seq:altText.length});
        assert.equal(altShown.includes('top'), true);
        assert.equal(altShown.includes('ALT'), false);
        const wide = await globalThis.renderTerminal({id:'wide'}, {cols:2, rows:4, output:'你好', output_seq:2});
        assert.equal(wide.split('\n')[0], '你');
        assert.equal(wide.split('\n')[1], '好');
        const colored = '\x1b[31mred\x1b[0m';
        const colorShown = await globalThis.renderTerminal({id:'color'}, {cols:20, rows:2, output:colored, output_seq:colored.length});
        assert.equal(colorShown.includes('red'), true);
        assert.equal(colorShown.includes('[31m'), false);
        const live = seen.find(item => item.path.endsWith('/terminals') && item.body && item.body.terminal_id);
        await globalThis.renderTerminal({id:live.body.terminal_id}, {cols:80, rows:24, output:colored, output_seq:colored.length + 1000});
        let painted = false;
        for (let n = 0; n < 50; n += 1) {
          const row = $('terminal-output').querySelector('.xterm-rows');
          if (row && row.textContent.includes('red') && row.querySelector('.xterm-fg-1')) { painted = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!painted) {
          const row = $('terminal-output').querySelector('.xterm-rows');
          throw new Error('paint ' + (row ? JSON.stringify(row.textContent) : 'missing'));
        }
        const inputPosts = () => seen.filter(item => item.path.endsWith('/input'));
        globalThis.allowReport = false;
        const query = '\u001b[6n';
        await globalThis.renderTerminal({id:live.body.terminal_id}, {cols:80, rows:24, output:query, output_seq:query.length + 8000});
        await until(() => $('error').textContent === 'lost' && inputPosts().some(item => item.body.data === '\u001b[1;1R'));
        const reportId = inputPosts().filter(item => item.body.data === '\u001b[1;1R').at(-1).body.input_id;
        globalThis.allowReport = true;
        $("terminal-retry").click();
        await until(() => $('error').textContent === '' && inputPosts().filter(item => item.body.data === '\u001b[1;1R' && item.body.input_id === reportId).length === 2);
        window.happyDOM && await window.happyDOM.abort();
        process.exit(0);
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
