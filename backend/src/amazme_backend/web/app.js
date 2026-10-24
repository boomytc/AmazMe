import {validate} from "/contract.js";

const bootRecord = globalThis.__AMAZME_BOOT__;
if (typeof document !== "undefined" && bootRecord && bootRecord.app && bootRecord.app.name && bootRecord.app.version) {
  document.title = `${bootRecord.app.name} ${bootRecord.app.version}`;
  document.documentElement.dataset.protocol = String(bootRecord.protocol || "");
  document.documentElement.dataset.host = bootRecord.server && bootRecord.server.id ? String(bootRecord.server.id) : "";
}

const terminal = new Set(["succeeded", "cancelled", "interrupted", "failed", "unknown"]);
const labels = {queued:"等待执行",running:"执行中",waiting_approval:"等待审批",waiting_children:"等待子任务",waiting_time:"等待计划时间",waiting_host:"等待恢复",cancelling:"正在清理",cleaning:"正在清理",blocked:"等待清理",succeeded:"已完成",cancelled:"已取消",interrupted:"运行中断",failed:"失败",unknown:"结果未知，未自动重试"};
const states = {ready:"可执行",recovering:"恢复中",blocked:"等待清理",stopping:"正在停止",frozen:"更新冻结"};
const decimal = value => typeof value === "string" && /^(0|[1-9][0-9]{0,17})$/.test(value);
export function seq(value) {
  if (!decimal(value)) throw new Error("无效的事务序号");
  return BigInt(value);
}
function upsert(items, item, key) {
  const index = items.findIndex(old => old[key] === item[key]);
  if (index < 0) items.push(item); else items[index] = item;
}
function previewMatches(preview, receipt) {
  return receipt && !receipt.decision && !terminal.has(receipt.status) && preview.run_id === receipt.run_id && preview.generation === receipt.generation;
}
function resolutionCalls(events) {
  const values = {};
  for (const event of events) if (event.kind === "effect") {
    const item = JSON.parse(event.text);
    if (item.resolution_id) values[item.resolution_id] = item.call_id;
  }
  return values;
}
function pendingCount(model) {
  const ids = new Set(model.requests.filter(row => !terminal.has(row.status)).map(row => row.request_id));
  for (const item of model.effects) if (!item.reconciled || !item.resource_clean) ids.add(item.request_id);
  return ids.size + Object.keys(model.resolutionCalls || {}).length;
}
function cleanModel(model) {
  const held = new Set(model.effects.filter(effect => !effect.reconciled || !effect.resource_clean).map(effect => effect.request_id));
  const settled = model.requests.filter(row => terminal.has(row.status)).sort((left, right) => {
    const order = seq(left.revision) - seq(right.revision);
    return order < 0n ? -1 : order > 0n ? 1 : 0;
  });
  const recent = new Set(settled.filter(row => row.kind === "root" && row.text).slice(-20).map(row => row.request_id));
  // Empty input identifies cancel-before-acceptance tombstones; they have their own history bound.
  for (const row of settled.filter(row => row.kind === "root" && !row.text).slice(-20)) recent.add(row.request_id);
  let childBytes = 0;
  for (const row of settled.filter(row => row.kind !== "root").slice(-20).reverse()) {
    if (held.has(row.request_id)) continue;
    const size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (childBytes + size > 512 * 1024) continue;
    childBytes += size;
    recent.add(row.request_id);
  }
  model.requests = model.requests.filter(row => !terminal.has(row.status) || recent.has(row.request_id) || held.has(row.request_id));
  const ids = new Set(model.requests.map(row => row.request_id));
  model.approvals = model.approvals.filter(item => ids.has(item.request_id) || item.state === "pending");
  model.previews = model.previews.filter(item => previewMatches(item, model.requests.find(row => row.request_id === item.request_id)));
  model.events = model.events.slice(-200);
  return model;
}

// Validate the entire frame against a copy before advancing either the view or its ACK watermark.
export function applyFrame(previous, frame, binding) {
  if (!validate(frame) || frame.binding_id !== binding.attachment_id || frame.build_id !== binding.build_id || !frame.stream_id)
    throw new Error("事件绑定或协议不匹配");
  if (frame.snapshot) {
    const snapshot = frame.snapshot;
    if (frame.batches.length || snapshot.session_id !== binding.session_id || snapshot.stream_id !== frame.stream_id)
      throw new Error("快照身份不匹配");
    seq(snapshot.seq);
    if (previous?.stream_id === snapshot.stream_id && seq(snapshot.seq) < seq(previous.seq)) throw new Error("快照水位倒退");
    for (const preview of snapshot.previews) seq(preview.preview_seq);
    // A snapshot includes every pending obligation; only incremental history is trimmed.
    return {...structuredClone(snapshot), resolutionCalls:resolutionCalls(snapshot.events)};
  }
  if (!previous || frame.resync || frame.stream_id !== previous.stream_id || !frame.batches.length || frame.batches.length > 16)
    throw new Error("需要重新同步快照");
  const model = structuredClone(previous);
  let cursor = seq(model.seq), last = null;
  for (const batch of frame.batches) {
    const number = seq(batch.seq);
    if (batch.stream_id !== model.stream_id || seq(batch.revision) !== number || seq(batch.base_revision) !== number - 1n ||
        !batch.events.length || batch.events.some(event => event.seq !== batch.seq) || (last !== null && number !== last + 1n))
      throw new Error("事务批次不完整或顺序错误");
    last = number;
    if (number <= cursor) continue;
    if (number !== cursor + 1n || seq(batch.base_revision) !== seq(model.seq)) throw new Error("事务存在缺口，正在重新同步");
    for (const event of batch.events) {
      if (event.receipt) {
        if (event.receipt.request_id !== event.request_id || event.receipt.revision !== batch.revision) throw new Error("回执与事务不匹配");
        upsert(model.requests, event.receipt, "request_id");
      }
      if (event.approval) upsert(model.approvals, event.approval, "approval_id");
      if (event.preview) {
        const preview = event.preview;
        seq(preview.preview_seq);
        const receipt = model.requests.find(row => row.request_id === preview.request_id);
        const old = model.previews.find(item => item.request_id === preview.request_id);
        if (previewMatches(preview, receipt) && (!old || old.generation !== preview.generation || old.run_id !== preview.run_id || seq(preview.preview_seq) > seq(old.preview_seq)))
          upsert(model.previews, preview, "request_id");
      }
      if (event.kind === "message") model.previews = model.previews.filter(item => item.request_id !== event.request_id);
      if (event.kind === "effect") {
        const effect = JSON.parse(event.text);
        if (typeof effect.resource_clean === "boolean" && effect.session_id === binding.session_id) {
          upsert(model.effects, effect, "call_id");
          if (effect.reconciled) for (const [id, call] of Object.entries(model.resolutionCalls)) if (call === effect.call_id) delete model.resolutionCalls[id];
        }
        if (effect.resolution_id) model.resolutionCalls[effect.resolution_id] = effect.call_id;
      }
      if (event.kind === "cleanup") {
        try {
          const proof = JSON.parse(event.text);
          if (proof.state === "blocked") model.state = "blocked";
          if (proof.state === "clean" && proof.proof_id && proof.session_id === binding.session_id)
            for (const effect of model.effects) if (effect.request_id === event.request_id) effect.resource_clean = true;
        } catch { /* Some cleanup records are textual diagnostics, retained below. */ }
      }
      if (event.kind === "status" && event.text.startsWith("blocked:")) model.state = "blocked";
      if (event.kind === "status" && event.text === "stopping") model.state = "stopping";
      if (event.kind === "freeze") model.state = event.text.startsWith("thawed:") ? "ready" : "frozen";
      if (["tool", "cleanup", "effect", "children"].includes(event.kind)) model.events.push(event);
    }
    model.seq = batch.seq;
    cursor = number;
  }
  model.pending = pendingCount(model);
  const wakes = model.requests.filter(row => row.status === "waiting_time" && row.not_before_ms > 0).map(row => row.not_before_ms);
  model.next_wake_ms = wakes.length ? Math.min(...wakes) : 0;
  return cleanModel(model);
}

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
const bindingErrors = new Set(["stale_client_binding", "stale_host_epoch", "build_mismatch", "attachment_expired"]);
export function definitive(error) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401,408,429].includes(error.status) && !bindingErrors.has(error.code);
}

