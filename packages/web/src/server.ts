import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { EntryDto, LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient, type RemoteLane } from "@amazme/runtime-service/client";
import { activateProject, executeSlash, finishDrive, parseSlash, SLASH_LIST, type SlashActions } from "@amazme/tui";

export interface WebOptions {
  socket: string;
  serverId: string;
  runtimeId: string;
  lane: string;
  port?: number;
  login?(provider: string, handback: (text: string) => void): Promise<string>;
  logout?(provider: string): Promise<string>;
  catalog?(): Promise<Array<{ id: string; name: string; stored: boolean; oauth: boolean; apiKey: boolean }>>;
  saveApiKey?(providerId: string, key: string): Promise<string>;
  cwd?: string;
}

export interface PageView {
  sessions: string[];
  active: string;
  entries: Array<{ id: string; role: string; text: string; title?: string }>;
  pendingText: string;
  tools: Array<{ name: string; status: string }>;
  busy: boolean;
  notice: string | null;
  provider: string;
  modelId: string;
  thinking: string;
  directory: string;
  models: Array<{ provider: string; modelId: string }>;
  thinkingLevels: string[];
  providers: Array<{ id: string; name: string; stored: boolean; oauth: boolean; apiKey: boolean }>;
  secret: boolean;
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
  if (options.cwd) await activateProject(options.cwd);
  const known = new Set<string>([options.lane]);
  let active = options.lane;
  let lane = remote.lane(active);
  let notice: string | null = null;
  let earlier: EntryDto[] = [];
  let chrome = { provider: "", modelId: "", thinking: "", directory: "", models: [] as Array<{ provider: string; modelId: string }>, thinkingLevels: [] as string[] };
  let account: { providers: PageView["providers"]; secretProvider: string | null } = { providers: [], secretProvider: null };
  const rememberAccount = async (): Promise<void> => {
    if (!options.catalog) return;
    account = { ...account, providers: await options.catalog() };
  };
  const rememberSettings = async (): Promise<void> => {
    try {
      const settings = await lane.configure();
      const listed = await lane.catalog();
      chrome = {
        provider: settings.provider,
        modelId: settings.modelId,
        thinking: settings.thinkingLevel,
        directory: listed.directory,
        models: listed.models,
        thinkingLevels: listed.thinkingLevels,
      };
    } catch {
      // The status line keeps the last settings this lane could report.
    }
    await rememberAccount();
  };
  const listeners = new Set<ServerResponse>();
  let latest = emptyView(options.lane);
  const publish = (snapshot: LaneSnapshotDto): void => {
    const parent = snapshot.entries[0]?.parentId ?? null;
    const tail = earlier.at(-1)?.id;
    if (tail !== undefined && tail !== parent) earlier = [];
    latest = project(snapshot, [...known].sort(), active, earlier, notice, chrome, account);
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
    ...(options.cwd ? { cwd: options.cwd } : {}),
    openWeb: async () => "网页已在当前宿主",
  };
  const server = createServer((request, response) => {
    void handle(request, response, {
      latest: () => latest,
      listeners,
      sessions: async () => {
        for (const name of await remote.conversations()) known.add(name);
        return [...known].sort();
      },
      submit: async (text) => {
        if (account.secretProvider) {
          const providerId = account.secretProvider;
          account = { ...account, secretProvider: null };
          notice = options.saveApiKey ? await options.saveApiKey(providerId, text) : "当前客户端不能保存 API key";
          await rememberAccount();
          publish(subscription.current());
          return;
        }
        await interpret(lane, text, actions, (next) => { notice = next; });
      },
      apiKey: (providerId: string) => {
        account = { ...account, secretProvider: providerId };
        notice = null;
        publish(subscription.current());
      },
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
  if (outcome.type === "submit") {
    setNotice(null);
    const current = await lane.snapshot();
    if (current.operationId) {
      await lane.followUp(outcome.text);
      return;
    }
    const admitted = await lane.accept({ kind: "prompt", text: outcome.text });
    await finishDrive(lane, admitted.operationId);
    return;
  }
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
  apiKey: (providerId: string) => void;
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
    } else if (body.action === "api-key") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error("provider id is invalid");
      actions.apiKey(text);
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
  chrome: { provider: string; modelId: string; thinking: string; directory: string; models: Array<{ provider: string; modelId: string }>; thinkingLevels: string[] },
  account: { providers: PageView["providers"]; secretProvider: string | null },
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
    directory: chrome.directory,
    models: chrome.models,
    thinkingLevels: chrome.thinkingLevels,
    providers: account.providers,
    secret: account.secretProvider !== null,
  };
}

function entryView(entry: EntryDto): { id: string; role: string; text: string; title?: string } {
  if (entry.payload.type === "compaction") return { id: entry.id, role: "summary", text: entry.payload.summary };
  const message = entry.payload.message;
  const named = message as { role: string; toolName?: string };
  const title = named.role === "toolResult" ? named.toolName : undefined;
  return { id: entry.id, role: message.role, text: messageText(message), ...(title ? { title } : {}) };
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
  return {
    sessions: [active], active, entries: [], pendingText: "", tools: [], busy: false, notice: null,
    provider: "", modelId: "", thinking: "", directory: "", models: [], thinkingLevels: [],
    providers: [], secret: false,
  };
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
  aside ul, #tools { list-style: none; padding: 0; margin: 0; }
  aside li { margin: 2px 0; }
  aside button, #abort, form button { font: inherit; border: 0; background: transparent; color: inherit; text-align: left; padding: 6px 8px; border-radius: 8px; }
  aside button[aria-current="true"] { background: #2a3148; color: #c4b5fd; }
  section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #transcript { flex: 1; overflow: auto; padding: 28px 8vw 16px; }
  article { max-width: 720px; margin: 0 auto 18px; }
  article p { margin: 4px 0 0; white-space: pre-wrap; }
  article header { font-size: 12px; }
  article h3 { color: #c4b5fd; font-size: 16px; font-weight: 650; margin: 8px 0 0; }
  article ul { list-style: none; margin: 4px 0 0; padding: 0; }
  article .marker { color: #c4b5fd; margin-right: 0.45em; }
  article code { color: #8b93a7; }
  article.user { border: 1px solid #6b5b4a; border-radius: 12px; padding: 10px 12px; }
  article.user header { color: #e6c8a0; }
  article.assistant header { color: #c4b5fd; }
  article.tool header { color: #c4b5fd; }
  article.tool .status { color: #8b93a7; font-size: 12px; }
  pre, code { font-family: ui-monospace, monospace; }
  pre { background: #12141c; border: 1px solid #3d4a68; border-radius: 8px; padding: 8px; }
  #dock { max-width: 760px; width: calc(100% - 48px); margin: 0 auto 20px; }
  #menu { margin: 0 0 8px; background: #12141c; border: 1px solid #3d4a68; border-radius: 12px; overflow: hidden; }
  #menu:empty { display: none; }
  #menu button { display: block; width: 100%; padding: 8px 12px; background: transparent; color: #8b93a7; }
  #menu button[aria-selected="true"] { background: #2a3148; color: #c4b5fd; }
  #notice { min-height: 0; margin: 0 0 8px; color: #8b93a7; white-space: pre-wrap; }
  #tools { margin: 0 0 8px; color: #8b93a7; font-size: 13px; }
  form { display: flex; gap: 8px; align-items: center; background: #12141c; border: 1px solid #3d4a68; border-radius: 14px; padding: 8px; }
  input, textarea { flex: 1; font: inherit; border: 0; outline: none; padding: 6px 8px; background: transparent; color: #d7dbe7; resize: none; }
  textarea[data-secret="true"] { display: none; }
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
        <span id="mask"></span>
        <input id="key" type="password" hidden autocomplete="off">
        <textarea id="text" rows="2" autocomplete="off" placeholder="给 AmazMe 发消息，/ 打开命令"></textarea>
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
  const mask = document.querySelector("#mask");
  const key = document.querySelector("#key");
  let menuIndex = 0;
  let current = { sessions: [], models: [], thinkingLevels: [], entries: [], tools: [], directory: "", active: "", provider: "", modelId: "", thinking: "", busy: false, pendingText: "", notice: "" };
  function chooserRows(view, input) {
    const token = String(input || "").trim();
    if (token === "/model") return (view.models || []).map((model) => ({ submit: "/model " + model.provider + "/" + model.modelId, label: model.provider + "/" + model.modelId }));
    if (token === "/thinking") return (view.thinkingLevels || []).map((level) => ({ submit: "/thinking " + level, label: level }));
    if (token === "/resume") return (view.sessions || []).map((name) => ({ submit: "/resume " + name, label: name }));
    if (token === "/login") return [
      { submit: "/login account", label: "Sign in with an account", hold: true },
      { submit: "/login api-key", label: "Sign in with an API key", hold: true },
    ];
    if (token === "/login account") return (view.providers || []).filter((provider) => provider.oauth).map((provider) => ({
      submit: "/login " + provider.id,
      label: provider.name + (provider.storedType === "oauth" ? "  ✓ stored" : "  • not configured"),
      hold: Boolean(provider.apiKey),
      providerId: provider.id,
    }));
    if (token === "/login api-key") return (view.providers || []).filter((provider) => provider.apiKey).map((provider) => ({
      submit: "/api-key " + provider.id,
      label: provider.name + (provider.storedType === "api_key" ? "  ✓ stored" : "  • not configured"),
      apiKey: true,
      providerId: provider.id,
    }));
    const login = /^\\/login\\s+(\\S+)\\s*$/.exec(token);
    if (login) {
      const provider = (view.providers || []).find((item) => item.id === login[1]);
      if (!provider) return [];
      const rows = [];
      if (provider.oauth) rows.push({ submit: "/login " + provider.id, label: "Sign in with an account", providerId: provider.id });
      if (provider.apiKey) rows.push({ submit: "/api-key " + provider.id, label: "Sign in with an API key", apiKey: true, providerId: provider.id });
      return rows;
    }
    if (token === "/tree") return (view.entries || []).filter((entry) => entry.text).map((entry) => ({ submit: "/tree " + entry.id, label: (entry.role === "user" ? "你 " : "AmazMe ") + entry.text }));
    return [];
  }
  function messageNodes(text) {
    const nodes = [];
    const lines = String(text || "").split("\\n");
    let fence = null;
    let list = null;
    const flushList = () => { if (list) { nodes.push(list); list = null; } };
    const closeFence = () => {
      flushList();
      const pre = document.createElement("pre");
      pre.textContent = fence.join("\\n");
      nodes.push(pre);
      fence = null;
    };
    for (const line of lines) {
      if (fence) {
        if (line.trim().startsWith("\`\`\`")) closeFence();
        else fence.push(line);
        continue;
      }
      if (line.trim().startsWith("\`\`\`")) { fence = []; continue; }
      const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
      if (heading) {
        flushList();
        const title = document.createElement("h3");
        title.textContent = heading[2];
        title.style.color = "#c4b5fd";
        nodes.push(title);
        continue;
      }
      const bullet = /^\\s*[-*]\\s+(.*)$/.exec(line);
      if (bullet) {
        if (!list) { list = document.createElement("ul"); }
        const item = document.createElement("li");
        const marker = document.createElement("span");
        marker.className = "marker";
        marker.textContent = "•";
        marker.style.color = "#c4b5fd";
        item.append(marker, " " + bullet[1].replace(/\`([^\`]*)\`/g, "$1"));
        list.append(item);
        continue;
      }
      flushList();
      const paragraph = document.createElement("p");
      paragraph.textContent = line.replace(/\`([^\`]*)\`/g, "$1");
      const code = line.match(/\`([^\`]*)\`/);
      if (code) {
        paragraph.textContent = "";
        const bits = line.split("\`");
        bits.forEach((bit, index) => {
          if (!bit) return;
          if (index % 2 === 1) {
            const mark = document.createElement("code");
            mark.textContent = bit;
            mark.style.color = "#8b93a7";
            paragraph.append(mark);
          } else paragraph.append(bit);
        });
      }
      nodes.push(paragraph);
    }
    if (fence) closeFence();
    flushList();
    return nodes;
  }
  const matches = () => {
    const value = text.value.trimStart();
    if (!value.startsWith("/")) return [];
    const token = value.slice(1);
    if (/\\s/.test(token)) return [];
    const query = token.toLowerCase();
    return commands.filter((item) => query.length === 0 || item.name.includes(query));
  };
  const menuRows = () => {
    const chosen = chooserRows(current, text.value);
    if (chosen.length > 0) return chosen.map((row) => ({
      text: row.label,
      submit: row.submit,
      hint: "",
      hold: Boolean(row.hold),
      apiKey: Boolean(row.apiKey),
      providerId: row.providerId,
    }));
    return matches().map((item) => ({
      text: "/" + item.name + (item.hint ? " " + item.hint : "") + "  " + item.description,
      submit: "/" + item.name + (item.hint ? " " : ""),
      hint: item.hint,
      name: item.name,
    }));
  };
  const paintMenu = () => {
    const rows = menuRows();
    if (menuIndex >= rows.length) menuIndex = 0;
    menu.replaceChildren(...rows.slice(0, 8).map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.text;
      if (index === menuIndex) button.setAttribute("aria-selected", "true");
      button.addEventListener("click", () => choose(item));
      return button;
    }));
  };
  const paint = (view) => {
    current = view;
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
    const blocks = view.entries.map((entry) => entry);
    if (view.pendingText) blocks.push({ role: "assistant", text: view.pendingText });
    const articles = blocks.map((entry) => {
      const article = document.createElement("article");
      const role = entry.role;
      if (role === "user") article.className = "user";
      else if (role === "toolResult" || role === "tool") article.className = "tool";
      else article.className = "assistant";
      const header = document.createElement("header");
      header.textContent = role === "user" ? "你" : role === "toolResult" || role === "tool" ? (entry.title || "tool") : "AmazMe";
      article.append(header);
      if (role === "toolResult" || role === "tool") {
        const marker = document.createElement("p");
        marker.className = "status";
        marker.textContent = "result";
        const body = document.createElement("p");
        body.textContent = entry.text;
        article.append(marker, body);
      } else {
        article.append(...messageNodes(entry.text));
      }
      return article;
    });
    for (const tool of view.tools || []) {
      const article = document.createElement("article");
      article.className = "tool";
      const header = document.createElement("header");
      header.textContent = tool.name;
      const marker = document.createElement("p");
      marker.className = "status";
      marker.textContent = tool.status;
      article.append(header, marker);
      articles.push(article);
    }
    transcript.replaceChildren(...articles);
    transcript.scrollTop = transcript.scrollHeight;
    notice.textContent = view.notice || "";
    tools.replaceChildren();
    const model = view.provider && view.modelId ? view.provider + "/" + view.modelId : "";
    status.textContent = [view.directory, view.active, model, view.thinking, view.busy ? "忙" : "空闲"].filter(Boolean).join("  ");
    if (view.secret) {
      text.setAttribute("data-secret", "true");
      text.style.display = "none";
      text.value = "";
      text.textContent = "";
      key.hidden = false;
      key.type = "password";
      key.style.display = "";
      mask.textContent = "•".repeat(String(key.value || "").length);
    } else {
      text.removeAttribute("data-secret");
      text.style.display = "";
      key.hidden = true;
      key.value = "";
      mask.textContent = "";
    }
    paintMenu();
  };
  const source = new EventSource("/events");
  source.onmessage = (event) => paint(JSON.parse(event.data));
  fetch("/view").then((response) => response.json()).then(paint);
  const choose = (item) => {
    if (item.apiKey) {
      text.value = "";
      act("api-key", item.providerId);
      return;
    }
    if (item.hold) {
      text.value = item.submit + " ";
      text.focus();
      paintMenu();
      return;
    }
    if (item.submit.startsWith("/model ") || item.submit.startsWith("/thinking ") || item.submit.startsWith("/resume ") || item.submit.startsWith("/login ") || item.submit.startsWith("/tree ") || !item.hint) {
      act("submit", item.submit.trim());
      return;
    }
    text.value = item.submit;
    text.focus();
    paintMenu();
  };
  const act = (action, value) => fetch("/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, text: value ?? (current.secret ? key.value : text.value) }),
  }).then((response) => response.json()).then((view) => {
    paint(view);
    if (action === "submit" || action === "api-key") {
      text.value = "";
      if (!view.secret) key.value = "";
    }
    paintMenu();
  });
  text.addEventListener("input", () => { menuIndex = 0; paintMenu(); });
  key.addEventListener("input", () => {
    if (!current.secret) return;
    mask.textContent = "•".repeat(String(key.value || "").length);
  });
  text.addEventListener("keydown", (event) => {
    const rows = menuRows();
    if (rows.length === 0) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        act("submit");
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menuIndex = (menuIndex + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paintMenu();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const picked = rows[menuIndex];
      if (picked) text.value = picked.submit;
      paintMenu();
    } else if (event.key === "Enter" && !event.shiftKey) {
      const picked = rows[menuIndex];
      const token = text.value.trim();
      if (picked && picked.submit !== token) {
        event.preventDefault();
        choose(picked);
      }
    }
  });
  document.querySelector("#form").addEventListener("submit", (event) => { event.preventDefault(); act("submit"); });
  document.querySelector("#abort").addEventListener("click", () => act("abort", ""));
  globalThis.paint = paint;
  globalThis.chooserRows = chooserRows;
</script>
`;
