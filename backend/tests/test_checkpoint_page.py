"""Exercise the shipped file page, with controllable HTTP response ordering."""

import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from amazme_backend.contracts import Stream


def _run_page(scenario: str) -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    contract = "const root = " + json.dumps(Stream.model_json_schema()) + ";\n" + contract

    def module_url(source: str) -> str:
        return "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()

    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(module_url(contract)))
    script = (
        "const appURL=" + json.dumps(module_url(source)) + ";\n"
        "const html=" + json.dumps((web / "index.html").read_text()) + ";\n"
        + _PAGE + "\n" + scenario + "\nassert.deepEqual(unexpected, []);\n"
        "await window.happyDOM.abort(); process.exit(0);\n"
    )
    result = subprocess.run(
        [node, "--input-type=module"], input=script, text=True, capture_output=True,
        timeout=20, cwd=Path(__file__).parents[1], check=False,
    )
    assert result.returncode == 0, result.stderr[-5000:] + result.stdout[-1000:]


_PAGE = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Window} from 'happy-dom';
const window = new Window({url:'http://127.0.0.1:1234/'});
window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
Object.assign(globalThis, {window, document:window.document, location:window.location,
  history:window.history, sessionStorage:window.sessionStorage, WebSocket:class {send(){} close(){}}});
const $ = id => document.getElementById(id);
const digest = text => createHash('sha256').update(text).digest('hex');
const response = (value, status=200) => new Response(JSON.stringify(value),
  {status, headers:{'Content-Type':'application/json'}});
const workspace = path => path.startsWith('grant/') ? path.split('/')[1] : 'primary';
const files = new Map(['a.txt','b.txt','empty.txt','large.txt','grant/docs/a.txt'].map(path =>
  [path,{path,content:'current '+path,digest:digest('current '+path),truncated:path==='large.txt'}]));