if (typeof document !== "undefined") startClient();
function startClient() {
  const $ = id => document.getElementById(id);
  let current = null, generation = 0, identity = null, selected = null, connecting = false, health = null;
  let pending = null, actions = {}, reconnectTimer = null;
  const drafts = new Map();
  const evidenceDrafts = new Map();
  let effectsSignature = "";
  const running = new Set();
  try { pending = JSON.parse(sessionStorage.getItem("pending") || "null"); actions = JSON.parse(sessionStorage.getItem("actions") || "{}"); }
  catch { sessionStorage.removeItem("pending"); sessionStorage.removeItem("actions"); }
  function savePending(value) { pending = value; if (value) sessionStorage.setItem("pending", JSON.stringify(value)); else sessionStorage.removeItem("pending"); }
  function saveActions() { sessionStorage.setItem("actions", JSON.stringify(actions)); }
  const archived = new Map();
  const sessionWorkspaces = new Map();
  const owns = connection => current === connection && connection.generation === generation;
  const archivedNow = () => Boolean(archived.get(selected));
  const writable = () => Boolean(current?.ready && health?.state === "ready" && current.model?.state === "ready" && !archivedNow());
  function error(value) { $("error").textContent = value.message || String(value); }
  async function api(path, method = "GET", body, connection = null, fence = identity) {
    const headers = {};
    if (method !== "GET" && path !== "/auth") {
      if (!fence) throw new Error("请重新连接");
      headers["x-amazme-build"] = fence.build_id;
      headers["x-amazme-epoch"] = String(fence.host_epoch);
      if (connection?.attachment) headers["x-amazme-attachment"] = connection.attachment.attachment_id;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {method, headers, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(30000)});
    const value = await response.json();
    if (!response.ok) throw new ApiError(value.message || value.code || `HTTP ${response.status}`, response.status, value.code);
    return value;
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, handler, disabled = false) {
    const node = element("button", text); node.type = "button"; node.disabled = disabled; node.onclick = handler; return node;
  }
  function toolText(text) {
    try {
      const item = JSON.parse(text);
      if (item.call) return `${item.state || item.phase || "工具"} · ${item.call.name}\n${item.call.arguments}\n${item.result || ""}`;
      if (item.name) return `${item.name}\n${item.arguments}`;
      return JSON.stringify(item, null, 2);
    } catch { return text; }
  }
  function controls() {
    $("create").disabled = connecting || !identity || health?.state !== "ready";
    const root = current?.model?.requests.find(row => row.kind === "root" && !terminal.has(row.status));
    $("send").disabled = !writable() || running.has(`submit:${selected}`) || Boolean(pending && pending.target !== selected);
    $("send").textContent = pending?.target === selected ? "重试原请求" : "发送";
    $("prompt").readOnly = pending?.target === selected;
    $("mode").disabled = Boolean(pending?.target === selected) || !writable();
    $("cancel").disabled = !root || !current?.ready || health?.state === "frozen" || current?.model?.state === "frozen";
    $("archive").disabled = !current?.ready || health?.state !== "ready" || current?.model?.state === "frozen";
    $("archive").textContent = archivedNow() ? "恢复" : "归档";
  }
  function renderHealth() {
    const model = current?.model;
    $("state").textContent = states[model?.state] || states[health?.state] || "";
    const frozen = health?.state === "frozen" || model?.state === "frozen";
    $("recovery").hidden = !frozen && (!health || health.state === "ready") && !["recovering", "blocked", "stopping"].includes(model?.state);
    $("recovery").textContent = frozen ? "更新保持冻结。等待桌面宿主完成健康校验与激活；普通网页无法解除冻结。" :
      `后端${states[health?.state === "ready" ? model?.state : health?.state] || "正在恢复"}；保留任务与原请求 ID，恢复后再重试。`;
    $("pending-count").textContent = model ? `待处理 ${model.pending}${model.next_wake_ms ? ` · 下次唤醒 ${new Date(model.next_wake_ms).toLocaleString()}` : ""}` : "";
    controls();
  }
  async function compactAt(connection, requestId) {
    if (!owns(connection) || !writable() || !identity) return;
    const key = `compact:${connection.session}:${requestId}`;
    if (running.has(key)) return;
    running.add(key); controls();
    const storedKey = `compact-id:${identity.profile_id}:${connection.session}:${requestId}`;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(storedKey) || "null"); }
    catch { pending = null; }
    if (!pending) {
      pending = {compaction_id: crypto.randomUUID(), through_request_id: requestId};
      sessionStorage.setItem(storedKey, JSON.stringify(pending));
    }
    try {
      const value = await api(`/api/v1/sessions/${connection.session}/compactions`, "POST",
        {compaction_id: pending.compaction_id, through_request_id: pending.through_request_id}, connection, connection.identity);
      sessionStorage.removeItem(storedKey);
      if (!owns(connection) || !connection.model) return;
      connection.model = {...connection.model, compaction: value.summary};
      render();
    } catch (failure) {
      if (owns(connection)) {
        error(failure.code === "compaction_pending"
          ? new Error("上次压缩结果未知，未自动重发；请再查同一次。")
          : failure);
      }
    } finally {
      running.delete(key);
      if (owns(connection)) controls();
    }
  }
  async function branchAt(connection, requestId) {
    if (!owns(connection) || !writable()) return;
    const key = `branch:${connection.session}:${requestId}`;
    if (running.has(key)) return;
    running.add(key); controls();
    try {
      const value = await api(`/api/v1/sessions/${connection.session}/branches`, "POST", {request_id: requestId}, connection, connection.identity);
      if (!owns(connection)) return;
      await load();
      await select(value.session_id);
    } catch (failure) {
      if (owns(connection)) error(failure);
    } finally {
      running.delete(key);
      if (owns(connection)) controls();
    }
  }
  function render() {
    const connection = current, model = connection?.model;
    $("conversation").replaceChildren(...(model?.requests || []).map(row => {
      const article = element("article"); article.dataset.requestId = row.request_id;
      const preview = model.previews.find(item => item.request_id === row.request_id && previewMatches(item, row));
      const text = row.answer || preview?.text || "";
      const attached = row.image_count ? ` · ${row.image_count} 张图片` : "";
      article.append(element("div", `${row.kind === "child" ? "子任务 · " : row.kind === "steer" ? "引导 · " : ""}${row.text}${attached}`, "question"),
        element("div", text, "answer"), element("div", `${labels[row.status] || row.status}${row.error ? ` · ${row.error}` : ""}${preview && !row.answer ? " · 临时预览" : ""}`, "status"));
      if (row.children.length) article.append(element("div", `子任务：${row.children.map(id => {
        const child = model.requests.find(item => item.request_id === id); return `${id.slice(0,8)}（${labels[child?.status] || "记录已归档"}）`;
      }).join("、")}`, "children"));
      if (row.kind === "root" && row.status === "succeeded") {
        article.append(button("从此处分支", () => void branchAt(connection, row.request_id), !writable()));
        article.append(button("压缩上下文", () => void compactAt(connection, row.request_id), !writable()));
      }
      return article;
    }));
    const note = $("compaction");
    note.hidden = !model?.compaction;
    note.textContent = model?.compaction ? `上下文已压缩：${model.compaction}` : "";
    $("tools").textContent = (model?.events || []).map(event => toolText(event.text)).join("\n\n").slice(-64000);
    $("approvals").replaceChildren(...(model?.approvals || []).filter(item => item.state === "pending").map(item => {
      const card = element("article"); card.dataset.approvalId = item.approval_id;
      card.append(element("strong", `审批 · ${item.call.name}`), element("pre", item.call.arguments));
      for (const approve of [true, false]) card.append(button(approve ? "批准" : "拒绝", () => {
        const key = `${selected}:approval:${item.approval_id}`;
        runAction(key, connection, "approvals", {decision_id:crypto.randomUUID(), approval_id:item.approval_id, expected_revision:item.revision, proposal_digest:item.proposal_digest, approve});
      }, !writable() || item.build_id !== identity?.build_id || Boolean(actions[`${selected}:approval:${item.approval_id}`])));
      return card;
    }));
    const effectState = JSON.stringify([connection?.session, model?.effects, connection?.ready, health?.state, model?.state, Object.keys(actions)]);
    if (effectState !== effectsSignature) {
      effectsSignature = effectState;
      $("effects").replaceChildren(...(model?.effects || []).filter(item => !item.reconciled).map(item => {
      const card = element("article"); card.dataset.callId = item.call_id;
      card.append(element("strong", "副作用结果未知"), element("p", `${item.call_id} · ${item.reason}`),
        element("p", item.resource_clean ? "资源已清理。请检查工作区，以证据确认是否已产生效果。" : "资源尚未确认清理，暂不能解除冲突阻塞。"));
      const saved = evidenceDrafts.get(`${connection.session}:${item.call_id}`) || {evidence:"", outcome:"applied"};
      const input = element("textarea"); input.value = saved.evidence; input.rows = 2; input.maxLength = 4000; input.setAttribute("aria-label", "核对证据"); input.placeholder = "记录检查的文件、内容或其他可复核证据";
      const outcome = element("select"); outcome.setAttribute("aria-label", "核对结论");
      for (const [value, label] of [["applied", "效果已发生"], ["not_applied", "效果未发生"]]) { const option = element("option", label); option.value = value; outcome.append(option); }
      outcome.value = saved.outcome;
      const saveEvidence = () => evidenceDrafts.set(`${connection.session}:${item.call_id}`, {evidence:input.value, outcome:outcome.value});
      input.oninput = saveEvidence; outcome.onchange = saveEvidence;
      card.append(input, outcome, button("提交核对证据", () => {
        if (!input.value.trim()) { error(new Error("请填写核对证据")); return; }
        runAction(`${selected}:effect:${item.call_id}`, connection, "effects/resolve", {resolution_id:crypto.randomUUID(), call_id:item.call_id, outcome:outcome.value, evidence:input.value.trim()});
      }, !item.resource_clean || !connection.ready || health?.state === "frozen" || model?.state === "frozen" || Boolean(actions[`${selected}:effect:${item.call_id}`])));
      return card;
    }));
    }
    $("action-retries").replaceChildren(...Object.entries(actions).filter(([,item]) => item.target === selected).map(([key,item]) => button(`重试${item.path === "approvals" ? "审批" : item.path === "effects/resolve" ? "证据核对" : "取消"}（原 ID）`, () => runAction(key, current), !current?.ready || health?.state === "frozen" || current?.model?.state === "frozen" || (item.path === "approvals" && !writable()) || running.has(key))));
    renderHealth();
  }
  async function detach(connection) {
    if (!connection?.attachment) return;
    try { await api(`/api/v1/sessions/${connection.session}/attachments/${connection.attachment.attachment_id}`, "DELETE", undefined, connection, connection.identity); }
    catch { /* Host expiry also retires abandoned attachments. */ }
  }
  function retire() {
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const old = current;
    current = null;
    if (old) { clearTimeout(old.healthTimer); clearTimeout(old.helloTimer); old.ws?.close(); void detach(old); }
  }
  function reconnect(connection, fresh = false) {
    if (!owns(connection) || reconnectTimer) return;
    connection.ready = false;
    if (fresh) connection.model = null;
    connection.ws?.close();
    $("connection").textContent = "正在重连"; renderHealth();
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (owns(connection)) void select(connection.session, !fresh); }, 1000);
  }
  async function pollHealth(connection) {
    try {
      const value = await api("/api/v1/health");
      if (!owns(connection)) return;
      if (value.identity.build_id !== connection.identity.build_id || value.identity.host_epoch !== connection.identity.host_epoch) { reconnect(connection, true); return; }
      health = value; render();
    } catch (failure) { if (owns(connection)) { error(failure); reconnect(connection); } }
    finally { if (owns(connection) && !reconnectTimer) connection.healthTimer = setTimeout(() => void pollHealth(connection), 3000); }
  }
  async function refresh(connection) {
    if (connection.refreshing || !owns(connection)) return;
    connection.refreshing = true;
    try {
      const value = await api(`/api/v1/sessions/${connection.session}/snapshot`);
      if (!owns(connection) || !connection.ready) return;
      if (value.stream_id !== connection.model.stream_id) { reconnect(connection, true); return; }
      if (seq(value.seq) >= seq(connection.model.seq)) {
        connection.model = applyFrame(connection.model, {snapshot:value, batches:[], stream_id:value.stream_id, binding_id:connection.attachment.attachment_id, build_id:connection.identity.build_id, resync:"refresh"}, connection.attachment);
        render();
      }
    } catch (failure) { if (owns(connection)) error(failure); }
    finally { connection.refreshing = false; }
  }
  function namedTarget() {
    const params = new URLSearchParams(location.search);
    return {
      host: (params.get("host") || "").trim(),
      session: (params.get("session") || "").trim(),
      workspace: (params.get("workspace") || "").trim(),
      fresh: params.get("new") === "1",
    };
  }
  function rememberWindow(sessionId, workspace, host) {
    const url = new URL(location.href);
    url.searchParams.set("host", host);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("workspace", workspace);
    url.searchParams.delete("new");
    if (url.href !== location.href) history.replaceState(null, "", url.href);
  }
  async function bindWindow(sessions) {
    const target = namedTarget();
    if (!target.host || !target.workspace || (!target.session && !target.fresh)) {
      throw new Error("请在地址中写明宿主、会话和工作区");
    }
    if (!identity || identity.profile_id !== target.host) throw new Error("链接的宿主不一致");
    if (target.fresh && !target.session) {
      const created = await api("/api/v1/sessions", "POST", {title:"窗口任务", workspace: target.workspace});
      const bound = created.workspace || target.workspace;
      if (bound !== target.workspace) throw new Error("新建会话的工作区不一致");
      rememberWindow(created.session_id, bound, target.host);
      if (namedTarget().fresh || namedTarget().session !== created.session_id || namedTarget().host !== target.host) {
        throw new Error("窗口地址没有写上新会话");
      }
      await load();
      return;
    }
    const match = sessions.find(item => item.session_id === target.session);
    if (!match) throw new Error("链接的会话不存在");
    const workspace = match.workspace || "primary";
    if (target.workspace !== workspace) throw new Error("链接的工作区与会话不一致");
    rememberWindow(match.session_id, workspace, target.host);
    if (selected !== match.session_id) await select(match.session_id);
  }
  async function showSessionWorkspace(name) {
    const node = $("session-workspace");
    try {
      const listed = await api("/api/v1/workspaces");
      const match = listed.workspaces.find(item => item.name === name);
      node.textContent = match?.host_path || name || "本机工作区";
    } catch {
      node.textContent = name || "本机工作区";
    }
  }
  async function select(id, resume = false) {
    const workspace = sessionWorkspaces.get(id) || namedTarget().workspace;
    const host = identity?.profile_id || "";
    if (!host || !workspace) throw new Error("请在地址中写明宿主、会话和工作区");
    const named = namedTarget();
    if (named.host && named.host !== host) throw new Error("链接的宿主不一致");
    if (named.workspace && named.workspace !== workspace) throw new Error("链接的工作区与会话不一致");
    rememberWindow(id, workspace, host);
    if (selected) drafts.set(selected, $("prompt").value);
    const cached = resume && current?.session === id ? current.model : null;
    if (selected !== id) {
      workflowId = ""; workflowView = null;
      webPolicy = null;
      $("web-state").textContent = "";
      $("web-enabled").checked = false;
      $("computer-state").textContent = "";
      $("computer-enabled").checked = false;
    }
    retire(); selected = id; const binding = ++generation;
    await showSessionWorkspace(workspace);
    const connection = {generation:binding, session:id, ready:false, model:cached, ws:null, attachment:null};
    current = connection; connecting = true;
    $("prompt").value = pending?.target === id ? pending.text : (drafts.get(id) || "");
    $("connection").textContent = resume ? "正在重连" : "正在连接";
    render();
    try {
      const boot = await api("/api/v1/bootstrap");
      if (!owns(connection)) return;
      if (identity && identity.build_id !== boot.build_id) {
        $("connection").textContent = "版本已更新，请刷新页面";
        error(new Error("后端构建已更换；刷新页面以载入匹配的客户端，原请求仍保留。")); return;
      }
      identity = boot; connection.identity = boot;
      health = {state:boot.state};
      connection.attachment = await api(`/api/v1/sessions/${id}/attachments`, "POST", {}, null, boot);
      if (!owns(connection)) { void detach(connection); return; }
      const attachment = connection.attachment;
      if (attachment.session_id !== id || attachment.build_id !== boot.build_id || attachment.host_epoch !== boot.host_epoch) throw new Error("会话绑定不匹配");
      if ($("web").open) void loadWebPolicy().catch(error);
      if ($("terminal").open) void loadTerminals().catch(error);
      if ($("mcp").open) void loadMcp().catch(error);
      const url = new URL(`/api/v1/events/${id}`, location.origin); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url); connection.ws = ws;
      connection.helloTimer = setTimeout(() => reconnect(connection, true), 40000);
      ws.onopen = () => {
        if (!owns(connection)) { ws.close(); return; }
        ws.send(JSON.stringify({kind:"hello", binding_id:attachment.attachment_id, build_id:boot.build_id, stream_id:cached?.stream_id || "", after:cached?.seq || "0"}));
      };
      ws.onmessage = event => {
        if (!owns(connection) || connection.ws !== ws || reconnectTimer) return;
        try {
          if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 33 * 1024 * 1024) throw new Error("事件帧超过限制");
          const value = JSON.parse(event.data);
          connection.model = applyFrame(connection.model, value, attachment);
          connection.ready = true; clearTimeout(connection.helloTimer);
          render();
          // ACK the delivered watermark, never an HTTP snapshot that raced ahead of this socket.
          const watermark = value.snapshot?.seq || value.batches.at(-1).seq;
          ws.send(JSON.stringify({kind:"ack", binding_id:attachment.attachment_id, stream_id:value.stream_id, seq:watermark}));
          $("connection").textContent = "已连接";
          if (value.batches.some(batch => batch.events.some(item => ["cleanup","effect","freeze"].includes(item.kind)))) void refresh(connection);
        } catch (failure) { error(failure); reconnect(connection, true); }
      };
      ws.onclose = () => reconnect(connection);
      ws.onerror = () => reconnect(connection);
      void pollHealth(connection);
    } catch (failure) { if (owns(connection)) { error(failure); reconnect(connection); } }
    finally { if (owns(connection)) { connecting = false; controls(); } }
  }
  async function loadModels() {
    const catalog = await api("/api/v1/models");
    const select = $("model-choice");
    const endpoint = $("model-endpoint");
    select.replaceChildren(...catalog.models.map(item => {
      const option = document.createElement("option");
      option.value = `${item.provider}\n${item.model}`;
      option.textContent = item.label;
      option.dataset.endpoint = item.endpoint_editable ? "1" : "";
      return option;
    }));
    const current = catalog.current;
    const key = `${current.provider}\n${current.model}`;
    if (![...select.options].some(option => option.value === key)) {
      const custom = document.createElement("option");
      custom.value = key;
      custom.textContent = current.model;
      custom.dataset.endpoint = current.provider === "deepseek" ? "1" : "";
      select.append(custom);
    }
    select.value = key;
    endpoint.value = current.base_url;
    endpoint.disabled = current.provider !== "deepseek";
    $("model-proxy").value = current.proxy || "";
    $("model-headers").value = Object.entries(current.headers || {}).map(([name, value]) => `${name}: ${value}`).join("\n");
    select.onchange = () => {
      const editable = select.value.split("\n")[0] === "deepseek";
      endpoint.disabled = !editable;
      if (!editable) endpoint.value = "";
    };
    $("model-form").dataset.maxTokens = String(current.max_tokens);
    $("model-form").dataset.credentialRevision = String(current.credential_revision || 0);
    $("model-key-state").textContent = current.key_configured ? "密钥已配置" : "密钥未配置";
    $("model-key").value = "";
  }
  async function load() {
    identity = await api("/api/v1/bootstrap"); health = {state:identity.state}; $("login").hidden = true;
    await loadModels();
    const value = await api("/api/v1/sessions");
    archived.clear();
    sessionWorkspaces.clear();
    for (const item of value.sessions) {
      archived.set(item.session_id, Boolean(item.archived));
      sessionWorkspaces.set(item.session_id, item.workspace || "primary");
    }
    $("sessions").replaceChildren(...value.sessions.map(item => button(item.archived ? `${item.title}（已归档）` : item.title, () => void select(item.session_id))));
    try { await bindWindow(value.sessions); } catch (failure) { error(failure); }
    renderHealth();
  }
  async function runAction(key, connection, path, body) {
    if (!owns(connection) || !connection.ready || health?.state === "frozen" || connection.model?.state === "frozen" || running.has(key)) return;
    if ((path || actions[key]?.path) === "approvals" && !writable()) return;
    if (!actions[key] && Object.keys(actions).length >= 128) { error(new Error("待确认操作已达上限，请先重试已有操作")); return; }
    if (!actions[key]) { actions[key] = {target:connection.session,path,body}; saveActions(); }
    const operation = actions[key]; running.add(key); render();
    try {
      await api(`/api/v1/sessions/${operation.target}/${operation.path}`, "POST", operation.body, connection, connection.identity);
      if (actions[key] === operation) { delete actions[key]; saveActions(); }
      if (owns(connection)) await refresh(connection);
    } catch (failure) {
      if (definitive(failure) && actions[key] === operation) { delete actions[key]; saveActions(); }
      if (owns(connection)) { error(new Error(`${failure.message}${definitive(failure) ? "" : "；请用原 ID 重试"}`)); if (bindingErrors.has(failure.code)) reconnect(connection); }
    } finally { running.delete(key); if (owns(connection)) render(); }
  }
  $("login").onsubmit = async event => {
    event.preventDefault();
    try { await api("/auth", "POST", {token:$("token").value}); $("token").value = ""; await load(); }
    catch (failure) { error(failure); }
  };
  function headerMap(text) {
    const headers = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const split = trimmed.indexOf(":");
      if (split <= 0) throw new Error("请求头需要“名称: 值”");
      headers[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
    }
    return headers;
  }
  $("model-form").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    const [provider, model] = $("model-choice").value.split("\n");
    const maxTokens = Number($("model-form").dataset.maxTokens || 2048);
    let headers;
    try { headers = headerMap($("model-headers").value); }
    catch (failure) { error(failure); return; }
    try {
      const saved = await api("/api/v1/models", "POST", {
        provider, model, base_url: $("model-endpoint").value, max_tokens: maxTokens,
        proxy: $("model-proxy").value, headers,
      });
      $("model-endpoint").value = saved.base_url;
      $("model-endpoint").disabled = saved.provider !== "deepseek";
      $("model-proxy").value = saved.proxy || "";
      $("model-headers").value = Object.entries(saved.headers || {}).map(([name, value]) => `${name}: ${value}`).join("\n");
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  async function saveCredential(clear) {
    if (!identity || health?.state !== "ready") return;
    const key = $("model-key").value;
    if (!clear && !key) { error(new Error("请输入密钥")); return; }
    try {
      const saved = await api("/api/v1/models/credential", "POST", {
        expected_revision: Number($("model-form").dataset.credentialRevision || 0),
        clear, api_key: clear ? "" : key,
      });
      $("model-key").value = "";
      $("model-form").dataset.credentialRevision = String(saved.credential_revision || 0);
      $("model-key-state").textContent = saved.key_configured ? "密钥已配置" : "密钥未配置";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  }
  $("model-key-save").onclick = () => { void saveCredential(false); };
  $("model-key-clear").onclick = () => { void saveCredential(true); };
  let fileDir = "", fileWorkspace = "", fileView = null, fileNavigation = 0, fileListing = 0;
  const fileJoin = (dir, name) => dir ? `${dir}/${name}` : name;
  const checkpointState = element("p", "", "muted");
  checkpointState.id = "checkpoint-state";
  checkpointState.setAttribute("role", "status");
  $("checkpoint-save").before(checkpointState);
  function fileControls() {
    const ready = Boolean(fileView?.digest), busy = Boolean(fileView?.busy);
    $("file-content").readOnly = !ready || fileView.truncated;
    $("file-save").disabled = !ready || busy || fileView.truncated;
    $("checkpoint-save").disabled = !ready || busy;
    $("checkpoint-preview").disabled = !ready || busy || !fileView.checkpoint;
    $("checkpoint-restore").disabled = !ready || busy || !fileView.checkpoint;
    checkpointState.textContent = !ready ? "请先选择文件" : fileView.checkpoint ?
      `${fileView.path} · 检查点 ${fileView.checkpoint.digest.slice(0, 12)}` : fileView.checkpointStatus;
  }
  function resetFile() {
    fileView = null;
    $("file-content").value = "";
    $("file-diff").textContent = "";
    $("error").textContent = "";
    fileControls();
  }
  $("file-content").addEventListener("input", () => { if (fileView) fileView.editVersion++; });
  function changeDirectory(dir, workspace = fileWorkspace, absolute = "") {
    fileNavigation++;
    fileDir = dir; fileWorkspace = workspace;
    resetFile();
    $("file-list").replaceChildren();
    $("workspace-location").textContent = absolute;
    return loadFiles();
  }
  async function loadWorkspaces() {
    const navigation = fileNavigation;
    const listed = await api("/api/v1/workspaces");
    if (navigation !== fileNavigation) return;
    $("workspace-list").replaceChildren(...listed.workspaces.map(item => button(item.primary ? "主工作区" : item.name, () =>
      void changeDirectory(item.primary ? "" : `grant/${item.name}`, item.primary ? "" : item.name, item.host_path))));
    const current = listed.workspaces.find(item => (item.primary && !fileWorkspace) || item.name === fileWorkspace);
    if (current) $("workspace-location").textContent = current.host_path;
  }
  async function loadFiles() {
    const dir = fileDir, navigation = fileNavigation, request = ++fileListing;
    const active = () => navigation === fileNavigation && request === fileListing;
    try {
      const listing = await api(dir ? `/api/v1/files?path=${encodeURIComponent(dir)}` : "/api/v1/files");
      if (!active()) return;
      if (listing.absolute_path) $("workspace-location").textContent = listing.absolute_path;
      const nodes = [];
      if (dir) nodes.push(button("上级", () => void changeDirectory(dir.split("/").slice(0, -1).join("/"))));
      for (const item of listing.entries) {
        if (item.kind === "dir") nodes.push(button(`${item.name}/`, () => void changeDirectory(fileJoin(dir, item.name))));
        else if (item.kind === "file") nodes.push(button(item.name, () => void openFile(fileJoin(dir, item.name))));
      }
      if (listing.truncated) nodes.push(element("p", "只显示前 200 项", "muted"));
      $("file-list").replaceChildren(...nodes);
    } catch (failure) { if (active()) error(failure); }
  }
  function checkpointMatches(view, row) {
    return row?.path === view.path && row.workspace === view.workspace &&
      typeof row.checkpoint_id === "string" && row.checkpoint_id.length > 0 &&
      typeof row.digest === "string" && row.digest.length > 0;
  }
  async function loadCheckpoints(view) {
    const request = {};
    view.discovery = request;
    const active = () => fileView === view && view.discovery === request;
    try {
      const listed = await api(`/api/v1/checkpoints?workspace=${encodeURIComponent(view.workspace)}&path=${encodeURIComponent(view.path)}`);
      if (!active()) return;
      view.checkpoint = listed.checkpoints.filter(row => checkpointMatches(view, row)).at(-1) || null;
      view.checkpointStatus = "暂无检查点";
    } catch (failure) {
      if (!active()) return;
      view.checkpointStatus = "检查点加载失败";
      error(failure);
    } finally {
      if (active()) fileControls();
    }
  }
  async function openFile(name) {
    resetFile();
    const view = {path: "", workspace: "", digest: "", truncated: false, checkpoint: null,
      checkpointStatus: "正在加载检查点", discovery: null, busy: false, editVersion: 0};
    fileView = view;
    try {
      const file = await api(`/api/v1/files/content?path=${encodeURIComponent(name)}`);
      if (fileView !== view) return;
      view.path = file.path; view.digest = file.digest; view.truncated = file.truncated;
      view.workspace = file.path.startsWith("grant/") ? file.path.split("/")[1] : "primary";
      $("file-content").value = file.content;
      $("file-diff").textContent = file.truncated ? "文件过大，只显示前一部分" : "";
      fileControls();
      await loadCheckpoints(view);
    } catch (failure) { if (fileView === view) error(failure); }
  }
  resetFile();
  $("files").addEventListener("toggle", async () => {
    if (!$("files").open) return;
    const navigation = fileNavigation;
    try {
      await loadWorkspaces();
      if (navigation === fileNavigation) await loadFiles();
    } catch (failure) { if (navigation === fileNavigation) error(failure); }
  });
  $("workspace-form").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    const navigation = fileNavigation, view = fileView;
    let appliedNavigation = navigation;
    try {
      const created = await api("/api/v1/workspaces", "POST", {name: $("workspace-name").value, host_path: $("workspace-path").value}, current);
      if (navigation !== fileNavigation || view !== fileView) return;
      const listing = changeDirectory(`grant/${created.name}`, created.name, created.host_path);
      appliedNavigation = fileNavigation;
      await loadWorkspaces();
      await listing;
    } catch (failure) { if (appliedNavigation === fileNavigation && (view === fileView || !fileView)) error(failure); }
  };
  const terminalScreens = new Map();
  const terminalQueues = new Map();
  let terminalEngine = null;
  function loadTerminalEngine() {
    if (!terminalEngine) {
      const specifier = globalThis.AMAZME_XTERM_URL || new URL("./xterm-terminal.js", import.meta.url).href;
      terminalEngine = import(specifier).then(mod => {
        if (!mod.Terminal) throw new Error("终端模拟器未提供 Terminal");
        return mod.Terminal;
      });
    }
    return terminalEngine;
  }
  function terminalText(term) {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
  async function renderTerminalNow(view, value) {
    const Terminal = await loadTerminalEngine();
    const cols = Math.max(1, value.cols || 80);
    const rows = Math.max(1, value.rows || 24);
    let screen = terminalScreens.get(view.id);
    if (!screen || screen.cols !== cols || screen.rows !== rows) {
      if (screen) screen.term.dispose();
      screen = {
        term: new Terminal({cols, rows, scrollback: 1000, convertEol: false, allowProposedApi: true}),
        cols, rows, seq: 0, ready: false,
      };
      terminalScreens.set(view.id, screen);
    }
    const text = value.output || "";
    const seq = Number(value.output_seq || text.length);
    const delta = seq - screen.seq;
    let chunk = "";
    if (!screen.ready || seq < screen.seq || delta > text.length) {
      screen.term.reset();
      chunk = text;
    } else if (delta > 0) chunk = text.slice(text.length - delta);
    if (chunk) await new Promise(resolve => screen.term.write(chunk, resolve));
    screen.seq = seq;
    screen.ready = true;
    return terminalText(screen.term);
  }
  function renderTerminal(view, value) {
    const previous = terminalQueues.get(view.id) || Promise.resolve();
    const next = previous.then(() => renderTerminalNow(view, value), () => renderTerminalNow(view, value));
    terminalQueues.set(view.id, next);
    return next;
  }
  globalThis.renderTerminal = renderTerminal;
  let terminalView = null, terminalPoll = null, terminalNavigation = 0;
  const terminalKey = (connection, suffix) => `terminal:${identity.profile_id}:${connection.session}:${suffix}`;
  const terminalOwns = view => view && terminalView === view && owns(view.connection);
  async function showTerminal(value, view = terminalView) {
    if (!terminalOwns(view)) return;
    view.phase = value.phase;
    try {
      const text = await renderTerminal(view, value);
      if (!terminalOwns(view)) return;
      $("terminal-output").textContent = text;
    } catch (failure) {
      if (terminalOwns(view)) error(failure);
      return;
    }
    $("terminal-state").textContent = value.phase === "unknown" ? "通道失联；命令未自动重启" : value.phase === "exited" ? "已退出" : "运行中";
    if (value.exit_code !== null && value.exit_code !== undefined) $("terminal-state").textContent += ` · 退出码 ${value.exit_code}`;
    if (value.clean === false && value.phase !== "running") $("terminal-state").textContent += " · 停止尚未确认";
  }
  async function pollTerminal(view) {
    if (!terminalOwns(view) || !$("terminal").open || view.phase !== "running") return;
    try {
      const value = await api(`/api/v1/sessions/${view.connection.session}/terminals/${view.id}/read`, "POST", {}, view.connection);
      await showTerminal(value, view);
    }
    catch (failure) { if (terminalOwns(view)) error(failure); }
    if (terminalOwns(view) && $("terminal").open && view.phase === "running") terminalPoll = setTimeout(() => pollTerminal(view), 750);
  }
  function selectTerminal(value, connection) {
    clearTimeout(terminalPoll);
    terminalView = {id:value.terminal_id, connection, phase:value.phase, busy:false};
    const pending = sessionStorage.getItem(terminalKey(connection, value.terminal_id));
    $("terminal-input").value = pending ? JSON.parse(pending).text : "";
    showTerminal(value);
    void pollTerminal(terminalView);
  }
  async function loadTerminals() {
    const connection = current, navigation = ++terminalNavigation;
    if (!connection || !identity) return;
    const listing = await api(`/api/v1/sessions/${connection.session}/terminals`);
    if (!owns(connection) || navigation !== terminalNavigation) return;
    const rows = listing.terminals;
    $("terminal-choice").replaceChildren(...rows.map(row => {
      const option = document.createElement("option"); option.value = row.terminal_id;
      option.textContent = `${row.workspace} · ${row.terminal_id.slice(0, 8)} · ${row.phase}`;
      return option;
    }));
    const row = rows.find(row => row.terminal_id === terminalView?.id) || rows.find(row => row.phase === "running") || rows[0];
    if (row) { $("terminal-choice").value = row.terminal_id; selectTerminal(row, connection); }
    else { terminalView = null; $("terminal-output").textContent = ""; $("terminal-state").textContent = "尚无终端，点击新建"; }
    $("terminal-choice").onchange = () => {
      const row = rows.find(row => row.terminal_id === $("terminal-choice").value);
      if (row && owns(connection)) selectTerminal(row, connection);
    };
  }
  $("terminal").addEventListener("toggle", () => {
    if ($("terminal").open && selected && identity) void loadTerminals().catch(error);
    else clearTimeout(terminalPoll);
  });
  // Empty workspace tells the host to use the session directory. The file panel must not retarget it.
  const sessionOwnedWorkspace = "";
  $("terminal-new").onclick = async () => {
    const connection = current, workspace = sessionOwnedWorkspace;
    if (!connection || health?.state !== "ready" || $("terminal-new").disabled) return;
    const key = terminalKey(connection, `open:${workspace}`);
    let id = sessionStorage.getItem(key);
    if (!id) { id = crypto.randomUUID().replaceAll("-", ""); sessionStorage.setItem(key, id); }
    $("terminal-new").disabled = true;
    try {
      const value = await api(`/api/v1/sessions/${connection.session}/terminals`, "POST", {terminal_id:id, command:"sh", cols:80, rows:24, workspace}, connection);
      sessionStorage.removeItem(key);
      if (owns(connection)) { selectTerminal(value, connection); await loadTerminals(); }
    } catch (failure) { if (owns(connection)) error(failure); }
    finally { $("terminal-new").disabled = false; }
  };
  $("terminal-form").onsubmit = async event => {
    event.preventDefault();
    const view = terminalView;
    if (!terminalOwns(view) || view.busy || view.phase !== "running") return;
    const key = terminalKey(view.connection, view.id), text = $("terminal-input").value;
    let pending = JSON.parse(sessionStorage.getItem(key) || "null");
    if (pending && pending.text !== text) { error(new Error("上次输入结果未确认；先重试同一输入，或核对终端后继续。")); return; }
    if (!pending) { pending = {input_id:crypto.randomUUID().replaceAll("-", ""), text}; sessionStorage.setItem(key, JSON.stringify(pending)); }
    view.busy = true;
    try {
      const result = await api(`/api/v1/sessions/${view.connection.session}/terminals/${view.id}/input`, "POST",
        {input_id:pending.input_id, data:`${pending.text}\n`}, view.connection);
      if (result.input_status === "unknown") throw new Error("输入结果未知，未自动重发；请核对终端内容。");
      sessionStorage.removeItem(key);
      if (terminalOwns(view)) { if ($("terminal-input").value === text) $("terminal-input").value = ""; $("error").textContent = ""; }
    } catch (failure) { if (terminalOwns(view)) error(failure); }
    finally { view.busy = false; }
  };
  $("terminal-confirm").onclick = () => {
    const view = terminalView;
    if (!terminalOwns(view) || view.busy) return;
    sessionStorage.removeItem(terminalKey(view.connection, view.id));
    sessionStorage.removeItem(terminalKey(view.connection, `${view.id}:keys`));
    $("terminal-input").value = "";
    $("terminal-state").textContent = "已由用户核对；原输入不会重放";
  };
  $("terminal-output").addEventListener("keydown", event => {
    const view = terminalView;
    if (!terminalOwns(view) || view.busy || view.phase !== "running") return;
    let data = null;
    if (event.key === "Enter") data = "\r";
    else if (event.key === "Backspace") data = "\b";
    else if (event.key === "Tab") data = "\t";
    else if (event.key === "ArrowUp") data = "\u001b[A";
    else if (event.key === "ArrowDown") data = "\u001b[B";
    else if (event.key === "ArrowRight") data = "\u001b[C";
    else if (event.key === "ArrowLeft") data = "\u001b[D";
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) data = event.key;
    if (data === null) return;
    event.preventDefault();
    const key = terminalKey(view.connection, `${view.id}:keys`);
    let pending = JSON.parse(sessionStorage.getItem(key) || "null");
    if (pending && pending.data !== data) { error(new Error("上次输入结果未确认；先重试同一输入，或核对终端后继续。")); return; }
    if (!pending) { pending = {input_id:crypto.randomUUID().replaceAll("-", ""), data}; sessionStorage.setItem(key, JSON.stringify(pending)); }
    view.busy = true;
    api(`/api/v1/sessions/${view.connection.session}/terminals/${view.id}/input`, "POST",
      {input_id:pending.input_id, data:pending.data}, view.connection).then(result => {
      if (result.input_status === "unknown") throw new Error("输入结果未知，未自动重发；请核对终端内容。");
      sessionStorage.removeItem(key);
      if (terminalOwns(view)) $("error").textContent = "";
    }).catch(failure => { if (terminalOwns(view)) error(failure); }).finally(() => { view.busy = false; });
  });
  $("terminal-close").onclick = async () => {
    const view = terminalView;
    if (!terminalOwns(view)) return;
    try { showTerminal(await api(`/api/v1/sessions/${view.connection.session}/terminals/${view.id}/close`, "POST", {}, view.connection), view); }
    catch (failure) { if (terminalOwns(view)) error(failure); }
  };
  let mcpView = null, mcpPoll = null, mcpNavigation = 0;
  const mcpOwns = view => view && mcpView === view && owns(view.connection);
  const mcpKey = (connection, suffix) => `mcp:${identity.profile_id}:${connection.session}:${suffix}`;
  function showMcpState(state, connection, preferred = mcpView?.id) {
    if (!owns(connection)) return;
    const openingKey = mcpKey(connection, "opening"), opening = JSON.parse(sessionStorage.getItem(openingKey) || "null");
    if (opening && state.servers.some(row => row.server_id === opening.server_id)) sessionStorage.removeItem(openingKey);
    const row = state.servers.find(row => row.server_id === preferred) || state.servers.find(row => row.phase === "ready") || state.servers[0];
    $("mcp-server").replaceChildren(...state.servers.map(row => {
      const option = document.createElement("option"); option.value = row.server_id;
      option.textContent = `${row.server_id.slice(0, 8)} · ${row.workspace} · ${row.phase}`; return option;
    }));
    if (!row) { if (opening) $("mcp-command").value = opening.command; mcpView = null; $("mcp-state").textContent = "尚未连接服务"; $("mcp-tools").replaceChildren(); $("mcp-approval").replaceChildren(); return; }
    const changing = !mcpView || mcpView.connection !== connection || mcpView.id !== row.server_id;
    if (changing) {
      mcpView = {id:row.server_id, connection, tool:null, busy:false};
      $("mcp-arguments").value = "{}";
      $("mcp-schema").textContent = "选择一个工具以查看参数";
    }
    const view = mcpView;
    view.phase = row.phase;
    $("mcp-server").value = row.server_id;
    $("mcp-state").textContent = row.phase === "ready" ? `已连接 · ${row.protocol_version}` : row.phase === "exited" ? "已退出" : "通道失联，未自动重启";
    if (row.exit_code !== null) $("mcp-state").textContent += ` · 退出码 ${row.exit_code}`;
    if (!row.clean && row.phase !== "ready") $("mcp-state").textContent += " · 停止尚未确认";
    $("mcp-tools").replaceChildren(...row.tools.map(tool => button(tool.name, () => {
      if (!mcpOwns(view)) return;
      view.tool = tool.name;
      $("mcp-schema").textContent = `${tool.description || tool.name}\n${JSON.stringify(tool.input_schema, null, 2)}`;
    }, row.phase !== "ready")));
    const calls = state.calls.filter(call => call.server_id === row.server_id);
    const pendingKey = mcpKey(connection, `call:${row.server_id}`), pendingCall = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    if (pendingCall && calls.some(call => call.call_id === pendingCall.call_id)) sessionStorage.removeItem(pendingKey);
    else if (changing && pendingCall) { view.tool = pendingCall.name; $("mcp-arguments").value = JSON.stringify(pendingCall.arguments, null, 2); }
    for (const call of calls) if (call.phase !== "waiting_approval") sessionStorage.removeItem(mcpKey(connection, `decision:${call.call_id}`));
    const manualCalls = calls.filter(call => call.phase === "waiting_approval" && call.origin !== "model");
    $("mcp-approval").replaceChildren(...manualCalls.map(call => {
      const article = element("article"); article.dataset.mcpCall = call.call_id;
      article.append(element("pre", `${row.command}\n${call.name}\n${JSON.stringify(call.arguments, null, 2)}`));
      for (const approve of [true, false]) article.append(button(approve ? "批准调用" : "拒绝调用", async () => {
        if (!mcpOwns(view) || view.busy) return;
        const key = mcpKey(connection, `decision:${call.call_id}`);
        let decision = JSON.parse(sessionStorage.getItem(key) || "null");
        if (decision && decision.approve !== approve) { error(new Error("原决定回执未确认，请沿用原决定查询结果。")); return; }
        if (!decision) { decision = {decision_id:crypto.randomUUID().replaceAll("-", ""), approve, digest:call.digest}; sessionStorage.setItem(key, JSON.stringify(decision)); }
        view.busy = true;
        try {
          await api(`/api/v1/sessions/${connection.session}/mcp/${view.id}/calls/${call.call_id}/decision`, "POST", decision, connection);
          sessionStorage.removeItem(key);
          if (mcpOwns(view)) await loadMcp();
        } catch (failure) { if (mcpOwns(view)) error(failure); }
        finally { view.busy = false; }
      }));
      return article;
    }));
    $("mcp-result").textContent = calls.filter(call => call.phase !== "waiting_approval" || call.origin === "model").slice(0, 30).map(call =>
      `${call.name} · ${call.phase}${call.is_error ? " · 工具报告错误" : ""}\n${call.result || ""}${call.result_data?.structuredContent ? "\n" + JSON.stringify(call.result_data.structuredContent, null, 2) : ""}`).join("\n\n");
    $("mcp-server").onchange = () => { if (owns(connection)) showMcpState(state, connection, $("mcp-server").value); };
  }
  async function loadMcp() {
    clearTimeout(mcpPoll);
    const connection = current, navigation = ++mcpNavigation;
    if (!connection || !identity) return;
    try {
      const state = await api(`/api/v1/sessions/${connection.session}/mcp`);
      if (owns(connection) && navigation === mcpNavigation) showMcpState(state, connection);
    } finally {
      if (owns(connection) && navigation === mcpNavigation && $("mcp").open) mcpPoll = setTimeout(() => loadMcp().catch(error), 750);
    }
  }
  $("mcp").addEventListener("toggle", () => {
    if ($("mcp").open && selected && identity) void loadMcp().catch(error); else clearTimeout(mcpPoll);
  });
  $("mcp-form").onsubmit = async event => {
    event.preventDefault();
    const connection = current;
    if (!connection || health?.state !== "ready") return;
    const key = mcpKey(connection, "opening"), command = $("mcp-command").value;
    let pending = JSON.parse(sessionStorage.getItem(key) || "null");
    if (pending && (pending.command !== command || pending.workspace !== sessionOwnedWorkspace)) { error(new Error("先用原命令核对连接结果，避免重复启动服务。")); return; }
    if (!pending) { pending = {server_id:crypto.randomUUID().replaceAll("-", ""), command, workspace:sessionOwnedWorkspace}; sessionStorage.setItem(key, JSON.stringify(pending)); }
    try {
      const server = await api(`/api/v1/sessions/${connection.session}/mcp`, "POST", pending, connection);
      sessionStorage.removeItem(key);
      if (owns(connection)) { mcpView = {id:server.server_id, connection, tool:null, busy:false}; await loadMcp(); }
    } catch (failure) { if (owns(connection)) error(failure); }
  };
  $("mcp-request").onclick = async () => {
    const view = mcpView;
    if (!mcpOwns(view) || !view.tool || view.busy || view.phase !== "ready") return;
    const key = mcpKey(view.connection, `call:${view.id}`);
    try {
      const args = JSON.parse($("mcp-arguments").value);
      if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("参数必须是 JSON 对象");
      let pending = JSON.parse(sessionStorage.getItem(key) || "null");
      if (pending && (pending.name !== view.tool || JSON.stringify(pending.arguments) !== JSON.stringify(args))) throw new Error("原调用回执未确认，请保留参数并使用原 ID 重试。");
      if (!pending) { pending = {call_id:crypto.randomUUID().replaceAll("-", ""), name:view.tool, arguments:args}; sessionStorage.setItem(key, JSON.stringify(pending)); }
      view.busy = true;
      await api(`/api/v1/sessions/${view.connection.session}/mcp/${view.id}/calls`, "POST", pending, view.connection);
      sessionStorage.removeItem(key);
      if (mcpOwns(view)) await loadMcp();
    } catch (failure) { if (mcpOwns(view)) error(failure); }
    finally { view.busy = false; }
  };
  let webPolicy = null;
  function showWebPolicy(policy) {
    webPolicy = policy;
    $("web-enabled").checked = Boolean(policy.enabled);
    $("web-state").textContent = `${policy.enabled ? "已启用" : "已关闭"} · ${policy.base_url}`;
  }
  async function loadWebPolicy() {
    if (!selected) return;
    showWebPolicy(await api(`/api/v1/sessions/${selected}/web`));
  }
  $("web").addEventListener("toggle", () => {
    if ($("web").open) loadWebPolicy().catch(error);
  });
  $("web-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/web`, "POST", {
        ...(webPolicy || {}), enabled: $("web-enabled").checked,
      }, current);
      showWebPolicy(view);
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  const webCallKey = () => `web-call:${identity.profile_id}:${selected}`;
  $("web-search").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    const query = $("web-query").value;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(webCallKey()) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && pending.query !== query) {
      error(new Error("上次网页查询结果未知，未自动重发；请用同一查询再查。"));
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {call_id: crypto.randomUUID().replaceAll("-", ""), query, phase: "unknown"};
      sessionStorage.setItem(webCallKey(), JSON.stringify(pending));
    }
    try {
      const view = await api(`/api/v1/sessions/${selected}/web/calls`, "POST", {
        call_id: pending.call_id, kind: "search", query: pending.query,
      }, current);
      pending.phase = view.phase;
      if (view.phase === "unknown") sessionStorage.setItem(webCallKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(webCallKey());
      $("web-state").textContent = `${view.phase} · ${view.error || view.result}`;
      if (view.phase === "unknown") error(new Error("上次网页查询结果未知，未自动重发；请用同一查询再查。"));
      else $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let computerCapture = "";
  $("computer-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/computer`, "POST", {enabled: $("computer-enabled").checked}, current);
      $("computer-state").textContent = view.enabled ? "已启用" : "已关闭";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("computer-observe").onclick = async () => {
    if (!selected || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/computer/observe`, "POST", {}, current);
      computerCapture = view.capture ? view.capture.capture_id : "";
      $("computer-state").textContent = view.permitted ? `${view.capture.width}×${view.capture.height}` : view.error;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  const computerActionKey = () => `computer-action:${identity.profile_id}:${selected}`;
  $("computer-act").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !computerCapture || !identity || health?.state !== "ready") return;
    const point = {capture_id: computerCapture, x: Number($("computer-x").value), y: Number($("computer-y").value)};
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(computerActionKey()) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && (
      pending.capture_id !== point.capture_id || pending.x !== point.x || pending.y !== point.y)) {
      error(new Error("上次桌面动作结果未知，未自动重发；请用同一画面和坐标再查。"));
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {action_id: crypto.randomUUID().replaceAll("-", ""), ...point, phase: "unknown"};
      sessionStorage.setItem(computerActionKey(), JSON.stringify(pending));
    }
    try {
      const view = await api(`/api/v1/sessions/${selected}/computer/actions`, "POST", {
        action_id: pending.action_id, capture_id: pending.capture_id, x: pending.x, y: pending.y,
      }, current);
      pending.phase = view.phase;
      if (view.phase === "unknown") sessionStorage.setItem(computerActionKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(computerActionKey());
      $("computer-state").textContent = `${view.phase} · ${view.driver_x},${view.driver_y}`;
      if (view.phase === "unknown") error(new Error("上次桌面动作结果未知，未自动重发；请用同一画面和坐标再查。"));
      else $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("computer-cleanup").onclick = async () => {
    if (!selected || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/computer/cleanup`, "POST", {}, current);
      $("computer-state").textContent = view.cleared ? `已清理 ${view.proof}` : "";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let workflowId = "", workflowView = null;
  function showWorkflow(view) {
    workflowView = view;
    const children = (view.children || []).map(item => `${item.role}:${item.status}`).join(",");
    $("workflow-state").textContent = `${view.stage} · ${view.attempts} · ${children}`;
  }
  $("workflow-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    workflowId = workflowId || crypto.randomUUID().replaceAll("-", "");
    try {
      showWorkflow(await api(`/api/v1/sessions/${selected}/workflows`, "POST", {
        workflow_id: workflowId, check: $("workflow-check").value,
        correction_limit: Number($("workflow-limit").value),
      }, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  async function verdict(passed) {
    if (!selected || !workflowId || !identity || health?.state !== "ready") return;
    try {
      showWorkflow(await api(`/api/v1/sessions/${selected}/workflows/${workflowId}/verdicts`, "POST", {
        verdict_id: crypto.randomUUID().replaceAll("-", ""), passed,
      }, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  }
  $("workflow-fail").onclick = () => void verdict(false);
  $("workflow-pass").onclick = () => void verdict(true);
  $("workflow-resume").onclick = async () => {
    if (!selected || !workflowId || !identity) return;
    try {
      showWorkflow(await api(`/api/v1/sessions/${selected}/workflows/${workflowId}/resume`, "POST", {}, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("workflow-cancel").onclick = async () => {
    if (!selected || !workflowId || !identity || health?.state !== "ready") return;
    try {
      showWorkflow(await api(`/api/v1/sessions/${selected}/workflows/${workflowId}/cancel`, "POST", {}, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("workflow-cancel-child").onclick = async () => {
    if (!selected || !workflowId || !workflowView || !identity || health?.state !== "ready") return;
    const child = (workflowView.children || []).find(item => item.status !== "succeeded" && item.status !== "cancelled"
      && item.status !== "failed" && item.status !== "interrupted" && item.status !== "unknown") || workflowView.children.at(-1);
    if (!child) return;
    try {
      showWorkflow(await api(
        `/api/v1/sessions/${selected}/workflows/${workflowId}/children/${child.request_id}/cancel`, "POST", {}, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let automationId = "";
  $("automation-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    automationId = automationId || crypto.randomUUID().replaceAll("-", "");
    try {
      const view = await api("/api/v1/automations", "POST", {
        automation_id: automationId, session_id: selected, text: $("automation-text").value,
        zone: $("automation-zone").value, local: $("automation-local").value,
      }, current);
      $("automation-state").textContent = `${view.phase} · ${view.due_ms}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("automation-tick").onclick = async () => {
    try {
      const tick = await api("/api/v1/automations/tick", "POST", {}, current);
      $("automation-state").textContent = tick.fired ? `${tick.fired.phase} · ${tick.fired.delivery_id}` : "没有到期任务";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("memory").addEventListener("toggle", () => {
    if (!$("memory").open || !selected) return;
    const workspace = sessionWorkspaces.get(selected) || "primary";
    api(`/api/v1/memories?workspace=${encodeURIComponent(workspace)}`).then(list => {
      $("memory-list").textContent = list.memories.map(item => item.text).join("\n");
    }).catch(error);
  });
  $("memory-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    const workspace = sessionWorkspaces.get(selected) || "primary";
    const text = $("memory-text").value;
    const key = `memory:${identity.profile_id}:${selected}:${workspace}`;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && pending.text !== text) {
      error(new Error("上次记忆结果未知，未自动重发；请用同一内容查询。"));
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {memory_id: crypto.randomUUID().replaceAll("-", ""), text, phase: "unknown"};
      sessionStorage.setItem(key, JSON.stringify(pending));
    }
    try {
      await api("/api/v1/memories", "POST", {
        memory_id: pending.memory_id, workspace, text: pending.text,
      }, current);
      sessionStorage.removeItem(key);
      const list = await api(`/api/v1/memories?workspace=${encodeURIComponent(workspace)}`);
      $("memory-list").textContent = list.memories.map(item => item.text).join("\n");
      $("memory-text").value = "";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("memory-preview").onclick = async () => {
    if (!selected) return;
    try {
      const list = await api(`/api/v1/sessions/${selected}/memories?q=${encodeURIComponent($("prompt").value)}`);
      $("memory-list").textContent = list.memories.length ? list.memories.map(item => item.text).join("\n") : "没有将注入的记忆";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let pluginId = "";
  async function loadPlugins() {
    const list = await api("/api/v1/plugins");
    $("plugin-list").textContent = list.plugins.length ? list.plugins.map(item => item.name).join("\n") : "还没有插件";
  }
  $("plugins").addEventListener("toggle", () => {
    if ($("plugins").open) loadPlugins().catch(error);
  });
  function showPlugin(view, call) {
    $("plugin-state").textContent = `${view.name} · ${view.entry} · ${view.fingerprint.slice(0, 12)}`;
    if (call) $("plugin-result").textContent = call.phase === "done" ? call.result : call.phase;
  }
  $("plugin-form").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    pluginId = pluginId || crypto.randomUUID().replaceAll("-", "");
    try {
      showPlugin(await api("/api/v1/plugins", "POST", {plugin_id: pluginId, name: $("plugin-name").value, config: {label: $("plugin-label").value}}, current));
      await loadPlugins();
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  const pluginCallKey = () => `plugin-call:${identity.profile_id}:${selected}:${pluginId}`;
  $("plugin-call").onsubmit = async event => {
    event.preventDefault();
    if (!pluginId || !selected || !identity || health?.state !== "ready") return;
    const text = $("plugin-text").value;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(pluginCallKey()) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && pending.text !== text) {
      error(new Error("上次插件调用结果未知，未自动重发；请用同一文本查询。"));
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {call_id: crypto.randomUUID().replaceAll("-", ""), text, phase: "unknown"};
      sessionStorage.setItem(pluginCallKey(), JSON.stringify(pending));
    }
    try {
      const call = await api(`/api/v1/sessions/${selected}/plugins/${pluginId}/calls`, "POST",
        {call_id: pending.call_id, text: pending.text}, current);
      pending.phase = call.phase;
      if (call.phase === "unknown") sessionStorage.setItem(pluginCallKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(pluginCallKey());
      $("plugin-result").textContent = call.phase === "done" ? call.result : call.phase;
      if (call.phase === "unknown") error(new Error("上次插件调用结果未知，未自动重发；请用同一文本查询。"));
      else $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("plugin-reload").onclick = async () => {
    if (!pluginId || !identity || health?.state !== "ready") return;
    try {
      showPlugin(await api(`/api/v1/plugins/${pluginId}/reload`, "POST", {config: {label: $("plugin-label").value}}, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("history-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected) return;
    const query = $("history-query").value.trim();
    try {
      const found = await api(`/api/v1/sessions/${selected}/search?q=${encodeURIComponent(query)}`);
      $("history-results").textContent = found.hits.length
        ? found.hits.map(hit => hit.excerpt).join("\n")
        : "没有匹配";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  function money(micro) {
    const whole = Math.trunc(micro / 1000000);
    const frac = String(Math.abs(micro % 1000000)).padStart(6, "0");
    return `${whole}.${frac} 美元`;
  }
  $("usage-load").onclick = async () => {
    if (!selected) return;
    try {
      const usage = await api(`/api/v1/sessions/${selected}/usage`);
      const tokens = `${usage.model_calls} 次模型调用 · 输入 ${usage.input_tokens} · 输出 ${usage.output_tokens} · 缓存读 ${usage.cache_read_tokens} · 缓存写 ${usage.cache_write_tokens} · 推理签名 ${usage.reasoning_signatures}`;
      $("usage-report").textContent = usage.priced ? `${tokens} · ${money(usage.cost_micro_usd)}` : `${tokens} · 未计价`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("diagnostic-load").onclick = async () => {
    if (!selected) return;
    try {
      const report = await api(`/api/v1/sessions/${selected}/diagnostics`);
      const codes = report.error_codes.length ? report.error_codes.join(",") : "无";
      const blocked = report.blocked_code ? ` · ${report.blocked_code}` : "";
      $("diagnostic-report").textContent = `${report.state} · 失败 ${report.failed} · 未知 ${report.unknown} · ${codes}${blocked}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let artifactId = "";
  async function loadArtifacts() {
    if (!selected) return;
    const list = await api(`/api/v1/sessions/${selected}/artifacts`);
    $("artifact-list").replaceChildren(...list.artifacts.map(item => button(
      `${item.name} · ${item.size}`, () => void openArtifact(item.artifact_id))));
    if (!list.artifacts.length) $("artifact-list").textContent = "还没有产物";
  }
  async function openArtifact(id) {
    const body = await api(`/api/v1/sessions/${selected}/artifacts/${id}`);
    let text = "";
    try { text = atob(body.data_base64); } catch { text = ""; }
    $("artifact-body").textContent = `${body.name} · ${body.digest}\n${text}`;
    $("error").textContent = "";
  }
  $("artifacts").addEventListener("toggle", () => {
    if ($("artifacts").open) loadArtifacts().catch(error);
  });
  $("artifact-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !writable()) return;
    const file = ($("artifact-file").files || [])[0];
    if (!file) { error(new Error("请选择文件")); return; }
    if (!file.size || file.size > 1048576) { error(new Error("产物超过 1 MB")); return; }
    const name = $("artifact-name").value.trim();
    if (!name || name.includes("/") || name.includes("\\")) { error(new Error("产物名称不能包含路径")); return; }
    artifactId = artifactId || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    try {
      const encoded = await readImage(file);
      const media = /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,40}$/.test(encoded.media_type)
        ? encoded.media_type : "application/octet-stream";
      await api(`/api/v1/sessions/${selected}/artifacts`, "POST", {
        artifact_id: artifactId, name, media_type: media, data_base64: encoded.data_base64,
      }, current, current.identity);
      artifactId = "";
      $("artifact-file").value = "";
      await loadArtifacts();
      $("error").textContent = "";
    } catch (failure) {
      if (definitive(failure)) artifactId = "";
      error(failure);
    }
  };
  async function loadProjects() {
    const list = await api("/api/v1/projects");
    $("manage-projects").textContent = list.projects.length
      ? list.projects.map(item => item.name).join("\n")
      : "还没有项目";
  }
  $("manage").addEventListener("toggle", () => {
    if (!$("manage").open) return;
    loadProjects().catch(error);
  });
  $("manage-project").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    const name = $("manage-project-name").value;
    const key = `project-open:${identity.profile_id}`;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { pending = null; }
    if (pending?.phase === "unknown" && pending.name !== name) {
      $("error").textContent = "上次项目结果未知，未自动重发；请用同一名称查询。";
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {
        project_id: crypto.randomUUID().replaceAll("-", ""),
        session_id: crypto.randomUUID().replaceAll("-", ""),
        name, phase: "unknown",
      };
      sessionStorage.setItem(key, JSON.stringify(pending));
    }
    try {
      const project = await api("/api/v1/projects", "POST", {project_id: pending.project_id, name: pending.name}, current);
      const session = await api("/api/v1/sessions", "POST", {
        title: project.name, project_id: project.project_id, session_id: pending.session_id,
      }, current);
      sessionStorage.removeItem(key);
      await load();
      await select(session.session_id);
      await loadProjects();
      $("manage-state").textContent = `${project.project_id} · ${session.session_id}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("manage-settings").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    try {
      const currentSettings = await api("/api/v1/settings");
      const saved = await api("/api/v1/settings", "POST", {
        display_name: $("manage-name").value, expected_revision: currentSettings.revision,
      }, current);
      $("manage-state").textContent = `${saved.display_name} · ${saved.revision}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("manage-feedback").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    const text = $("manage-feedback-text").value;
    const key = `feedback:${identity.profile_id}:${selected}`;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && pending.text !== text) {
      error(new Error("上次反馈结果未知，未自动重发；请用同一内容查询。"));
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {feedback_id: crypto.randomUUID().replaceAll("-", ""), text, phase: "unknown"};
      sessionStorage.setItem(key, JSON.stringify(pending));
    }
    try {
      const saved = await api("/api/v1/feedback", "POST", {
        feedback_id: pending.feedback_id, session_id: selected, text: pending.text,
      }, current);
      sessionStorage.removeItem(key);
      $("manage-state").textContent = saved.session_id;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("manage-share").onclick = async () => {
    if (!selected || !identity || health?.state !== "ready") return;
    const key = `share:${identity.profile_id}:${selected}`;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); }
    catch { pending = null; }
    if (!pending || pending.phase !== "unknown") {
      pending = {share_id: crypto.randomUUID().replaceAll("-", ""), phase: "unknown"};
      sessionStorage.setItem(key, JSON.stringify(pending));
    }
    try {
      const view = await api(`/api/v1/sessions/${selected}/shares`, "POST", {
        share_id: pending.share_id,
      }, current);
      sessionStorage.removeItem(key);
      const stored = await api(`/api/v1/sessions/${selected}/shares/${view.share_id}`);
      const text = (stored.messages || []).map(item => item.content).join("\n");
      $("manage-state").textContent = `${stored.session_id} · ${stored.digest.slice(0, 8)}${text ? ` · ${text}` : ""}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("manage-export").onclick = async () => {
    try {
      const bundle = await api("/api/v1/export");
      $("manage-import-text").value = JSON.stringify(bundle);
      $("manage-state").textContent = bundle.format;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("manage-import").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    try {
      const bundle = JSON.parse($("manage-import-text").value);
      const result = await api("/api/v1/import", "POST", bundle, current);
      $("manage-state").textContent = `${result.format} · ${result.created}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let codeRun = "";
  const codeKey = () => `code-run:${identity.profile_id}:${selected}`;
  $("code-run").onclick = async () => {
    if (!selected || !identity || health?.state !== "ready") return;
    const source = $("code-source").value;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(codeKey()) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && pending.source !== source) {
      error(new Error("上次脚本结果未知，未自动重发；请用同一脚本来源查询或取消。"));
      return;
    }
    if (!pending || pending.phase !== "unknown") {
      pending = {run_id: crypto.randomUUID().replaceAll("-", ""), source, phase: "unknown"};
      sessionStorage.setItem(codeKey(), JSON.stringify(pending));
    }
    codeRun = pending.run_id;
    try {
      const view = await api(`/api/v1/sessions/${selected}/code`, "POST", {run_id: pending.run_id, source: pending.source}, current);
      pending.phase = view.phase;
      if (view.phase === "unknown") sessionStorage.setItem(codeKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(codeKey());
      $("code-result").textContent = view.phase === "success" ? view.value : view.phase;
      $("code-state").textContent = view.phase === "success" ? view.state : "";
      if (view.phase === "unknown") error(new Error("上次脚本结果未知，未自动重发；请用同一脚本来源查询或取消。"));
      else $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("code-cancel").onclick = async () => {
    if (!selected || !identity) return;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(codeKey()) || "null"); }
    catch { pending = null; }
    const runId = codeRun || pending?.run_id || "";
    if (!runId) return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/code/${runId}/cancel`, "POST", {}, current);
      codeRun = runId;
      if (view.phase !== "unknown") sessionStorage.removeItem(codeKey());
      $("code-result").textContent = view.phase;
      if (view.phase !== "success") $("code-state").textContent = "";
      if (view.phase === "unknown") error(new Error("上次脚本结果未知，未自动重发；请用同一脚本来源查询或取消。"));
      else $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let remoteId = "";
  const remoteState = {connected:"已连接",disconnected:"已断开，远端未证明停止",blocked:"身份不符，已阻塞"};
  function remoteBody() {
    return {remote_id: remoteId, host: $("remote-host").value, host_key: $("remote-key").value, endpoint: $("remote-endpoint").value, generation: 1};
  }
  function showRemote(view, call) {
    $("remote-state").textContent = remoteState[view.phase] || view.phase;
    if (call) $("remote-result").textContent = call.result || call.phase;
  }
  $("remote-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    remoteId = remoteId || crypto.randomUUID().replaceAll("-", "");
    try {
      showRemote(await api(`/api/v1/sessions/${selected}/remotes`, "POST", remoteBody(), current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  const remoteCallKey = () => `remote-call:${identity.profile_id}:${selected}:${remoteId}`;
  $("remote-command").onsubmit = async event => {
    event.preventDefault();
    if (!remoteId || !selected || !identity || health?.state !== "ready") return;
    const command = $("remote-run").value;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(remoteCallKey()) || "null"); }
    catch { pending = null; }
    if (pending && pending.phase === "unknown" && pending.command !== command) {
      error(new Error("上次远端命令结果未知，未自动重发；请用同一命令查询。"));
      return;
    }
    if (!pending || pending.phase === "done" || pending.phase === "conflict") {
      pending = {call_id: crypto.randomUUID().replaceAll("-", ""), command, phase: "unknown"};
      sessionStorage.setItem(remoteCallKey(), JSON.stringify(pending));
    }
    try {
      const call = await api(`/api/v1/sessions/${selected}/remotes/${remoteId}/calls`, "POST",
        {...remoteBody(), call_id: pending.call_id, command: pending.command}, current);
      pending.phase = call.phase;
      if (call.phase === "done" || call.phase === "conflict") sessionStorage.removeItem(remoteCallKey());
      else sessionStorage.setItem(remoteCallKey(), JSON.stringify(pending));
      $("remote-result").textContent = call.result || call.phase;
      if (call.phase === "unknown") error(new Error("上次远端命令结果未知，未自动重发；请用同一命令查询。"));
      else $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("remote-drop").onclick = async () => {
    if (!remoteId || !selected) return;
    try { showRemote(await api(`/api/v1/sessions/${selected}/remotes/${remoteId}/disconnect`, "POST", remoteBody(), current)); }
    catch (failure) { error(failure); }
  };
  $("remote-again").onclick = async () => {
    if (!remoteId || !selected) return;
    try { showRemote(await api(`/api/v1/sessions/${selected}/remotes/${remoteId}/reconnect`, "POST", remoteBody(), current)); }
    catch (failure) { error(failure); }
  };
  $("mcp-cancel").onclick = async () => {
    const view = mcpView;
    if (!mcpOwns(view)) return;
    try { await api(`/api/v1/sessions/${view.connection.session}/mcp/${view.id}/cancel`, "POST", {}, view.connection); if (mcpOwns(view)) await loadMcp(); }
    catch (failure) { if (mcpOwns(view)) error(failure); }
  };
  $("terminal-resize").onclick = async () => {
    const view = terminalView;
    if (!terminalOwns(view) || view.phase !== "running") return;
    try { showTerminal(await api(`/api/v1/sessions/${view.connection.session}/terminals/${view.id}/resize`, "POST", {cols:100, rows:40}, view.connection), view); }
    catch (failure) { if (terminalOwns(view)) error(failure); }
  };
  async function fileAction(action) {
    const view = fileView;
    if (!view?.digest || view.busy || !identity || health?.state !== "ready") return;
    if (action === "save" && view.truncated) return;
    const checkpoint = view.checkpoint;
    if (["preview", "restore"].includes(action) && !checkpointMatches(view, checkpoint)) return;
    const content = $("file-content").value, editVersion = view.editVersion;
    const editorUnchanged = () => view.editVersion === editVersion && $("file-content").value === content;
    const active = () => fileView === view;
    view.busy = true;
    fileControls();
    try {
      if (action === "checkpoint") {
        const key = `checkpoint:${identity.profile_id || ""}:${view.workspace}:${view.path}`;
        let pending = null;
        try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); }
        catch { pending = null; }
        if (pending && pending.phase === "unknown" && pending.digest !== view.digest) {
          throw new Error("上次检查点结果未知，未自动重发；请先不要改文件，再保存同一次。");
        }
        if (!pending || pending.phase !== "unknown") {
          pending = {checkpoint_id: crypto.randomUUID().replaceAll("-", ""), digest: view.digest, phase: "unknown"};
          sessionStorage.setItem(key, JSON.stringify(pending));
        }
        const checkpointId = pending.checkpoint_id;
        const saved = await api("/api/v1/checkpoints", "POST", {checkpoint_id: checkpointId, workspace: view.workspace, path: view.path}, current);
        sessionStorage.removeItem(key);
        if (!active()) return;
        if (!checkpointMatches(view, saved) || saved.checkpoint_id !== checkpointId) throw new Error("检查点与当前文件不一致");
        view.discovery = null;
        view.checkpoint = saved;
        $("file-diff").textContent = `已保存 ${saved.digest.slice(0, 12)}`;
      } else if (action === "preview") {
        const preview = await api(`/api/v1/checkpoints/${checkpoint.checkpoint_id}`);
        if (!active()) return;
        if (!checkpointMatches(view, preview) || preview.checkpoint_id !== checkpoint.checkpoint_id || preview.digest !== checkpoint.digest)
          throw new Error("检查点与当前文件不一致");
        $("file-diff").textContent = preview.diff || "与当前文件相同";
      } else {
        const changed = action === "save" ?
          await api("/api/v1/files/content", "POST", {path: view.path, content, expected_digest: view.digest}) :
          await api(`/api/v1/checkpoints/${checkpoint.checkpoint_id}/restore`, "POST", {expected_digest: view.digest}, current);
        if (!active()) return;
        if (changed.path !== view.path || !changed.digest || (action === "restore" && changed.digest !== checkpoint.digest))
          throw new Error("文件响应与当前文件不一致");
        view.digest = changed.digest;
        $("file-diff").textContent = changed.diff;
        if (action === "restore") {
          const file = await api(`/api/v1/files/content?path=${encodeURIComponent(view.path)}`);
          if (!active()) return;
          if (file.path !== view.path || !file.digest) throw new Error("文件响应与当前文件不一致");
          view.digest = file.digest; view.truncated = file.truncated;
          if (editorUnchanged()) $("file-content").value = file.content;
          if (file.truncated) $("file-diff").textContent += "\n文件过大，只显示前一部分";
        }
      }
      $("error").textContent = "";
    } catch (failure) { if (active()) error(failure); }
    finally { view.busy = false; if (active()) fileControls(); }
  }
  $("checkpoint-save").onclick = () => fileAction("checkpoint");
  $("checkpoint-preview").onclick = () => fileAction("preview");
  $("checkpoint-restore").onclick = () => fileAction("restore");
  $("file-save").onclick = () => fileAction("save");
  $("create").onclick = async () => {
    $("create").disabled = true;
    try {
      const workspace = namedTarget().workspace || "primary";
      const key = `session-open:${identity?.profile_id || ""}:${workspace}`;
      let pending = null;
      try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { pending = null; }
      if (!pending || pending.phase !== "unknown") {
        pending = {session_id: crypto.randomUUID().replaceAll("-", ""), phase: "unknown"};
        sessionStorage.setItem(key, JSON.stringify(pending));
      }
      const value = await api("/api/v1/sessions", "POST", {title:"工作区任务", workspace, session_id: pending.session_id});
      sessionStorage.removeItem(key);
      const bound = value.workspace || workspace;
      if (!identity?.profile_id) throw new Error("请在地址中写明宿主、会话和工作区");
      rememberWindow(value.session_id, bound, identity.profile_id);
      await load();
      if (selected !== value.session_id) await select(value.session_id);
    }
    catch (failure) { error(failure); } finally { controls(); }
  };
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const comma = text.indexOf(",");
        resolve({media_type: file.type, data_base64: comma >= 0 ? text.slice(comma + 1) : text});
      };
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }
  async function chosenImages() {
    const files = [...($("images").files || [])];
    if (!files.length) return [];
    if (files.length > 8) { error(new Error("一次最多 8 张图片")); return null; }
    const images = [];
    for (const file of files) {
      if (!imageTypes.has(file.type)) { error(new Error("只能发送 PNG、JPEG、WebP 或 GIF")); return null; }
      if (!file.size || file.size > 8 * 1024 * 1024) { error(new Error("图片超过 8 MB")); return null; }
      images.push(await readImage(file));
    }
    return images;
  }
  $("images").onchange = () => {
    const files = [...($("images").files || [])];
    $("image-note").textContent = files.length ? files.map(file => file.name).join("、") : "";
  };
  $("composer").onsubmit = async event => {
    event.preventDefault(); if (!writable()) return;
    const connection = current, target = connection.session, key = `submit:${target}`;
    if (running.has(key)) return;
    if (!pending) {
      if (!$("prompt").value.trim()) { error(new Error("请输入任务")); return; }
      const mode = $("mode").value;
      const run = connection.model.requests.find(row => row.kind === "root" && row.run_id && !terminal.has(row.status));
      if (mode === "steer" && !run) { error(new Error("当前没有可以引导的任务")); return; }
      const images = await chosenImages();
      if (!images) return;
      savePending({target, request_id:crypto.randomUUID(), text:$("prompt").value, mode, target_run_id:mode === "steer" ? run.run_id : "", images});
    }
    if (pending.target !== target) { error(new Error("请切回原会话重试待确认的请求")); return; }
    const submitted = pending;
    running.add(key); $("error").textContent = ""; controls();
    try {
      const body = {request_id:submitted.request_id, text:submitted.text, mode:submitted.mode || "queue", target_run_id:submitted.target_run_id || ""};
      if (submitted.images?.length) body.images = submitted.images;
      await api(`/api/v1/sessions/${target}/submissions`, "POST", body, connection, connection.identity);
      // A response owned by an old connection leaves the retry ID intact until the
      // current connection explicitly confirms it. It cannot turn a retained draft
      // into a new submission, including A -> B -> A navigation.
      if (owns(connection)) {
        if (pending === submitted) savePending(null);
        if (drafts.get(target) === submitted.text) drafts.delete(target);
        if ($("prompt").value === submitted.text) $("prompt").value = "";
        $("images").value = "";
        $("image-note").textContent = "";
      }
    } catch (failure) {
      if (owns(connection) && definitive(failure) && pending === submitted) savePending(null);
      if (owns(connection)) {
        error(new Error(`${failure.message}${definitive(failure) ? "" : "；再次发送会沿用原请求 ID"}`));
        if (bindingErrors.has(failure.code)) reconnect(connection);
      }
    } finally { running.delete(key); if (current?.session === target) controls(); }
  };
  $("archive").onclick = async () => {
    const connection = current;
    if (!owns(connection) || !connection.ready || health?.state !== "ready") return;
    const next = !archived.get(connection.session);
    $("archive").disabled = true;
    try {
      const value = await api(`/api/v1/sessions/${connection.session}/archive`, "POST", {archived: next}, connection, connection.identity);
      if (!owns(connection)) return;
      archived.set(value.session_id, Boolean(value.archived));
      await load();
    } catch (failure) {
      if (owns(connection)) error(failure);
    } finally {
      if (owns(connection)) controls();
    }
  };
  $("cancel").onclick = () => {
    const row = current?.model.requests.find(item => item.kind === "root" && !terminal.has(item.status));
    if (row) void runAction(`${selected}:cancel:${row.request_id}`, current, `requests/${encodeURIComponent(row.request_id)}/cancel`, {});
  };
  window.addEventListener("pagehide", retire);
  render();
  load().catch(failure => { $("login").hidden = false; error(failure); });
}
