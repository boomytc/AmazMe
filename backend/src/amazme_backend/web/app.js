import {validate} from "/contract.js";
const $ = id => document.getElementById(id);
let session = null, socket = null, generation = 0, pending = null, rows = [], cursor = 0n;
const drafts = new Map();
try { pending = JSON.parse(sessionStorage.getItem("pending") || "null"); } catch { sessionStorage.removeItem("pending"); }
function savePending(value){pending=value;if(value)sessionStorage.setItem("pending",JSON.stringify(value));else sessionStorage.removeItem("pending");}
class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}
const labels = {queued:"等待执行",running:"执行中",cancelling:"正在清理",succeeded:"已完成",cancelled:"已取消",interrupted:"运行中断",failed:"失败",unknown:"结果未知，未自动重试"};
const states = {ready:"可执行",recovering:"恢复中",blocked:"等待清理",stopping:"正在停止"};
function toolText(text){
  try {
    const item=JSON.parse(text);
    if(item.name){const args=JSON.parse(item.arguments);return item.name==="shell"?`运行命令\n${args.command}`:item.name==="read_file"?`读取文件：${args.path}`:`写入文件：${args.path}`;}
    return `退出码 ${item.exit_code}${item.truncated?"（输出已截断）":""}\n${item.stdout||""}${item.stderr||""}`;
  }catch{return text;}
}
async function api(path, method="GET", body) {
  const response = await fetch(path,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
  const value = await response.json();
  if(!response.ok) throw new ApiError(value.message || value.code || `HTTP ${response.status}`,response.status);
  return value;
}
function showError(error){$("error").textContent=error.message || String(error);}
function render(){
  $("conversation").replaceChildren(...rows.map(row=>{
    const article=document.createElement("article");article.dataset.requestId=row.request_id;
    for(const [cls,text] of [["question",row.text],["answer",row.answer],["status",labels[row.status]+(row.error?` · ${row.error}`:"")]]){
      const node=document.createElement("div");node.className=cls;node.textContent=text;article.append(node);
    }return article;
  }));
  $("cancel").disabled=!rows.some(row=>["queued","running","cancelling"].includes(row.status));
}
async function refresh(target, binding){
  const value=await api(`/api/v1/sessions/${target}/snapshot`);
  if(binding!==generation)return;
  applySnapshot(value);
}
function applySnapshot(value){
  rows=value.requests;cursor=BigInt(value.seq);$("state").textContent=states[value.state];
  $("tools").textContent=value.events.filter(e=>e.kind==="tool").map(e=>toolText(e.text)).join("\n\n");render();
}
async function select(id){
  if(session)drafts.set(session,$("prompt").value);
  session=id;const binding=++generation;if(socket)socket.close();
  rows=[];render();$("tools").textContent="";$("connection").textContent="正在连接";
  $("prompt").value=drafts.get(id)??(pending?.target===id?pending.text:"");
  try{await refresh(id,binding);}catch(error){
    if(binding===generation){$("connection").textContent="正在重连";setTimeout(()=>{if(binding===generation)void select(id).catch(showError);},1000);}
    return;
  }
  if(binding!==generation)return;
  const ws=new WebSocket(`${location.origin.replace("http:","ws:")}/api/v1/events/${id}`);socket=ws;
  ws.onopen=()=>{if(binding===generation)$("connection").textContent="已连接";};
  ws.onmessage=event=>{
    if(binding!==generation)return;
    const value=JSON.parse(event.data);
    if(!validate(value)){showError(new Error("事件协议不匹配，请重新连接"));ws.close();return;}
    if(value.snapshot){applySnapshot(value.snapshot);return;}
    for(const item of value.events){
      const seq=BigInt(item.seq);if(seq<=cursor)continue;
      if(seq!==cursor+1n){void select(id).catch(showError);return;}cursor=seq;
      let row=rows.find(r=>r.request_id===item.request_id);
      if(item.kind==="accepted"&&!row){row={request_id:item.request_id,text:item.text,answer:"",status:"queued",error:""};rows.push(row);}
      if(row&&item.kind==="status")row.status=item.text;
      if(row&&item.kind==="preview")row.answer=item.text;
      if(item.kind==="cleanup"){$("state").textContent=states.blocked;if(row)row.error=item.text;}
      if(item.kind==="tool")$("tools").textContent=($("tools").textContent+"\n\n"+toolText(item.text)).slice(-32000);
      if(item.kind==="status"&&["failed","interrupted","unknown"].includes(item.text)){void select(id).catch(showError);return;}
    }const recent=rows.slice(-20);rows=rows.filter(row=>["running","cancelling"].includes(row.status)||recent.includes(row));render();
  };
  ws.onclose=()=>{if(binding===generation){$("connection").textContent="正在重连";setTimeout(()=>{if(binding===generation)void select(id).catch(showError);},1000);}};
}
async function load(){
  await api("/api/v1/bootstrap");$("login").hidden=true;
  const value=await api("/api/v1/sessions");
  $("sessions").replaceChildren(...value.sessions.map(s=>{const b=document.createElement("button");b.textContent=s.title;b.onclick=()=>select(s.session_id).catch(showError);return b;}));
  if(!session&&value.sessions.length)await select(value.sessions.some(s=>s.session_id===pending?.target)?pending.target:value.sessions[0].session_id);
}
$("login").onsubmit=async event=>{event.preventDefault();try{await api("/auth","POST",{token:$("token").value});$("token").value="";await load();}catch(error){showError(error);}};
$("create").onclick=async()=>{$("create").disabled=true;try{const s=await api("/api/v1/sessions","POST",{title:"工作区任务"});await load();await select(s.session_id);}catch(error){showError(error);}finally{$("create").disabled=false;}};
$("composer").onsubmit=async event=>{
  event.preventDefault();if(!session){showError(new Error("请先创建会话"));return;}
  const target=session;
  if(!pending){if(!$("prompt").value.trim()){showError(new Error("请输入任务"));return;}savePending({target,request_id:crypto.randomUUID(),text:$("prompt").value});}
  if(pending.target!==target){showError(new Error("上一请求结果待确认，请切回原会话重试"));return;}
  $("send").disabled=true;$("error").textContent="";
  const submitted=pending;
  try{
    await api(`/api/v1/sessions/${target}/submissions`,"POST",{request_id:submitted.request_id,text:submitted.text});savePending(null);
    if(session===target&&$("prompt").value===submitted.text)$("prompt").value="";
    if(drafts.get(target)===submitted.text)drafts.delete(target);
  }catch(error){
    if(error instanceof ApiError&&error.status>=400&&error.status<500){savePending(null);showError(error);}
    else showError(new Error(`${error.message}；再次发送会沿用原请求 ID`));
  }
  finally{$("send").disabled=false;}
};
$("cancel").onclick=async()=>{const row=rows.find(r=>["running","cancelling","queued"].includes(r.status));if(row)try{await api(`/api/v1/sessions/${session}/requests/${row.request_id}/cancel`,"POST",{});}catch(error){showError(error);}};
load().catch(()=>{$("login").hidden=false;});
