import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { startCodingBridge } from "../../coding-agent/src/bridge.ts";
import { saveApiKey } from "../../coding-agent/src/login.ts";
import { startCodingHost } from "../../coding-agent/src/host.ts";

test("the page shows choosers, a masked key, a live reply, and leaves the host running", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-client-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  const models = createModels();
  models.setProvider(fauxProvider({ respond: () => fauxAssistant("from-web") }));
  const credentials = join(cwd, "credentials.json");
  await saveApiKey("anthropic", "sk-stored", credentials);
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const page = await startCodingBridge({ socket, port: 0, credentialsFile: credentials });
  t.after(() => page.close());
  const hello = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "hello" }),
  });
  assert.equal(hello.status, 200);
  const live = await (await fetch(`${page.url}view`)).json() as PagePayload;
  assert.ok(live.providers.some((provider) => provider.id === "anthropic" && provider.stored));
  assert.ok(live.providers.some((provider) => provider.id === "openai" && !provider.stored && provider.apiKey));
  assert.ok(live.entries.some((entry) => entry.text === "hello"));
  assert.ok(live.entries.some((entry) => entry.text === "from-web"));
  const html = await (await fetch(page.url)).text();
  assert.match(html, /textarea\[data-secret="true"\] \{ display: none/);
  const painted = drivePage(html, live);
  assert.match(painted.status, /faux\/faux-1/);
  assert.match(painted.status, /off/);
  assert.match(painted.status, /空闲/);
  assert.match(painted.pending, /from-web/);
  assert.equal(painted.menuCount <= 8, true);
  assert.match(painted.loginStored, /stored/);
  assert.match(painted.loginOpen, /not configured/);
  assert.equal(painted.modelSubmit, "/model faux/faux-1");
  assert.equal(painted.thinkingSubmit, "/thinking off");
  assert.equal(painted.resumeSubmit, "/resume main");
  assert.match(painted.treeLabel, /hello|from-web/);
  const hidden = await enterApiKey(html, page.url, "sk-secret");
  assert.equal(hidden.textDisplay, "none");
  assert.equal(hidden.textValue, "");
  assert.equal(hidden.textContent.includes("sk-secret"), false);
  assert.equal(hidden.keyType, "password");
  assert.equal(hidden.mask.includes("sk-secret"), false);
  assert.match(hidden.mask, /•/);
  const saved = await hidden.finish();
  assert.equal(saved.echoed.includes("sk-secret"), false);
  assert.equal(JSON.stringify(saved.view).includes("sk-secret"), false);
  assert.ok(saved.view.providers.some((provider) => provider.id === "openai" && provider.stored));
  const quit = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "/quit" }),
  });
  const left = await quit.json() as { notice: string | null };
  assert.match(left.notice ?? "", /不会停止宿主/);
  const client = new Client({ serverId: "amazme", transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach("workspace");
  const snapshot = await remote.lane("main").snapshot();
  assert.equal(snapshot.lane, "main");
});

interface PagePayload {
  secret: boolean;
  providers: Array<{ id: string; name: string; stored: boolean; oauth: boolean; apiKey: boolean }>;
  entries: Array<{ id: string; role: string; text: string }>;
  notice: string | null;
}

function drivePage(html: string, view: PagePayload): {
  status: string; pending: string; menuCount: number; loginStored: string; loginOpen: string;
  modelSubmit: string; thinkingSubmit: string; resumeSubmit: string; treeLabel: string;
} {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  const document = fakeDocument();
  const context = createContext({
    document,
    EventSource: class { constructor() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(view) }),
    console,
  });
  new Script(script).runInContext(context);
  const text = document.querySelector("#text");
  if (!text) throw new Error("the page is missing the composer");
  const paint = (context as { paint: (value: PagePayload) => void }).paint;
  const chooserRows = (context as { chooserRows: (value: PagePayload, input: string) => Array<{ submit: string; label: string }> }).chooserRows;
  paint(view);
  text.value = "/";
  text.listeners.input?.forEach((listener) => listener({ preventDefault() {} }));
  const transcript = document.querySelector("#transcript");
  const articles = transcript?.querySelectorAll("article") ?? [];
  return {
    status: document.querySelector("#status")?.textContent ?? "",
    pending: articles.map((node) => nodeText(node)).join("\n"),
    menuCount: document.querySelector("#menu")?.querySelectorAll("button").length ?? 0,
    loginStored: chooserRows(view, "/login").find((row) => row.submit.endsWith("anthropic"))?.label ?? "",
    loginOpen: chooserRows(view, "/login").find((row) => row.submit.endsWith("openai"))?.label ?? "",
    modelSubmit: chooserRows(view, "/model").find((row) => row.submit.includes("faux/faux-1"))?.submit ?? "",
    thinkingSubmit: chooserRows(view, "/thinking").find((row) => row.submit.endsWith("off"))?.submit ?? "",
    resumeSubmit: chooserRows(view, "/resume").find((row) => row.submit.endsWith("main"))?.submit ?? "",
    treeLabel: chooserRows(view, "/tree").map((row) => row.label).join("\n"),
  };
}

