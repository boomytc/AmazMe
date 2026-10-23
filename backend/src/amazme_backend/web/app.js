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
  let fileDir = "", filePath = "", fileDigest = "", fileWorkspace = "";
  const fileJoin = (dir, name) => dir ? `${dir}/${name}` : name;
  async function loadWorkspaces() {
    const listed = await api("/api/v1/workspaces");
    $("workspace-list").replaceChildren(...listed.workspaces.map(item => button(item.primary ? "主工作区" : item.name, () => {
      fileWorkspace = item.primary ? "" : item.name;
      fileDir = item.primary ? "" : `grant/${item.name}`;
      filePath = "";
      void loadFiles().catch(error);
    })));
    const current = listed.workspaces.find(item => (item.primary && !fileWorkspace) || item.name === fileWorkspace);
    if (current) $("workspace-guest").textContent = current.guest_path;
  }
  async function loadFiles() {
    const listing = await api(fileDir ? `/api/v1/files?path=${encodeURIComponent(fileDir)}` : "/api/v1/files");
    if (listing.guest_path) $("workspace-guest").textContent = listing.guest_path;
    const nodes = [];
    if (fileDir) nodes.push(button("上级", () => { fileDir = fileDir.split("/").slice(0, -1).join("/"); void loadFiles().catch(error); }));
    for (const item of listing.entries) {
      if (item.kind === "dir") nodes.push(button(`${item.name}/`, () => { fileDir = fileJoin(fileDir, item.name); void loadFiles().catch(error); }));
      else if (item.kind === "file") nodes.push(button(item.name, () => void openFile(fileJoin(fileDir, item.name))));
    }
    if (listing.truncated) nodes.push(element("p", "只显示前 200 项", "muted"));
    $("file-list").replaceChildren(...nodes);
  }
  async function openFile(name) {
    const file = await api(`/api/v1/files/content?path=${encodeURIComponent(name)}`);
    filePath = file.path; fileDigest = file.truncated ? "" : file.digest;
    $("file-content").value = file.content;
    $("file-save").disabled = file.truncated;
    $("file-diff").textContent = file.truncated ? "文件过大，只显示前一部分" : "";
  }
  $("files").addEventListener("toggle", () => { if ($("files").open) void loadWorkspaces().then(loadFiles).catch(error); });
  $("workspace-form").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    try {
      const created = await api("/api/v1/workspaces", "POST", {name: $("workspace-name").value, host_path: $("workspace-path").value}, current);
      fileWorkspace = created.name;
      fileDir = `grant/${created.name}`;
      $("workspace-guest").textContent = created.guest_path;
      await loadWorkspaces();
      await loadFiles();
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let terminalId = "";
  async function showTerminal(view) {
    $("terminal-output").textContent = view.output || "";
    if (view.exit_code !== null && view.exit_code !== undefined) $("terminal-output").textContent += `\n[退出 ${view.exit_code}]`;
  }
  $("terminal").addEventListener("toggle", () => {
    if (!$("terminal").open || !selected || !identity || health?.state !== "ready") return;
    terminalId = crypto.randomUUID().replaceAll("-", "");
    api(`/api/v1/sessions/${selected}/terminals`, "POST", {terminal_id: terminalId, command: "sh", cols: 80, rows: 24, workspace: fileWorkspace}, current)
      .then(showTerminal).catch(error);
  });
  $("terminal-form").onsubmit = async event => {
    event.preventDefault();
    if (!terminalId || !selected) return;
    const typed = $("terminal-input").value;
    try {
      await api(`/api/v1/sessions/${selected}/terminals/${terminalId}/input`, "POST",
        {input_id: crypto.randomUUID().replaceAll("-", ""), data: `${typed}\n`}, current);
      showTerminal(await api(`/api/v1/sessions/${selected}/terminals/${terminalId}/read`, "POST", {}, current));
      $("terminal-input").value = "";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  let mcpServer = "", mcpCall = "", mcpDigest = "";
  function showMcp(view) {
    $("mcp-tools").replaceChildren(...(view.tools || []).map(tool => button(tool.name, () => {
      mcpCall = crypto.randomUUID().replaceAll("-", "");
      api(`/api/v1/sessions/${selected}/mcp/${mcpServer}/calls`, "POST", {call_id: mcpCall, name: tool.name, arguments: {text: "hi"}}, current)
        .then(call => { mcpDigest = call.digest; $("mcp-approval").textContent = call.phase === "waiting_approval" ? "等待批准" : call.result; })
        .catch(error);
    })));
    if (view.exit_code !== null && view.exit_code !== undefined) $("mcp-result").textContent = `退出 ${view.exit_code}`;
  }
  $("mcp-form").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    mcpServer = crypto.randomUUID().replaceAll("-", "");
    try {
      showMcp(await api(`/api/v1/sessions/${selected}/mcp`, "POST", {server_id: mcpServer, command: $("mcp-command").value}, current));
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("mcp-approval").onclick = async () => {
    if (!mcpServer || !mcpCall || !mcpDigest) return;
    try {
      const call = await api(`/api/v1/sessions/${selected}/mcp/${mcpServer}/calls/${mcpCall}/decision`, "POST",
        {decision_id: crypto.randomUUID().replaceAll("-", ""), approve: true, digest: mcpDigest}, current);
      $("mcp-result").textContent = call.result;
      $("mcp-approval").textContent = "";
    } catch (failure) { error(failure); }
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
  $("web-search").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/web/calls`, "POST", {
        call_id: crypto.randomUUID().replaceAll("-", ""), kind: "search", query: $("web-query").value,
      }, current);
      $("web-state").textContent = `${view.phase} · ${view.error || view.result}`;
      $("error").textContent = "";
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
  $("computer-act").onsubmit = async event => {
    event.preventDefault();
    if (!selected || !computerCapture || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/computer/actions`, "POST", {
        action_id: crypto.randomUUID().replaceAll("-", ""), capture_id: computerCapture,
        x: Number($("computer-x").value), y: Number($("computer-y").value),
      }, current);
      $("computer-state").textContent = `${view.phase} · ${view.driver_x},${view.driver_y}`;
      $("error").textContent = "";
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
    try {
      await api("/api/v1/memories", "POST", {
        memory_id: crypto.randomUUID().replaceAll("-", ""), workspace, text: $("memory-text").value,
      }, current);
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
  $("plugin-call").onsubmit = async event => {
    event.preventDefault();
    if (!pluginId || !selected || !identity) return;
    try {
      const call = await api(`/api/v1/sessions/${selected}/plugins/${pluginId}/calls`, "POST",
        {call_id: crypto.randomUUID().replaceAll("-", ""), text: $("plugin-text").value}, current);
      $("plugin-result").textContent = call.phase === "done" ? call.result : call.phase;
      $("error").textContent = "";
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
  let manageProject = "";
  $("manage-project").onsubmit = async event => {
    event.preventDefault();
    if (!identity || health?.state !== "ready") return;
    manageProject = manageProject || crypto.randomUUID().replaceAll("-", "");
    try {
      const project = await api("/api/v1/projects", "POST", {project_id: manageProject, name: $("manage-project-name").value}, current);
      const session = await api("/api/v1/sessions", "POST", {title: project.name, project_id: project.project_id}, current);
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
    try {
      const saved = await api("/api/v1/feedback", "POST", {
        feedback_id: crypto.randomUUID().replaceAll("-", ""), session_id: selected, text: $("manage-feedback-text").value,
      }, current);
      $("manage-state").textContent = saved.session_id;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("manage-share").onclick = async () => {
    if (!selected || !identity || health?.state !== "ready") return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/shares`, "POST", {
        share_id: crypto.randomUUID().replaceAll("-", ""),
      }, current);
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
  $("code-run").onclick = async () => {
    if (!selected || !identity || health?.state !== "ready") return;
    codeRun = crypto.randomUUID().replaceAll("-", "");
    try {
      const view = await api(`/api/v1/sessions/${selected}/code`, "POST", {run_id: codeRun, source: $("code-source").value}, current);
      $("code-result").textContent = view.phase === "success" ? view.value : view.phase;
      $("code-state").textContent = view.phase === "success" ? view.state : "";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("code-cancel").onclick = async () => {
    if (!codeRun || !selected) return;
    try {
      const view = await api(`/api/v1/sessions/${selected}/code/${codeRun}/cancel`, "POST", {}, current);
      $("code-result").textContent = view.phase;
      if (view.phase !== "success") $("code-state").textContent = "";
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
  $("remote-command").onsubmit = async event => {
    event.preventDefault();
    if (!remoteId || !selected) return;
    try {
      const call = await api(`/api/v1/sessions/${selected}/remotes/${remoteId}/calls`, "POST",
        {...remoteBody(), call_id: crypto.randomUUID().replaceAll("-", ""), command: $("remote-run").value}, current);
      $("remote-result").textContent = call.result || call.phase;
      $("error").textContent = "";
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
    if (!mcpServer) return;
    try {
      showMcp(await api(`/api/v1/sessions/${selected}/mcp/${mcpServer}/cancel`, "POST",
        {server_id: mcpServer, command: $("mcp-command").value}, current));
    } catch (failure) { error(failure); }
  };
  $("terminal-resize").onclick = async () => {
    if (!terminalId || !selected) return;
    try {
      showTerminal(await api(`/api/v1/sessions/${selected}/terminals/${terminalId}/resize`, "POST", {cols: 100, rows: 40}, current));
    } catch (failure) { error(failure); }
  };
  let checkpointId = "";
  $("checkpoint-save").onclick = async () => {
    if (!filePath || !identity || health?.state !== "ready") return;
    checkpointId = crypto.randomUUID().replaceAll("-", "");
    const workspace = filePath.startsWith("grant/") ? filePath.split("/")[1] : "primary";
    try {
      const view = await api("/api/v1/checkpoints", "POST", {checkpoint_id: checkpointId, workspace, path: filePath}, current);
      $("file-diff").textContent = `已保存 ${view.digest.slice(0, 12)}`;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("checkpoint-preview").onclick = async () => {
    if (!checkpointId) return;
    try {
      const view = await api(`/api/v1/checkpoints/${checkpointId}`);
      $("file-diff").textContent = view.diff || "与当前文件相同";
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("checkpoint-restore").onclick = async () => {
    if (!checkpointId || !fileDigest) return;
    try {
      const changed = await api(`/api/v1/checkpoints/${checkpointId}/restore`, "POST", {expected_digest: fileDigest}, current);
      fileDigest = changed.digest;
      $("file-diff").textContent = changed.diff;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("file-save").onclick = async () => {
    if (!filePath || !identity || health?.state !== "ready") return;
    try {
      const change = await api("/api/v1/files/content", "POST", {path: filePath, content: $("file-content").value, expected_digest: fileDigest});
      fileDigest = change.digest;
      $("file-diff").textContent = change.diff;
      $("error").textContent = "";
    } catch (failure) { error(failure); }
  };
  $("create").onclick = async () => {
    $("create").disabled = true;
    try {
      const workspace = namedTarget().workspace || "primary";
      const value = await api("/api/v1/sessions", "POST", {title:"工作区任务", workspace});
      const bound = value.workspace || workspace;
      if (!identity?.profile_id) throw new Error("请在地址中写明宿主、会话和工作区");
      rememberWindow(value.session_id, bound, identity.profile_id);
      await load();
      if (selected !== value.session_id) await select(value.session_id);
    }
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
