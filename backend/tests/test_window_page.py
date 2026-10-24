"""A window URL names its session and workspace. Closing it releases that binding only."""

import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from amazme_backend.contracts import Stream

SESSION_A = "a" * 32
SESSION_B = "b" * 32
SESSION_C = "c" * 32


def _module(suffix: str) -> str:
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    contract = "const root = " + json.dumps(Stream.model_json_schema()) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    source += f"\n// {suffix}\n"
    return "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()


def test_window_url_binds_its_own_session_and_pagehide_does_not_cancel() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    script = (
        "const html=" + json.dumps((web / "index.html").read_text()) + ";\n"
        "const modules=" + json.dumps({
            "fresh": _module("fresh"),
            "named": _module("named"),
            "mismatch": _module("mismatch"),
            "missing": _module("missing"),
            "bare": _module("bare"),
            "wrong": _module("wrong"),
        }) + ";\n"
        "const ids=" + json.dumps({"a": SESSION_A, "b": SESSION_B, "c": SESSION_C}) + ";\n"
        + r"""
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const $=id=>document.getElementById(id);
        async function until(check) {
          for (let n=0;n<1000;n++) { if (check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw new Error('timed out: '+($('error')?.textContent||'')+' '+location.href);
        }
        async function open(mode, url) {
          const window = new Window({url});
          window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
          const calls=[];
          const identity={build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
          const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
          globalThis.window=window;
          globalThis.document=window.document;
          globalThis.location=window.location;
          globalThis.history=window.history;
          globalThis.sessionStorage=window.sessionStorage;
          globalThis.fetch=async (path, options={})=>{
            const method=options.method||'GET';
            calls.push({path,method,body:options.body});
            if (path==='/api/v1/bootstrap') return response(identity);
            if(path.startsWith('/api/v1/session-models/')) return response({session_id:path.split('/').at(-1),provider:'faux',model:'faux'});
            if (path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
            if (path==='/api/v1/health') return response({state:'ready',identity});
            if (path==='/api/v1/sessions' && method==='GET') {
              const sessions=[
                {session_id:ids.a,title:'A',workspace:'primary',archived:false},
                {session_id:ids.b,title:'B',workspace:'primary',archived:false},
              ];
              if (calls.some(call=>call.method==='POST' && call.path==='/api/v1/sessions')) {
                sessions.push({session_id:ids.c,title:'窗口任务',workspace:'primary',archived:false});
              }
              return response({sessions});
            }
            if (path==='/api/v1/sessions' && method==='POST') {
              const body=JSON.parse(options.body);
              assert.equal(body.workspace,'primary');
              assert.equal(body.title,'窗口任务');
              return response({session_id:ids.c,title:body.title,workspace:body.workspace,archived:false},201);
            }
            const parts=path.split('/');
            const session=parts[4];
            if (parts[5]==='attachments' && method==='POST') {
              return response({attachment_id:'binding-'+session,session_id:session,build_id:'build',host_epoch:1},201);
            }
            if (parts[5]==='attachments' && method==='DELETE') return response({detached:true});
            if (parts[5]==='snapshot') return response({session_id:session,stream_id:'stream-'+session,seq:'0',state:'ready',requests:[],events:[],approvals:[],effects:[],previews:[],pending:0,next_wake_ms:0});
            throw new Error('unexpected '+method+' '+path);
          };
          globalThis.WebSocket=class {
            constructor() { this.binding=null; queueMicrotask(()=>this.onopen?.()); }
            send(raw) {
              const frame=JSON.parse(raw);
              if (frame.kind!=='hello') return;
              const session=frame.binding_id.slice('binding-'.length);
              queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot:{session_id:session,stream_id:'stream-'+session,seq:'0',state:'ready',requests:[],events:[],approvals:[],effects:[],previews:[],pending:0,next_wake_ms:0},batches:[],stream_id:'stream-'+session,binding_id:frame.binding_id,build_id:'build',resync:'initial'})}));
            }
            close() { queueMicrotask(()=>this.onclose?.()); }
          };
          await import(modules[mode]);
          return {window, calls};
        }
        function attachments(calls) {
          return calls.filter(call=>call.method==='POST' && call.path.endsWith('/attachments')).map(call=>call.path.split('/')[4]);
        }
        async function main() {
        const fresh=await open('fresh','http://127.0.0.1:1234/?host=host-1&new=1&workspace=primary');
        await until(()=>$('connection').textContent==='已连接');
        assert.equal(new URL(location.href).searchParams.get('host'), 'host-1');
        assert.equal(new URL(location.href).searchParams.get('session'), ids.c);
        assert.equal(new URL(location.href).searchParams.get('workspace'), 'primary');
        assert.equal(new URL(location.href).searchParams.get('new'), null);
        assert.deepEqual(attachments(fresh.calls), [ids.c]);
        fresh.window.dispatchEvent(new fresh.window.Event('pagehide'));
        await until(()=>fresh.calls.some(call=>call.method==='DELETE' && call.path.includes('/attachments/')));
        assert.equal(fresh.calls.some(call=>call.path.includes('/cancel')), false);
        await fresh.window.happyDOM.abort();

        const named=await open('named','http://127.0.0.1:1234/?host=host-1&session='+ids.b+'&workspace=primary');
        await until(()=>$('connection').textContent==='已连接');
        assert.deepEqual(attachments(named.calls), [ids.b]);
        assert.equal(new URL(location.href).searchParams.get('session'), ids.b);
        await named.window.happyDOM.abort();

        const mismatch=await open('mismatch','http://127.0.0.1:1234/?host=host-1&session='+ids.b+'&workspace=docs');
        await until(()=>$('error').textContent.includes('工作区'));
        assert.deepEqual(attachments(mismatch.calls), []);
        await mismatch.window.happyDOM.abort();

        const missing=await open('missing','http://127.0.0.1:1234/?host=host-1&session='+'d'.repeat(32)+'&workspace=primary');
        await until(()=>$('error').textContent.includes('会话不存在'));
        assert.deepEqual(attachments(missing.calls), []);
        await missing.window.happyDOM.abort();

        const bare=await open('bare','http://127.0.0.1:1234/');
        await until(()=>$('error').textContent.includes('宿主'));
        assert.notEqual($('connection').textContent, '已连接');
        assert.deepEqual(attachments(bare.calls), []);
        bare.window.document.querySelectorAll('#sessions button')[1].click();
        await until(()=>$('connection').textContent==='已连接');
        assert.equal(new URL(location.href).searchParams.get('host'), 'host-1');
        assert.equal(new URL(location.href).searchParams.get('session'), ids.b);
        assert.equal(new URL(location.href).searchParams.get('workspace'), 'primary');
        assert.deepEqual(attachments(bare.calls), [ids.b]);
        await bare.window.happyDOM.abort();

        const wrong=await open('wrong','http://127.0.0.1:1234/?host=other&session='+ids.a+'&workspace=primary');
        await until(()=>$('error').textContent.includes('宿主'));
        assert.deepEqual(attachments(wrong.calls), []);
        await wrong.window.happyDOM.abort();
        console.log('window binding verified');
        process.exit(0);
        }

        main().catch(error => { console.error(error); process.exit(1); });
        """
    )
    result = subprocess.run(
        [node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
        cwd=Path(__file__).parents[1], check=False,
    )
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-2000:]