const checkpoints = new Map();
const histories = new Map();
function checkpoint(id, path, content) {
  const item = {checkpoint_id:id.repeat(32),path,workspace:workspace(path),digest:digest(content),content};
  checkpoints.set(item.checkpoint_id,item);
  const list = histories.get(path) || [];
  list.push(item); histories.set(path,list);
  return item;
}
const oldA = checkpoint('f','a.txt','old A');
const latestA = checkpoint('a','a.txt','latest A');
const latestB = checkpoint('b','b.txt','latest B');
const docs = checkpoint('d','grant/docs/a.txt','saved docs');
const calls = [], holds = [], unexpected = [];
function hold(method, path, file) {
  let release;
  const promise = new Promise(resolve => {release=resolve;});
  const gate = {method,path,file,promise,release,entered:false};
  holds.push(gate); return gate;
}
function route(call) {
  const {url,method,body} = call;
  const path = url.pathname;
  const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host'};
  if (path==='/api/v1/bootstrap') return response(identity);
  if (path==='/api/v1/health') return response({state:'ready',identity});
  if (path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地',endpoint_editable:false}],
    current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
  if (path==='/api/v1/sessions') return response({sessions:[]});
  if (path==='/api/v1/workspaces') {
    if (method==='POST') return response({name:body.name,absolute_path:'/grant/'+body.name,primary:false});
    return response({workspaces:[{name:'primary',host_path:'/workspace',primary:true},
      {name:'docs',host_path:'/grant/docs',primary:false}]});
  }
  if (path==='/api/v1/files') {
    const dir = url.searchParams.get('path') || '';
    const prefix = dir ? dir+'/' : '';
    const names = [...files.keys()].filter(name => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'));
    return response({path:dir,absolute_path:dir ? '/'+dir : '/workspace',
      entries:names.map(name=>({name:name.slice(prefix.length),kind:'file',size:10})),truncated:false});
  }
  if (path==='/api/v1/files/content') {
    if (method==='GET') {
      const file=files.get(url.searchParams.get('path'));
      return response({...file,content:file.truncated ? file.content.slice(0,32000) : file.content});
    }
    const file = files.get(body.path);
    assert.equal(body.expected_digest,file.digest,'save must use the selected file digest');
    file.content=body.content; file.digest=digest(file.content);
    return response({path:body.path,digest:file.digest,diff:'saved '+body.path});
  }
  if (path==='/api/v1/checkpoints') {
    if (method==='GET') {
      const name=url.searchParams.get('path');
      assert.equal(url.searchParams.get('workspace'),workspace(name),'discovery must use mapped workspace');
      return response({checkpoints:histories.get(name)||[]});
    }
    assert.equal(body.workspace,workspace(body.path),'checkpoint must use mapped workspace');
    const file=files.get(body.path);
    const saved={checkpoint_id:body.checkpoint_id,path:body.path,workspace:body.workspace,digest:file.digest,content:file.content};
    checkpoints.set(saved.checkpoint_id,saved);
    histories.set(body.path,[...(histories.get(body.path)||[]),saved]);
    return response(saved);
  }
  if (path.startsWith('/api/v1/checkpoints/')) {
    const item=checkpoints.get(path.split('/')[4]);
    assert.ok(item,'only a discovered or successfully created checkpoint may be used');
    const file=files.get(item.path);
    if (method==='GET') return response({...item,absolute_path:'/workspace/'+item.path,
      current_digest:file.digest,diff:'preview '+item.content});
    assert.ok(path.endsWith('/restore'));
    assert.equal(body.expected_digest,file.digest,'restore must use the selected file current digest');
    file.content=item.content; file.digest=item.digest;
    return response({path:item.path,digest:file.digest,diff:'restored '+item.path});
  }
  unexpected.push(method+' '+url); throw Error(unexpected.at(-1));
}
globalThis.fetch = async (path, options={}) => {
  const call={url:new URL(path,location.href),method:options.method||'GET',body:options.body ? JSON.parse(options.body) : {}};
  calls.push(call);
  const gate=holds.find(item=>!item.entered && item.method===call.method && item.path===call.url.pathname &&
    (item.file===undefined || item.file===call.url.searchParams.get('path')));
  if (gate) {
    gate.entered=true;
    const override=await gate.promise;
    if (override) return response(override.value,override.status||200);
  }
  return route(call);
};
async function until(check, reason='page state') {
  for (let n=0;n<500;n++) {
    if (check()) return;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  throw Error('timed out waiting for '+reason+': '+$('error').textContent);
}
async function settle() { for(let n=0;n<8;n++) await new Promise(resolve=>setImmediate(resolve)); }
function clickFile(name) {
  const node=[...$('file-list').children].find(node=>node.textContent===name);
  assert.ok(node,'file listed: '+name); node.click();
}
function clickWorkspace(name) {
  const node=[...$('workspace-list').children].find(node=>node.textContent===name);
  assert.ok(node,'workspace listed: '+name); node.click();
}
async function openFile(name) {
  clickFile(name);
  const file=files.get(name);
  await until(()=>$('file-content').value===(file.truncated ? file.content.slice(0,32000) : file.content),'file content '+name);
  await settle();
}
function screen() {
  return {content:$('file-content').value,diff:$('file-diff').textContent,
    checkpoint:$('checkpoint-state')?.textContent,error:$('error').textContent,
    disabled:['file-save','checkpoint-save','checkpoint-preview','checkpoint-restore'].map(id=>$(id).disabled)};
}
await import(appURL);
await until(()=>calls.some(call=>call.url.pathname==='/api/v1/sessions'));
await settle();
$('files').open=true;
$('files').dispatchEvent(new window.Event('toggle'));
await until(()=>[...$('file-list').children].some(node=>node.textContent==='a.txt'));
await settle();
$('error').textContent='';
"""


def test_discovers_latest_valid_checkpoint_and_preview_preserves_editor() -> None:
    _run_page(r"""
histories.get('a.txt').push(latestB, {...latestA,workspace:'docs'},
  {...latestA,checkpoint_id:''}, {...latestA,digest:''});
await openFile('a.txt');
assert.ok(calls.some(call=>call.url.pathname==='/api/v1/checkpoints' && call.url.searchParams.get('path')==='a.txt'));
assert.match($('checkpoint-state').textContent,/a\.txt/);
assert.ok($('checkpoint-state').textContent.includes(latestA.digest.slice(0,12)));
assert.equal($('checkpoint-preview').disabled,false);
$('file-content').value='unsaved editor text';
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview latest A');
assert.equal($('file-content').value,'unsaved editor text');
assert.equal(calls.some(call=>call.method==='POST'),false);
assert.deepEqual(unexpected,[]);
""")


def test_empty_failed_and_truncated_files_cannot_reuse_a_checkpoint() -> None:
    _run_page(r"""
await openFile('a.txt');
await openFile('empty.txt');
assert.match($('checkpoint-state').textContent,/暂无检查点/);
assert.equal($('checkpoint-preview').disabled,true);
assert.equal($('checkpoint-restore').disabled,true);
assert.equal($('checkpoint-save').disabled,false);
const failure=hold('GET','/api/v1/files/content','b.txt');
clickFile('b.txt');
assert.equal($('file-content').value,'');
for(const id of ['file-save','checkpoint-save','checkpoint-preview','checkpoint-restore']) assert.equal($(id).disabled,true);
await until(()=>failure.entered);
failure.release({value:{message:'cannot read B'},status:404});
await until(()=>$('error').textContent==='cannot read B');
assert.equal($('checkpoint-restore').disabled,true);
await openFile('large.txt');
assert.match($('file-diff').textContent,/文件过大/);
assert.equal($('file-save').disabled,true);
assert.equal($('checkpoint-save').disabled,false);
assert.equal($('checkpoint-restore').disabled,true);
""")


def test_mapped_workspace_restore_uses_digest_after_save_and_reloads_editor() -> None:
    _run_page(r"""
await openFile('a.txt');
clickWorkspace('docs');
assert.equal($('file-content').value,'');
assert.equal($('checkpoint-restore').disabled,true);
await until(()=>$('workspace-location').textContent==='/grant/docs' && $('file-list').children.length>0);
clickFile('a.txt');
await until(()=>$('file-content').value===files.get('grant/docs/a.txt').content);
await until(()=>$('checkpoint-restore').disabled===false);
$('file-content').value='edited docs';
$('file-save').click();
await until(()=>$('file-diff').textContent==='saved grant/docs/a.txt');
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview saved docs');
assert.equal($('file-content').value,'edited docs');
$('checkpoint-restore').click();
await until(()=>$('file-content').value==='saved docs','restored editor');
const restore=calls.find(call=>call.url.pathname.endsWith('/restore'));
assert.equal(restore.url.pathname,'/api/v1/checkpoints/'+docs.checkpoint_id+'/restore');
assert.equal(restore.body.expected_digest,digest('edited docs'));
assert.equal(files.get('a.txt').content,'current a.txt');
$('file-content').value='edit after restore';
$('file-save').click();
await until(()=>$('file-diff').textContent==='saved grant/docs/a.txt');
assert.equal(calls.filter(call=>call.method==='POST' && call.url.pathname==='/api/v1/files/content').at(-1).body.expected_digest,docs.digest);
""")


@pytest.mark.parametrize("return_to_a", [False, True], ids=["a-to-b", "a-to-b-to-a"])
@pytest.mark.parametrize("failed", [False, True], ids=["success", "failure"])
def test_late_file_read_does_not_replace_new_selection(return_to_a: bool, failed: bool) -> None:
    _run_page("const returnToA=" + json.dumps(return_to_a) + ", failed=" + json.dumps(failed) + ";\n" + r"""
const pending=hold('GET','/api/v1/files/content','a.txt');
clickFile('a.txt'); await until(()=>pending.entered);
await openFile('b.txt');
if(returnToA) await openFile('a.txt');
const before=screen();
pending.release(failed ? {value:{message:'old read failure'},status:404} :
  {value:{...files.get('a.txt'),content:'obsolete A read',digest:digest('obsolete')}});
await settle();
assert.deepEqual(screen(),before);
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview latest '+(returnToA?'A':'B'));
""")


@pytest.mark.parametrize("return_to_a", [False, True], ids=["a-to-b", "a-to-b-to-a"])
@pytest.mark.parametrize("failed", [False, True], ids=["success", "failure"])
def test_late_checkpoint_discovery_is_ignored(failed: bool, return_to_a: bool) -> None:
    _run_page("const failed=" + json.dumps(failed) + ", returnToA=" + json.dumps(return_to_a) + ";\n" + r"""
const pending=hold('GET','/api/v1/checkpoints','a.txt');
await openFile('a.txt'); await until(()=>pending.entered);
assert.match($('checkpoint-state').textContent,/正在加载检查点/);
assert.equal($('checkpoint-restore').disabled,true);
await openFile('b.txt');
if(returnToA) await openFile('a.txt');
const before=screen();
pending.release(failed ? {value:{message:'old discovery failure'},status:500} : {value:{checkpoints:[oldA]}});
await settle();
assert.deepEqual(screen(),before);
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview latest '+(returnToA?'A':'B'));
""")


@pytest.mark.parametrize("operation", ["file-save", "checkpoint-save", "checkpoint-preview", "checkpoint-restore"])
@pytest.mark.parametrize("failed", [False, True], ids=["success", "failure"])
@pytest.mark.parametrize("switch", ["file", "return", "workspace"])
def test_late_file_action_does_not_change_new_editor(operation: str, failed: bool, switch: str) -> None:
    _run_page("const operation=" + json.dumps(operation) + ", failed=" + json.dumps(failed)
              + ", switchTo=" + json.dumps(switch) + ";\n" + r"""
await openFile('a.txt');
const targets={
  'file-save':['POST','/api/v1/files/content'],
  'checkpoint-save':['POST','/api/v1/checkpoints'],
  'checkpoint-preview':['GET','/api/v1/checkpoints/'+latestA.checkpoint_id],
  'checkpoint-restore':['POST','/api/v1/checkpoints/'+latestA.checkpoint_id+'/restore'],
};
const pending=hold(...targets[operation]);
$('file-content').value='A draft';
$(operation).click(); await until(()=>pending.entered,operation+' request');
await openFile('b.txt');
if(switchTo==='return') await openFile('a.txt');
if(switchTo==='workspace') {
  clickWorkspace('docs');
  await until(()=>[...$('file-list').children].some(node=>node.textContent==='a.txt'));
  clickFile('a.txt');
  await until(()=>$('checkpoint-preview').disabled===false);
}
$('file-content').value='new draft';
$('error').textContent='new notice';
const before=screen(), reads=calls.filter(call=>call.url.pathname==='/api/v1/files/content' && call.method==='GET').length;
pending.release(failed ? {value:{message:'old action failure'},status:409} : undefined);
await settle();
assert.deepEqual(screen(),before);
assert.equal(calls.filter(call=>call.url.pathname==='/api/v1/files/content' && call.method==='GET').length,reads);
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview '+({file:'latest B',return:'latest A',workspace:'saved docs'}[switchTo]));
if(switchTo!=='return') {
  const path=switchTo==='workspace' ? 'grant/docs/a.txt' : 'b.txt';
  $('file-save').click();
  await until(()=>$('file-diff').textContent==='saved '+path);
  const saved=calls.filter(call=>call.method==='POST' && call.url.pathname==='/api/v1/files/content').at(-1);
  assert.equal(saved.body.path,path);
  assert.equal(saved.body.content,'new draft');
  assert.equal(saved.body.expected_digest,digest('current '+path));
}
""")


def test_failed_discovery_and_creation_keep_only_confirmed_checkpoint_bindings() -> None:
    _run_page(r"""
const discovery=hold('GET','/api/v1/checkpoints','a.txt');
await openFile('a.txt'); await until(()=>discovery.entered);
discovery.release({value:{message:'list unavailable'},status:503});
await until(()=>$('error').textContent==='list unavailable');
assert.match($('checkpoint-state').textContent,/检查点加载失败/);
assert.equal($('checkpoint-restore').disabled,true);
$('checkpoint-save').click();
await until(()=>$('file-diff').textContent.startsWith('已保存'));
const saved=calls.find(call=>call.url.pathname==='/api/v1/checkpoints' && call.method==='POST').body.checkpoint_id;
const creation=hold('POST','/api/v1/checkpoints');
$('checkpoint-save').click(); await until(()=>creation.entered);
creation.release({value:{message:'creation failed'},status:500});
await until(()=>$('error').textContent==='creation failed');
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview current a.txt');
assert.equal(calls.at(-1).url.pathname,'/api/v1/checkpoints/'+saved);
""")


@pytest.mark.parametrize("failed", [False, True], ids=["success", "failure"])
def test_late_discovery_cannot_replace_a_newly_created_checkpoint(failed: bool) -> None:
    _run_page("const failed=" + json.dumps(failed) + ";\n" + r"""
const discovery=hold('GET','/api/v1/checkpoints','a.txt');
await openFile('a.txt'); await until(()=>discovery.entered);
$('checkpoint-save').click();
await until(()=>$('file-diff').textContent.startsWith('已保存'));
const saved=calls.find(call=>call.url.pathname==='/api/v1/checkpoints' && call.method==='POST').body.checkpoint_id;
const before=screen();
discovery.release(failed ? {value:{message:'old discovery failed'},status:500} : {value:{checkpoints:[oldA,latestA]}});
await settle();
assert.deepEqual(screen(),before);
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview current a.txt');
assert.equal(calls.at(-1).url.pathname,'/api/v1/checkpoints/'+saved);
await openFile('b.txt');
await openFile('a.txt');
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview current a.txt');
assert.equal(calls.at(-1).url.pathname,'/api/v1/checkpoints/'+saved);
""")


def test_restore_readback_and_workspace_listing_cannot_overwrite_new_selection() -> None:
    _run_page(r"""
await openFile('a.txt');
const readback=hold('GET','/api/v1/files/content','a.txt');
$('checkpoint-restore').click(); await until(()=>readback.entered,'restore readback');
await openFile('b.txt');
const before=screen(); readback.release(); await settle();
assert.deepEqual(screen(),before);
const listing=hold('GET','/api/v1/files','grant/docs');
clickWorkspace('docs'); await until(()=>listing.entered);
clickWorkspace('主工作区');
await until(()=>[...$('file-list').children].some(node=>node.textContent==='b.txt'));
await openFile('b.txt');
const primary=screen(); listing.release(); await settle();
assert.deepEqual(screen(),primary);
assert.equal($('workspace-location').textContent,'/workspace');
assert.ok([...$('file-list').children].some(node=>node.textContent==='b.txt'));
""")


def test_workspace_creation_resets_the_existing_file_binding() -> None:
    _run_page(r"""
await openFile('a.txt');
$('workspace-name').value='docs'; $('workspace-path').value='/host/docs';
$('workspace-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
await until(()=>$('workspace-location').textContent==='/grant/docs');
assert.equal($('file-content').value,'');
for(const id of ['file-save','checkpoint-save','checkpoint-preview','checkpoint-restore']) assert.equal($(id).disabled,true);
assert.match($('checkpoint-state').textContent,/请选择文件|请先选择文件/);
""")


def test_discovery_uses_canonical_path_and_last_row_even_for_reused_checkpoint() -> None:
    _run_page(r"""
histories.get('grant/docs/a.txt').push({...docs,checkpoint_id:'e'.repeat(32),digest:digest('unused')},docs);
const canonical=hold('GET','/api/v1/files/content','a.txt');
clickFile('a.txt'); await until(()=>canonical.entered);
canonical.release({value:files.get('grant/docs/a.txt')});
await until(()=>$('checkpoint-preview').disabled===false);
const listing=calls.find(call=>call.url.pathname==='/api/v1/checkpoints');
assert.equal(listing.url.searchParams.get('path'),'grant/docs/a.txt');
assert.equal(listing.url.searchParams.get('workspace'),'docs');
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview saved docs');
$('checkpoint-restore').click();
await until(()=>$('file-content').value==='saved docs');
assert.equal(files.get('a.txt').content,'current a.txt');
$('checkpoint-save').click();
await until(()=>$('file-diff').textContent.startsWith('已保存'));
const saved=calls.filter(call=>call.method==='POST' && call.url.pathname==='/api/v1/checkpoints').at(-1).body;
assert.equal(saved.path,'grant/docs/a.txt');
assert.equal(saved.workspace,'docs');
""")


def test_truncated_editor_cannot_write_but_full_digest_checkpoint_can_restore() -> None:
    _run_page(r"""
const file=files.get('large.txt');
file.content='x'.repeat(40000); file.digest=digest(file.content);
const saved=checkpoint('c','large.txt','y'.repeat(40000));
await openFile('large.txt');
assert.equal($('file-content').value.length,32000);
assert.equal($('file-content').readOnly,true);
assert.equal($('file-save').disabled,true);
assert.equal($('checkpoint-restore').disabled,false);
$('file-save').click();
await $('file-save').onclick();
assert.equal(calls.some(call=>call.method==='POST' && call.url.pathname==='/api/v1/files/content'),false);
const expected=file.digest;
$('checkpoint-restore').click();
await until(()=>$('file-content').value==='y'.repeat(32000));
assert.equal(files.get('large.txt').content,saved.content);
const restore=calls.find(call=>call.url.pathname.endsWith('/restore'));
assert.equal(restore.body.expected_digest,expected);
assert.equal($('file-save').disabled,true);
assert.match($('file-diff').textContent,/文件过大/);
$('checkpoint-save').click();
await until(()=>$('file-diff').textContent.startsWith('已保存'));
assert.ok($('checkpoint-state').textContent.includes(saved.digest.slice(0,12)));
""")


@pytest.mark.parametrize("stage", ["restore", "readback"])
@pytest.mark.parametrize("edit_back", [False, True], ids=["new-text", "edit-and-undo"])
def test_restore_preserves_edits_made_while_waiting(stage: str, edit_back: bool) -> None:
    _run_page("const stage=" + json.dumps(stage) + ", editBack=" + json.dumps(edit_back) + ";\n" + r"""
await openFile('a.txt');
const pending=stage==='restore' ? hold('POST','/api/v1/checkpoints/'+latestA.checkpoint_id+'/restore') :
  hold('GET','/api/v1/files/content','a.txt');
$('checkpoint-restore').click(); await until(()=>pending.entered);
$('file-content').value='new typing during restore';
$('file-content').dispatchEvent(new window.Event('input'));
const draft=editBack ? 'current a.txt' : 'new typing during restore';
if(editBack) { $('file-content').value=draft; $('file-content').dispatchEvent(new window.Event('input')); }
pending.release();
await until(()=>$('checkpoint-restore').disabled===false);
assert.equal($('file-content').value,draft);
$('file-save').click();
await until(()=>$('file-diff').textContent==='saved a.txt');
const saved=calls.filter(call=>call.method==='POST' && call.url.pathname==='/api/v1/files/content').at(-1).body;
assert.equal(saved.expected_digest,latestA.digest);
assert.equal(saved.content,draft);
""")


def test_preview_does_not_adopt_new_disk_digest_and_restore_conflict_preserves_draft() -> None:
    _run_page(r"""
await openFile('a.txt');
$('file-content').value='unsaved draft';
const original=files.get('a.txt').digest;
files.get('a.txt').content='external change'; files.get('a.txt').digest=digest('external change');
$('checkpoint-preview').click();
await until(()=>$('file-diff').textContent==='preview latest A');
assert.equal($('file-content').value,'unsaved draft');
const pending=hold('POST','/api/v1/checkpoints/'+latestA.checkpoint_id+'/restore');
$('checkpoint-restore').click(); await until(()=>pending.entered);
assert.equal(calls.at(-1).body.expected_digest,original);
pending.release({value:{message:'file_conflict'},status:409});
await until(()=>$('error').textContent==='file_conflict');
assert.equal($('file-content').value,'unsaved draft');
assert.equal(files.get('a.txt').content,'external change');
assert.equal($('checkpoint-restore').disabled,false);
""")


@pytest.mark.parametrize("stage", ["preview", "restore", "readback"])
def test_mismatched_response_path_cannot_replace_editor_or_digest(stage: str) -> None:
    _run_page("const stage=" + json.dumps(stage) + ";\n" + r"""
await openFile('a.txt');
const target=stage==='readback' ? ['GET','/api/v1/files/content','a.txt'] :
  [stage==='restore' ? 'POST' : 'GET','/api/v1/checkpoints/'+latestA.checkpoint_id+(stage==='restore'?'/restore':'')];
const pending=hold(...target);
$('file-content').value='keep my draft';
$(stage==='preview' ? 'checkpoint-preview' : 'checkpoint-restore').click();
await until(()=>pending.entered);
pending.release({value:stage==='preview' ? latestB : {...files.get('b.txt'),diff:'wrong file'}});
await until(()=>$('error').textContent.includes('与当前文件不一致'));
assert.equal($('file-content').value,'keep my draft');
$('file-save').click();
await until(()=>$('file-diff').textContent==='saved a.txt');
assert.equal(files.get('a.txt').content,'keep my draft');
""")