async function enterApiKey(html: string, pageUrl: string, secret: string): Promise<{
  textDisplay: string; textValue: string; textContent: string; keyType: string; mask: string;
  finish(): Promise<{ echoed: string; view: PagePayload }>;
}> {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  const document = fakeDocument();
  const posted: string[] = [];
  let inflight: Promise<unknown> = Promise.resolve();
  let echoed = "";
  const context = createContext({
    document,
    EventSource: class { constructor() {} },
    fetch: (url: string, init?: { body?: string; method?: string; headers?: Record<string, string> }) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw) posted.push(raw);
      const task = globalThis.fetch(new URL(String(url), pageUrl), init).then(async (response) => {
        echoed = await response.clone().text();
        return response;
      });
      inflight = task;
      return task;
    },
    console,
  });
  new Script(script).runInContext(context);
  const settle = async (): Promise<void> => {
    await inflight;
    await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();
  const text = document.querySelector("#text");
  const key = document.querySelector("#key");
  const form = document.querySelector("#form");
  if (!text || !key || !form) throw new Error("the page is missing the composer");
  text.value = "/login openai";
  fire(text, "input");
  const buttons = document.querySelector("#menu")?.querySelectorAll("button") ?? [];
  const button = buttons.find((node) => node.textContent.includes("API key"));
  if (!button) throw new Error(`no API key row: ${buttons.map((node) => node.textContent).join(" | ")}`);
  fire(button, "click");
  const started = posted.at(-1) ?? "";
  if (!started.includes("\"api-key\"") || !started.includes("openai")) {
    throw new Error(`API-key entry did not start: ${started}`);
  }
  await settle();
  key.value = secret;
  fire(key, "input");
  return {
    textDisplay: text.style.display,
    textValue: text.value,
    textContent: text.textContent,
    keyType: key.type || key.attrs.type || "",
    mask: document.querySelector("#mask")?.textContent ?? "",
    async finish() {
      fire(form, "submit");
      await settle();
      const view = await (await globalThis.fetch(new URL("view", pageUrl))).json() as PagePayload;
      return { echoed, view };
    },
  };
}

function fire(node: FakeNode, type: string): void {
  for (const listener of node.listeners[type] ?? []) listener({ preventDefault() {} });
}

class FakeNode {
  tag: string;
  className = "";
  textContent = "";
  style: { color: string; display: string } = { color: "", display: "" };
  type = "";
  hidden = true;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs: Record<string, string> = {};
  value = "";
  listeners: Record<string, Array<(event: { key?: string; preventDefault: () => void; shiftKey?: boolean }) => void>> = {};
  constructor(tag: string) { this.tag = tag; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? Object.assign(new FakeNode("#text"), { textContent: node }) : node;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type: string, listener: (event: { key?: string; preventDefault: () => void; shiftKey?: boolean }) => void): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  querySelector(selector: string): FakeNode | undefined { return this.querySelectorAll(selector)[0]; }
  querySelectorAll(selector: string): FakeNode[] {
    const all = [this, ...this.children.flatMap((child) => child.querySelectorAll("*"))];
    return all.filter((node) => node.matches(selector));
  }
  matches(selector: string): boolean {
    if (selector === "*") return this.tag !== "#text";
    if (selector.startsWith("#")) return this.attrs.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    return this.tag === selector;
  }
}

function nodeText(node: FakeNode): string {
  return node.textContent + node.children.map((child) => nodeText(child)).join("");
}

function fakeDocument(): { querySelector(selector: string): FakeNode | undefined; createElement(tag: string): FakeNode } {
  const root = new FakeNode("main");
  for (const id of ["sessions", "transcript", "tools", "notice", "menu", "status", "text", "mask", "key", "form", "abort"]) {
    const node = new FakeNode("div");
    node.attrs.id = id;
    root.append(node);
  }
  return {
    querySelector: (selector) => root.querySelector(selector),
    createElement: (tag) => new FakeNode(tag),
  };
}
