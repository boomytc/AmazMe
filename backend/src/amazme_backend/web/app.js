import {validate} from "/contract.js";

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
    if (!owns(connection) || !writable()) return;
    const key = `compact:${connection.session}:${requestId}`;
    if (running.has(key)) return;
    running.add(key); controls();
    try {
      const value = await api(`/api/v1/sessions/${connection.session}/compactions`, "POST",
        {compaction_id: crypto.randomUUID(), through_request_id: requestId}, connection, connection.identity);
      if (!owns(connection) || !connection.model) return;
      connection.model = {...connection.model, compaction: value.summary};
      render();
    } catch (failure) {
      if (owns(connection)) error(failure);
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
      article.append(element("div", `${row.kind === "child" ? "子任务 · " : row.kind === "steer" ? "引导 · " : ""}${row.text}`, "question"),
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
  async function select(id, resume = false) {
    if (selected) drafts.set(selected, $("prompt").value);
    const cached = resume && current?.session === id ? current.model : null;
    retire(); selected = id; const binding = ++generation;
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
  }
  async function load() {
    identity = await api("/api/v1/bootstrap"); health = {state:identity.state}; $("login").hidden = true;
    await loadModels();
    const value = await api("/api/v1/sessions");
    archived.clear();
    for (const item of value.sessions) archived.set(item.session_id, Boolean(item.archived));
    $("sessions").replaceChildren(...value.sessions.map(item => button(item.archived ? `${item.title}（已归档）` : item.title, () => void select(item.session_id))));
    if (!selected && value.sessions.length) await select(value.sessions.some(item => item.session_id === pending?.target) ? pending.target : value.sessions[0].session_id);
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
  $("create").onclick = async () => {
    $("create").disabled = true;
    try { const value = await api("/api/v1/sessions", "POST", {title:"工作区任务"}); await load(); await select(value.session_id); }
    catch (failure) { error(failure); } finally { controls(); }
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
      savePending({target, request_id:crypto.randomUUID(), text:$("prompt").value, mode, target_run_id:mode === "steer" ? run.run_id : ""});
    }
    if (pending.target !== target) { error(new Error("请切回原会话重试待确认的请求")); return; }
    const submitted = pending;
    running.add(key); $("error").textContent = ""; controls();
    try {
      await api(`/api/v1/sessions/${target}/submissions`, "POST", {request_id:submitted.request_id, text:submitted.text, mode:submitted.mode || "queue", target_run_id:submitted.target_run_id || ""}, connection, connection.identity);
      // A response owned by an old connection leaves the retry ID intact until the
      // current connection explicitly confirms it. It cannot turn a retained draft
      // into a new submission, including A -> B -> A navigation.
      if (owns(connection)) {
        if (pending === submitted) savePending(null);
        if (drafts.get(target) === submitted.text) drafts.delete(target);
        if ($("prompt").value === submitted.text) $("prompt").value = "";
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
