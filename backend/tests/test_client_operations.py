"""Client operation ownership and bounded PTY input, without an external service."""

import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from amazme_backend.contracts import Stream

WEB = Path(__file__).parents[1] / "src/amazme_backend/web"


def run_page(script: str) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
    contract = "const root = " + json.dumps(Stream.model_json_schema()) + ";\n"
    contract += (WEB / "contract.js").read_text().split("\n", 1)[1]
    contract_url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (WEB / "app.js").read_text().replace('"/contract.js"', json.dumps(contract_url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    prelude = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((WEB / "index.html").read_text()) + ";\n"
    result = subprocess.run([node, "--input-type=module"], input=prelude + script, text=True,
                            capture_output=True, timeout=25, cwd=WEB.parents[2])
    assert result.returncode == 0, result.stderr[-5000:] + result.stdout[-2000:]


def test_terminal_input_serializes_bounds_and_keeps_unknown_ids() -> None:
    run_page(r'''
    import assert from 'node:assert/strict';
    const {TerminalInputQueue} = await import(appURL);
    const saved = new Map();
    const storage = {getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
    let release, fail = false, active = true, errors = [];
    const calls = [];
    const queue = new TerminalInputQueue(storage, 'terminal:profile:session:t');
    queue.bind({active:()=>active, changed:()=>{}, error:e=>errors.push(e), send:async head=>{
      calls.push({...head});
      if (calls.length===1) await new Promise(resolve=>release=resolve);
      if (fail) throw Error('lost');
      return {input_status:'accepted'};
    }});
    const until=async check=>{for(let n=0;n<1000;n++){if(check())return;await new Promise(r=>setTimeout(r,1));}throw Error('timeout');};
    queue.enqueue('a');
    for (const text of ['b','c','你好','🙂','\x03']) queue.enqueue(text);
    assert.equal(calls.length,1);
    assert.equal(queue.items.map(x=>x.data).join(''),'abc你好🙂\x03');
    release();
    await until(()=>!queue.busy);
    assert.equal(calls.map(x=>x.data).join(''),'abc你好🙂\x03');
    assert.equal(saved.size,0);
    const pasted = '中🙂'.repeat(6000);
    queue.enqueue(pasted);
    await until(()=>!queue.busy);
    assert.equal(calls.slice(2).map(x=>x.data).join(''), pasted);
    assert.ok(calls.every(x=>new TextEncoder().encode(x.data).length<=4000));
    assert.throws(()=>queue.enqueue('x'.repeat(65537)),/64 KiB/);
    assert.equal(queue.items.length,0);
    fail = true;
    queue.enqueue('lost');
    queue.enqueue('later');
    await until(()=>!queue.busy);
    assert.equal(queue.paused,true);
    const id = calls.at(-1).input_id;
    const count = calls.length;
    assert.throws(()=>queue.enqueue('new'),/尚未确认/);
    assert.equal(calls.length,count);
    assert.equal(queue.items.length,2);
    // Restoring the persistent queue does not send anything automatically.
    const restored = new TerminalInputQueue(storage,queue.key);
    assert.equal(restored.paused,true);
    assert.equal(restored.items[0].input_id,id);
    fail = false;
    queue.retry();
    await until(()=>!queue.busy);
    assert.equal(calls[count].input_id,id);
    assert.equal(calls.at(-1).data,'later');
    assert.equal(saved.size,0);
    active = false;
    queue.enqueue('unsubmitted');
    await until(()=>!queue.busy);
    assert.equal(queue.items.length,1);
    queue.confirm();
    assert.equal(saved.size,0);
    assert.equal(errors.length,1);
    ''')


def test_late_script_and_tool_replies_only_settle_the_original_operation() -> None:
    run_page(r'''
    import assert from 'node:assert/strict';
    import {Window} from 'happy-dom';
    const a='a'.repeat(32), b='b'.repeat(32);
    const window=new Window({url:'http://127.0.0.1:1234/?host=host-1&session='+a+'&workspace=primary'});
    window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
    Object.assign(globalThis,{window,document:window.document,location:window.location,history:window.history,sessionStorage:window.sessionStorage});
    const $=id=>document.getElementById(id);
    const identity={build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
    const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    const plugin={session_id:a,plugin_id:'c'.repeat(32),name:'greeting',entry:'/test/extension.py',fingerprint:'f'.repeat(64),phase:'ready',config:{},tools:[{name:'hello',label:'Greeting',kind:'tool'}]};
    const held=[];
    let bindings=0;
    globalThis.fetch=async(path,options={})=>{
      const method=options.method||'GET', body=options.body?JSON.parse(options.body):{};
      if(path==='/api/v1/bootstrap')return response(identity);
      if(path==='/api/v1/health')return response({state:'ready',identity});
      if(path==='/api/v1/models')return response({models:[{provider:'faux',model:'faux',label:'Faux',endpoint_editable:false},{provider:'deepseek',model:'deepseek-flash',label:'DeepSeek',endpoint_editable:true}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false}});
      if(path==='/api/v1/sessions')return response({sessions:[{session_id:a,title:'A',workspace:'primary'},{session_id:b,title:'B',workspace:'primary'}]});
      if(path==='/api/v1/plugins' && method==='POST'){plugin.plugin_id=body.plugin_id;plugin.session_id=body.session_id;return response(plugin);}
      if(path.startsWith('/api/v1/plugins?'))return response({plugins:[{...plugin,session_id:new URL(path,location.href).searchParams.get('session_id')}]});
      if(path.endsWith('/attachments')&&method==='POST'){bindings++;return response({attachment_id:'binding-'+path.split('/')[4],session_id:path.split('/')[4],build_id:'build',host_epoch:1});}
      if(method==='DELETE')return response({detached:true});
      if(path.endsWith('/computer/cleanup'))return response({cleared:true,proof:'owned-exit'});
      if(path.endsWith('/computer/observe'))return response({permitted:true,capture:{capture_id:path.split('/')[4],width:100,height:100}});
      if(path.endsWith('/remotes'))return response({phase:'connected'});
      if(path.endsWith('/resources'))return new Promise(resolve=>held.push({path,body,resolve:v=>resolve(response(v))}));
      if(method==='POST') return new Promise(resolve=>held.push({path,body,resolve:v=>resolve(response(v))}));
      if(path.startsWith('/api/v1/session-models/')) return response({session_id:path.split('/').at(-1),provider:'faux',model:'faux'});
      throw Error('unexpected '+method+' '+path);
    };
    globalThis.WebSocket=class {
      constructor(){queueMicrotask(()=>this.onopen?.());}
      send(raw){const f=JSON.parse(raw);if(f.kind!=='hello')return;const session=f.binding_id.slice(8);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({snapshot:{session_id:session,stream_id:'s-'+session,seq:'0',state:'ready',requests:[],events:[],approvals:[],effects:[],previews:[],pending:0,next_wake_ms:0},batches:[],stream_id:'s-'+session,binding_id:f.binding_id,build_id:'build',resync:'initial'})}));}
      close(){}
    };
    const until=async check=>{for(let n=0;n<1000;n++){if(check())return;await new Promise(r=>setTimeout(r,1));}throw Error('timeout '+$('error').textContent);};
    const foreign = JSON.stringify({target:a,request_id:'foreign',text:'another host',mode:'queue'});
    sessionStorage.setItem('pending:host-2',foreign);
    sessionStorage.setItem('pending',foreign);
    sessionStorage.setItem('actions:host-2','{}');
    await import(appURL);
    await until(()=>$('connection').textContent==='已连接');
    async function select(id){const before=bindings;document.querySelectorAll('#sessions button')[id===a?0:1].click();await until(()=>bindings>before&&new URL(location.href).searchParams.get('session')===id&&$('connection').textContent==='已连接'); await new Promise(resolve=>setTimeout(resolve,5));}
    $('plugins').open=true;
    $('plugin-name').value='greeting'; $('plugin-entry').value=plugin.entry; $('plugin-label').value='{}'; $('plugin-text').value=JSON.stringify({name:'Bob'});
    $('plugin-form').requestSubmit();
    await until(()=>$('plugin-selected').value===plugin.plugin_id);
    const cases=[
      {form:'code-run',key:s=>'code-run:host-1:'+s,out:'code-result',payload:{phase:'success',value:'old',state:'old'}},
      {form:'web-search',key:s=>'web-call:host-1:'+s,out:'web-state',payload:{phase:'done',result:'old'}},
      {form:'plugin-call',key:s=>[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).find(k=>k.startsWith('plugin-call:host-1:'+s)),out:'plugin-result',payload:{phase:'done',result:{content:[{type:'text',text:'old'}]}}},
      {form:'computer-ground',key:s=>'computer-operation:host-1:'+s,out:'computer-state',payload:{phase:'done',result:{status:'old'}}},
      {form:'computer-act',key:s=>'computer-action:host-1:'+s,out:'computer-state',payload:{phase:'done',driver_x:99,driver_y:99}},
      {form:'remote-command',key:s=>[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).find(k=>k.startsWith('remote-call:host-1:'+s)),out:'remote-result',payload:{phase:'done',result:'old'}},
    ];
    async function start(test) {
      if(test.form==='computer-act'){$('computer-observe').click();await until(()=>$('computer-state').textContent.startsWith('100×100'));}
      if(test.form==='remote-command'){$('remote-form').requestSubmit();await until(()=>$('remote-state').textContent==='已连接');}
      const node=$(test.form);node.tagName==='FORM'?node.requestSubmit():node.click();
    }
    for(const test of cases){
      await select(a);
      await start(test);await until(()=>held.length===1);
      const first=held.shift(), keyA=test.key(a);
      assert.ok(sessionStorage.getItem(keyA));
      await select(b);
      await start(test);await until(()=>held.length===1);
      const second=held.shift(), keyB=test.key(b), recordB=sessionStorage.getItem(keyB);
      const before=$(test.out).textContent;
      first.resolve(test.payload);
      await until(()=>sessionStorage.getItem(keyA)===null);
      assert.equal(sessionStorage.getItem(keyB),recordB);
      assert.equal($(test.out).textContent,before);
      // A-B-A: an old B response cannot overwrite the newly attached A page either.
      await select(a);
      const after=$(test.out).textContent;
      second.resolve(test.payload);
      await until(()=>sessionStorage.getItem(keyB)===null);
      assert.equal($(test.out).textContent,after);
    }
    await select(a);
    $('resources-load').click();await until(()=>held.length===1);
    const resourceA=held.shift();
    await select(b);
    $('resources-load').click();await until(()=>held.length===1);
    const resourceB=held.shift();
    const catalog={context_files:['A-only'],skills:[],prompts:[],diagnostics:[]};
    resourceA.resolve(catalog);
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal($('resources-list').textContent,'');
    await select(a);
    resourceB.resolve({...catalog,context_files:['B-only']});
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal($('resources-list').textContent,'');
    // A cleanup proof may arrive before the old HTTP waiter receives its unknown result.
    $('computer-ground').click();await until(()=>held.length===1);
    const old=held.shift(), nativeKey='computer-operation:host-1:'+a;
    const original=JSON.parse(sessionStorage.getItem(nativeKey));
    $('computer-cleanup').click();await until(()=>JSON.parse(sessionStorage.getItem(nativeKey)).reviewed===true);
    old.resolve({phase:'unknown',result:{status:'review'}});
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(JSON.parse(sessionStorage.getItem(nativeKey)).reviewed,true);
    assert.equal(JSON.parse(sessionStorage.getItem(nativeKey)).action_id,original.action_id);
    $('computer-goal').value='Next explicit operation';$('computer-ground').click();await until(()=>held.length===1);
    const next=held.shift();assert.notEqual(next.body.action_id,original.action_id);
    next.resolve({phase:'done',result:{status:'verified'}});
    await until(()=>sessionStorage.getItem(nativeKey)===null);
    // Preparing an attachment cannot combine A's image with B's current text.
    const readers=[];
    globalThis.FileReader=class {
      readAsDataURL(file){readers.push({file,resolve:()=>{this.result='data:image/png;base64,'+file.data;this.onload?.();}});}
    };
    await select(a);
    $('model-choice').value='deepseek\ndeepseek-flash';
    $('prompt').value='A attachment';
    Object.defineProperty($('images'),'files',{configurable:true,value:[{name:'a.png',type:'image/png',size:1,data:'YQ=='}]});
    $('images').onchange();
    const prepareA=$('composer').onsubmit({preventDefault(){}});
    await until(()=>readers.length===1);
    await select(b);
    $('model-choice').value='faux\nfaux';
    $('prompt').value='B attachment';
    Object.defineProperty($('images'),'files',{configurable:true,value:[{name:'b.png',type:'image/png',size:1,data:'Yg=='}]});
    $('images').onchange();
    const prepareB=$('composer').onsubmit({preventDefault(){}});
    await until(()=>readers.length===2);
    $('model-choice').value='deepseek\ndeepseek-flash';
    readers[0].resolve();await prepareA;
    assert.equal(sessionStorage.getItem('pending:host-1'),null);
    assert.equal($('prompt').value,'B attachment');
    assert.equal($('image-note').textContent,'b.png');
    readers[1].resolve();await until(()=>held.length===1);
    const submitted=held.shift();
    assert.equal(submitted.path,'/api/v1/sessions/'+b+'/submissions');
    assert.equal(submitted.body.text,'B attachment');
    assert.deepEqual(submitted.body.model_selection,{provider:'faux',model:'faux'});
    assert.equal(submitted.body.images[0].data_base64,'Yg==');
    submitted.resolve({request_id:submitted.body.request_id,status:'queued'});await prepareB;
    await select(a);
    assert.equal($('prompt').value,'A attachment');
    assert.equal($('image-note').textContent,'a.png');
    assert.equal(sessionStorage.getItem('pending:host-2'),foreign);
    assert.equal(sessionStorage.getItem('pending'),foreign);
    assert.equal(sessionStorage.getItem('actions:host-2'),'{}');
    await window.happyDOM.abort();process.exit(0);
    ''')
