import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { EntryDto, LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient, type RemoteLane } from "@amazme/runtime-service/client";
import { executeSlash, finishDrive, parseSlash, SLASH_LIST, type SlashActions } from "@amazme/tui";

export interface WebOptions {
  socket: string;
  serverId: string;
  runtimeId: string;
  lane: string;
  port?: number;
  login?(provider: string, handback: (text: string) => void): Promise<string>;
  logout?(provider: string): Promise<string>;
}

export interface PageView {
  sessions: string[];
  active: string;
  entries: Array<{ id: string; role: string; text: string }>;
  pendingText: string;
  tools: Array<{ name: string; status: string }>;
  busy: boolean;
  notice: string | null;
  provider: string;
  modelId: string;
  thinking: string;
}

export interface WebServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Loopback page for one host. The page is a client: it does not own the log, tools, or model.
 * Only `127.0.0.1` and `localhost` are accepted.
 */
export async function startWeb(options: WebOptions): Promise<WebServer> {
  const client = new Client({ serverId: options.serverId, transport: createUnixTransport({ path: options.socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(options.runtimeId);
  const known = new Set<string>([options.lane]);
  let active = options.lane;
  let lane = remote.lane(active);
  let notice: string | null = null;
  let earlier: EntryDto[] = [];
  let chrome = { provider: "", modelId: "", thinking: "" };
  const rememberSettings = async (): Promise<void> => {
    try {
      const settings = await lane.configure();
      chrome = { provider: settings.provider, modelId: settings.modelId, thinking: settings.thinkingLevel };
    } catch {
      // The status line keeps the last settings this lane could report.
    }
  };
  const listeners = new Set<ServerResponse>();
  let latest = emptyView(options.lane);
  const publish = (snapshot: LaneSnapshotDto): void => {
    const parent = snapshot.entries[0]?.parentId ?? null;
    const tail = earlier.at(-1)?.id;
    if (tail !== undefined && tail !== parent) earlier = [];
    latest = project(snapshot, [...known].sort(), active, earlier, notice, chrome);
    const frame = `data: ${JSON.stringify(latest)}\n\n`;
    for (const response of listeners) response.write(frame);
  };
  let subscription = await lane.subscribe(publish);
  await rememberSettings();
  publish(subscription.current());
  const openLane = async (name: string): Promise<void> => {
    known.add(name);
    earlier = [];
    await subscription.close();
    active = name;
    lane = remote.lane(active);
    subscription = await lane.subscribe(publish);
    await rememberSettings();
    publish(subscription.current());
  };
  const actions: SlashActions = {
    lane: () => lane,
    active: () => active,
    list: async () => {
      for (const name of await remote.conversations()) known.add(name);
      return [...known].sort();
    },
    open: (name) => openLane(name),
    earlier: async () => {
      const snap = subscription.current();
      const oldest = earlier[0]?.id ?? snap.entries[0]?.id;
      if (!oldest) return "没有更早的条目";
      const page = await lane.history(oldest, 20);
      const seen = new Set([...earlier, ...snap.entries].map((entry) => entry.id));
      const added = page.entries.filter((entry) => !seen.has(entry.id));
      earlier = [...added, ...earlier];
      publish(snap);
      return added.length === 0 ? "没有更早的条目" : `更早 ${added.length} 条`;
    },
    continueRetry: async () => {
      const snap = await lane.snapshot();
      if (snap.phase !== "retry_wait" || !snap.operationId) return "没有等待中的重试";
      await finishDrive(lane, snap.operationId);
      return "已继续";
    },
    ...(options.login
      ? {
          login: (provider: string) => options.login!(provider, (text) => {
            notice = text;
            publish(subscription.current());
          }),
        }
      : {}),
    ...(options.logout ? { logout: (provider: string) => options.logout!(provider) } : {}),
  };
  const server = createServer((request, response) => {
    void handle(request, response, {
      latest: () => latest,
      listeners,
      sessions: async () => {
        for (const name of await remote.conversations()) known.add(name);
        return [...known].sort();
      },
      submit: (text) => interpret(lane, text, actions, (text) => { notice = text; }),
      abort: async () => {
        const operationId = subscription.current().operationId;
        if (operationId) await lane.requestAbort(operationId);
      },
      refresh: async () => {
        await rememberSettings();
        const snap = await lane.snapshot();
        publish(snap);
        for (const name of await remote.conversations()) known.add(name);
        return { ...latest, sessions: [...known].sort() };
      },
      open: (name) => openLane(name),
    }).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) return;
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the web server did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      for (const response of listeners) response.end();
      listeners.clear();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await subscription.close();
      await client.dispose();
    },
  };
}

async function interpret(lane: RemoteLane, text: string, actions: SlashActions, setNotice: (text: string | null) => void): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const parsed = parseSlash(body);
  if (parsed.type === "prompt") {
    setNotice(null);
    const current = await lane.snapshot();
    if (current.operationId) {
      await lane.followUp(parsed.text);
      return;
    }
    const admitted = await lane.accept({ kind: "prompt", text: parsed.text });
    await finishDrive(lane, admitted.operationId);
    return;
  }
  if (parsed.type === "notice") {
    setNotice(parsed.text);
    return;
  }
  const outcome = await executeSlash(parsed, actions);
  if (outcome.type === "quit") {
    setNotice("关闭页面不会停止宿主");
    return;
  }
  if (outcome.type === "notice") setNotice(outcome.text);
}

interface Actions {
  latest: () => PageView;
  listeners: Set<ServerResponse>;
  sessions: () => Promise<string[]>;
  submit: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  open: (name: string) => Promise<void>;
  refresh: () => Promise<PageView>;
}

async function handle(request: IncomingMessage, response: ServerResponse, actions: Actions): Promise<void> {
  const host = request.headers.host ?? "";
  const port = host.split(":").at(-1);
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("the web client accepts only loopback");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml());
    return;
  }
  if (request.method === "GET" && url.pathname === "/view") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(await actions.refresh()));
    return;
  }
  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify(actions.latest())}\n\n`);
    actions.listeners.add(response);
    response.on("close", () => actions.listeners.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/act") {
    const body = JSON.parse(await readBody(request)) as { action?: string; text?: string };
    const text = typeof body.text === "string" ? body.text : "";
    if (body.action === "submit") await actions.submit(text);
    else if (body.action === "abort") await actions.abort();
    else if (body.action === "open") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error("session name is invalid");
      await actions.open(text);
    } else throw new Error("unknown action");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(await actions.refresh()));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
}

function project(
  snapshot: LaneSnapshotDto,
  sessions: string[],
  active: string,
  earlier: EntryDto[],
  notice: string | null,
  chrome: { provider: string; modelId: string; thinking: string },
): PageView {
  const seen = new Set(snapshot.entries.map((entry) => entry.id));
  return {
    sessions,
    active,
    entries: [...earlier.filter((entry) => !seen.has(entry.id)).map(entryView), ...snapshot.entries.map(entryView)],
    pendingText: pendingText(snapshot),
    tools: snapshot.tools.map((tool) => ({ name: tool.name, status: tool.status })),
    busy: snapshot.operationId !== null,
    notice,
    provider: chrome.provider,
    modelId: chrome.modelId,
    thinking: chrome.thinking,
  };
}

function entryView(entry: EntryDto): { id: string; role: string; text: string } {
  if (entry.payload.type === "compaction") return { id: entry.id, role: "summary", text: entry.payload.summary };
  const message = entry.payload.message;
  return { id: entry.id, role: message.role, text: messageText(message) };
}

function pendingText(snapshot: LaneSnapshotDto): string {
  const pending = snapshot.pendingResponse;
  if (!pending) return "";
  return pending.content.map((block) => {
    const text = (block as { text?: unknown }).text;
    return block.type === "text" && typeof text === "string" ? text : "";
  }).join("");
}

function messageText(message: { role: string; content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as { type?: string; text?: string; name?: string };
    if (record.type === "text" && typeof record.text === "string") return record.text;
    if (record.type === "toolCall" && typeof record.name === "string") return record.name;
    return "";
  }).join("");
}

function emptyView(active: string): PageView {
  return { sessions: [active], active, entries: [], pendingText: "", tools: [], busy: false, notice: null, provider: "", modelId: "", thinking: "" };
}

function pageHtml(): string {
  const commands = JSON.stringify(SLASH_LIST.map((item) => ({ name: item.name, hint: item.hint, description: item.description })));
  return PAGE.replace("/*__COMMANDS__*/", commands);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("the action body exceeds 64 KiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>AmazMe</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #d7dbe7; background: #1b1e27; }
  main { display: grid; grid-template-columns: 220px 1fr; height: 100%; }
  aside { padding: 20px 16px; border-right: 1px solid #2e3448; background: #161922; }
  aside h1, #status { font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; color: #8b93a7; margin: 0 0 12px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin: 2px 0; }
  aside button, #abort, form button { font: inherit; border: 0; background: transparent; color: inherit; text-align: left; padding: 6px 8px; border-radius: 8px; }
  aside button[aria-current="true"] { background: #2a3148; color: #c4b5fd; }
  section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #transcript { flex: 1; overflow: auto; padding: 28px 8vw 16px; }
  article { max-width: 720px; margin: 0 auto 18px; }
  article p { margin: 4px 0 0; white-space: pre-wrap; }
  article header { font-size: 12px; color: #a5b4fc; }
  #dock { max-width: 760px; width: calc(100% - 48px); margin: 0 auto 20px; }
  #menu { margin: 0 0 8px; background: #12141c; border: 1px solid #3d4a68; border-radius: 12px; overflow: hidden; }
  #menu:empty { display: none; }
  #menu button { display: block; width: 100%; padding: 8px 12px; background: transparent; color: #8b93a7; }
  #menu button[aria-selected="true"] { background: #2a3148; color: #c4b5fd; }
  #notice { min-height: 0; margin: 0 0 8px; color: #8b93a7; white-space: pre-wrap; }
  #tools { margin: 0 0 8px; color: #8b93a7; font-size: 13px; }
  form { display: flex; gap: 8px; align-items: center; background: #12141c; border: 1px solid #3d4a68; border-radius: 14px; padding: 8px; }
  input { flex: 1; font: inherit; border: 0; outline: none; padding: 6px 8px; background: transparent; color: #d7dbe7; }
  #abort, form button { background: #c4b5fd; color: #161922; }
</style>
<main>
  <aside>
    <h1>会话</h1>
    <ul id="sessions"></ul>
  </aside>
  <section>
    <div id="transcript"></div>
    <div id="dock">
      <div id="menu"></div>
      <p id="notice"></p>
      <ul id="tools"></ul>
      <p id="status"></p>
      <form id="form">
        <input id="text" autocomplete="off" placeholder="给 AmazMe 发消息，/ 打开命令">
        <button type="submit">发送</button>
        <button type="button" id="abort">中止</button>
      </form>
    </div>
  </section>
</main>
<script>
  const commands = /*__COMMANDS__*/;
  const sessions = document.querySelector("#sessions");
  const transcript = document.querySelector("#transcript");
  const tools = document.querySelector("#tools");
  const notice = document.querySelector("#notice");
  const menu = document.querySelector("#menu");
  const status = document.querySelector("#status");
  const text = document.querySelector("#text");
  let menuIndex = 0;
  const label = (role) => role === "user" ? "你" : role === "assistant" ? "AmazMe" : role === "toolResult" || role === "tool" ? "工具" : "记录";
  const matches = () => {
    const value = text.value.trimStart();
    if (!value.startsWith("/")) return [];
    const token = value.slice(1);
    if (/\\s/.test(token)) return [];
    const query = token.toLowerCase();
    return commands.filter((item) => query.length === 0 || item.name.includes(query));
  };
  const paintMenu = () => {
    const rows = matches();
    if (menuIndex >= rows.length) menuIndex = 0;
    menu.replaceChildren(...rows.slice(0, 8).map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "/" + item.name + (item.hint ? " " + item.hint : "") + "  " + item.description;
      if (index === menuIndex) button.setAttribute("aria-selected", "true");
      button.addEventListener("click", () => {
        text.value = "/" + item.name + (item.hint ? " " : "");
        text.focus();
        paintMenu();
      });
      return button;
    }));
  };
  const paint = (view) => {
    sessions.replaceChildren(...view.sessions.map((name) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      if (name === view.active) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => act("open", name));
      item.append(button);
      return item;
    }));
    const blocks = view.entries.map((entry) => ({ role: entry.role, text: entry.text }));
    if (view.pendingText) blocks.push({ role: "assistant", text: view.pendingText });
    transcript.replaceChildren(...blocks.map((entry) => {
      const article = document.createElement("article");
      const header = document.createElement("header");
      header.textContent = label(entry.role);
      const body = document.createElement("p");
      body.textContent = entry.text;
      article.append(header, body);
      return article;
    }));
    transcript.scrollTop = transcript.scrollHeight;
    notice.textContent = view.notice || "";
    tools.replaceChildren(...view.tools.map((tool) => {
      const item = document.createElement("li");
      item.textContent = tool.name + " " + tool.status;
      return item;
    }));
    const model = view.provider && view.modelId ? view.provider + "/" + view.modelId : "";
    status.textContent = [view.active, model, view.thinking, view.busy ? "忙" : "空闲"].filter(Boolean).join("  ");
    paintMenu();
  };
  const source = new EventSource("/events");
  source.onmessage = (event) => paint(JSON.parse(event.data));
  fetch("/view").then((response) => response.json()).then(paint);
  const act = (action, value) => fetch("/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, text: value ?? text.value }),
  }).then((response) => response.json()).then((view) => {
    paint(view);
    if (action === "submit") text.value = "";
    paintMenu();
  });
  text.addEventListener("input", () => { menuIndex = 0; paintMenu(); });
  text.addEventListener("keydown", (event) => {
    const rows = matches();
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menuIndex = (menuIndex + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paintMenu();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const picked = rows[menuIndex];
      if (picked) text.value = "/" + picked.name + (picked.hint ? " " : "");
      paintMenu();
    } else if (event.key === "Enter" && !event.shiftKey) {
      const picked = rows[menuIndex];
      const token = text.value.trim();
      if (picked && token.slice(1).toLowerCase() !== picked.name) {
        event.preventDefault();
        text.value = "/" + picked.name + (picked.hint ? " " : "");
        if (!picked.hint) act("submit");
        paintMenu();
      }
    }
  });
  document.querySelector("#form").addEventListener("submit", (event) => { event.preventDefault(); act("submit"); });
  document.querySelector("#abort").addEventListener("click", () => act("abort", ""));
</script>
`;
