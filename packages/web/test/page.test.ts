import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { baseAssistant, createAssistantEventStream, createModels, type Model, type Provider } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import { startCodingHost } from "../../coding-agent/src/host.ts";
import { startWeb } from "@amazme/web";

test("the page lists sessions and a submit returns the prompt and assistant text", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  const models = createModels();
  models.setProvider(fauxProvider({ respond: () => fauxAssistant("from-web") }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const page = await startWeb({
    socket,
    port: 0,
    serverId: "amazme",
    runtimeId: "workspace",
    lane: "main",
  });
  t.after(() => page.close());
  const first = await fetch(page.url);
  const second = await fetch(page.url);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await fetch(`${page.url}favicon.ico`)).status, 204);
  const html = await second.text();
  assert.match(html, /id="sessions"/);
  assert.match(html, /id="transcript"/);
  assert.match(html, /id="tools"/);
  assert.match(html, /中止/);
  assert.match(html, /id="status"/);
  assert.match(html, /id="menu"/);
  assert.match(html, /const paint =/);
  assert.match(html, /function chooserRows/);
  const painted = paintPage(html, {
    sessions: ["main", "notes"],
    active: "main",
    directory: "~/workspace/AmazMe",
    provider: "faux",
    modelId: "faux-1",
    thinking: "off",
    thinkingLevels: ["off", "high"],
    models: [{ provider: "faux", modelId: "faux-1" }, { provider: "other", modelId: "other-1" }],
    busy: false,
    notice: null,
    pendingText: "# Live\n- now\n`tick`",
    tools: [{ name: "bash", status: "running" }],
    entries: [
      { id: "u", role: "user", text: "hello" },
      { id: "a", role: "assistant", text: "# Title\n- item\nuse `code`\n```\nconst value = 1;\n```" },
      { id: "t", role: "toolResult", title: "read", text: "file body" },
    ],
  });
  assert.equal(painted.user, true);
  assert.equal(painted.heading, "Title");
  assert.equal(painted.headingColor, "#c4b5fd");
  assert.equal(painted.marker, "•");
  assert.equal(painted.bullet, "item");
  assert.equal(painted.code, "code");
  assert.equal(painted.codeColor, "#8b93a7");
  assert.match(html, /article h3 \{ color: #c4b5fd/);
  assert.match(html, /article code \{ color: #8b93a7/);
  assert.match(html, /aside ul, #tools \{ list-style: none/);
  assert.equal(painted.fence.includes("```"), false);
  assert.match(painted.fence, /const value = 1;/);
  assert.equal(painted.toolTitle, "read");
  assert.equal(painted.toolBody, "file body");
  assert.equal(painted.liveTool, "bash");
  assert.equal(painted.liveStatus, "running");
  assert.match(painted.status, /~\/workspace\/AmazMe/);
  assert.equal(painted.modelSubmit, "/model other/other-1");
  assert.equal(painted.thinkingSubmit, "/thinking high");
  assert.equal(painted.resumeSubmit, "/resume notes");
  const acted = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "hello" }),
  });
  assert.equal(acted.status, 200);
  const view = await acted.json() as { sessions: string[]; entries: Array<{ role: string; text: string }>; pendingText: string };
  assert.ok(view.sessions.includes("main"));
  assert.ok(view.entries.some((entry) => entry.role === "user" && entry.text === "hello"));
  assert.ok(view.entries.some((entry) => entry.role === "assistant" && entry.text === "from-web"));
  const opened = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "open", text: "notes" }),
  });
  const notes = await opened.json() as { active: string; sessions: string[] };
  assert.equal(notes.active, "notes");
  assert.ok(notes.sessions.includes("main"));
  assert.ok(notes.sessions.includes("notes"));
});

test("a retryable model error is resent through the stored wait", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-retry-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  let calls = 0;
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: () => {
      calls += 1;
      if (calls === 1) return fauxAssistant("later", { stopReason: "error", retryable: true, errorMessage: "later" });
      return fauxAssistant("after-retry");
    },
  }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const page = await startWeb({ socket, port: 0, serverId: "amazme", runtimeId: "workspace", lane: "main" });
  t.after(() => page.close());
  const acted = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "retry-me" }),
  });
  assert.equal(acted.status, 200);
  const view = await acted.json() as { entries: Array<{ role: string; text: string }>; busy: boolean };
  assert.equal(calls, 2);
  assert.equal(view.busy, false);
  assert.ok(view.entries.some((entry) => entry.role === "assistant" && entry.text === "after-retry"));
});

test("a streaming chunk is visible before the turn settles", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-stream-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = createModels();
  models.setProvider(partialProvider(gate));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const page = await startWeb({ socket, port: 0, serverId: "amazme", runtimeId: "workspace", lane: "main" });
  t.after(() => page.close());
  const events = readEvents(page.url);
  const pending = events.until((view) => view.pendingText.includes("partial-web"));
  const acted = fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "stream" }),
  });
  const mid = await pending;
  assert.equal(mid.busy, true);
  assert.equal(mid.pendingText.includes("partial-web"), true);
  release();
  const response = await acted;
  assert.equal(response.status, 200);
  const done = await response.json() as { entries: Array<{ role: string; text: string }>; busy: boolean };
  assert.equal(done.busy, false);
  assert.ok(done.entries.some((entry) => entry.text.includes("partial-web done")));
  events.stop();
});

test("slash commands change the lane instead of prompting the model", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-slash-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  const models = createModels();
  models.setProvider(fauxProvider({ respond: (_context, _options, _state, model) => fauxAssistant(`faux:${model.id}`) }));
  models.setProvider(fauxProvider({
    id: "other",
    modelId: "other-1",
    respond: (_context, _options, _state, model) => fauxAssistant(`other:${model.id}`),
  }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const page = await startWeb({ socket, port: 0, serverId: "amazme", runtimeId: "workspace", lane: "main" });
  t.after(() => page.close());
  assert.match(await (await fetch(page.url)).text(), /id="notice"/);
  const thinking = await act(page.url, "/thinking high");
  assert.equal(thinking.entries.length, 0);
  assert.match(thinking.notice ?? "", /not supported/);
  const unknown = await act(page.url, "/nope");
  assert.equal(unknown.entries.length, 0);
  assert.match(unknown.notice ?? "", /未知命令/);
  const login = await act(page.url, "/login openai");
  assert.equal(login.entries.length, 0);
  assert.match(login.notice ?? "", /不能登录/);
  const shown = await act(page.url, "/model");
  assert.match(shown.notice ?? "", /faux\/faux-1/);
  const switched = await act(page.url, "/model other/other-1");
  assert.match(switched.notice ?? "", /other\/other-1/);
  const hello = await act(page.url, "hello");
  assert.ok(hello.entries.some((entry) => entry.role === "user" && entry.text === "hello"));
  assert.ok(hello.entries.some((entry) => entry.role === "assistant" && entry.text === "other:other-1"));
  const forked = await act(page.url, "/fork side");
  assert.equal(forked.active, "side");
  assert.ok(forked.entries.some((entry) => entry.text === "hello"));
  const side = await act(page.url, "only-side");
  assert.ok(side.entries.some((entry) => entry.text === "only-side"));
  const main = await act(page.url, "/resume main");
  assert.equal(main.active, "main");
  assert.equal(main.entries.some((entry) => entry.text === "only-side"), false);
  const rewound = await act(page.url, "/rewind");
  assert.equal(rewound.entries.some((entry) => entry.text === "hello"), false);
});

function paintPage(html: string, view: Record<string, unknown>): {
  user: boolean; heading: string; headingColor: string; marker: string; bullet: string; code: string; codeColor: string; fence: string;
  toolTitle: string; toolBody: string; liveTool: string; liveStatus: string; status: string;
  modelSubmit: string; thinkingSubmit: string; resumeSubmit: string;
} {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  const document = fakeDocument(html);
  const context = createContext({
    document,
    EventSource: class { constructor() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(view) }),
    console,
  });
  new Script(script).runInContext(context);
  const text = document.querySelector("#text");
  text.value = "/model";
  const paint = (context as { paint: (value: Record<string, unknown>) => void }).paint;
  const chooserRows = (context as { chooserRows: (value: Record<string, unknown>, input: string) => Array<{ submit: string }> }).chooserRows;
  paint(view);
  const transcript = document.querySelector("#transcript");
  const articles = transcript?.querySelectorAll("article") ?? [];
  const tools = articles.filter((node) => node.className === "tool");
  const result = tools[0];
  const live = tools.at(-1);
  return {
    user: articles.some((node) => node.className === "user"),
    heading: transcript?.querySelector("h3")?.textContent ?? "",
    headingColor: transcript?.querySelector("h3")?.style.color ?? "",
    marker: transcript?.querySelector(".marker")?.textContent ?? "",
    bullet: (transcript?.querySelector("li")?.children ?? []).map((node) => node.textContent).join("").replace("•", "").trim(),
    code: transcript?.querySelector("code")?.textContent ?? "",
    codeColor: transcript?.querySelector("code")?.style.color ?? "",
    fence: transcript?.querySelector("pre")?.textContent ?? "",
    toolTitle: result?.querySelector("header")?.textContent ?? "",
    toolBody: result?.children.find((node) => node.tag === "p" && node.className !== "status")?.textContent ?? "",
    liveTool: live?.querySelector("header")?.textContent ?? "",
    liveStatus: live?.querySelector(".status")?.textContent ?? "",
    status: document.querySelector("#status")?.textContent ?? "",
    modelSubmit: chooserRows(view, "/model").find((row) => row.submit.includes("other"))?.submit ?? "",
    thinkingSubmit: chooserRows(view, "/thinking").find((row) => row.submit.endsWith("high"))?.submit ?? "",
    resumeSubmit: chooserRows(view, "/resume").find((row) => row.submit.endsWith("notes"))?.submit ?? "",
  };
}

class FakeNode {
  tag: string;
  className = "";
  textContent = "";
  style: { color: string } = { color: "" };
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
  addEventListener(type: string, listener: (event: { key?: string; preventDefault: () => void }) => void): void {
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
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1)) || this.attrs.class === selector.slice(1);
    if (selector.includes(".")) {
      const [tag, className] = selector.split(".");
      return this.tag === tag && (this.className === className || this.attrs.class === className);
    }
    return this.tag === selector;
  }
}

function fakeDocument(html: string): { getElementById(id: string): FakeNode | undefined; querySelector(selector: string): FakeNode | undefined; createElement(tag: string): FakeNode } {
  const root = new FakeNode("main");
  for (const id of ["sessions", "transcript", "tools", "notice", "menu", "status", "text", "mask", "key", "form", "abort"]) {
    const node = new FakeNode(id === "form" ? "form" : "div");
    node.attrs.id = id;
    root.append(node);
  }
  void html;
  return {
    getElementById: (id) => root.querySelector("#" + id),
    querySelector: (selector) => root.querySelector(selector),
    createElement: (tag) => new FakeNode(tag),
  };
}

async function act(url: string, text: string): Promise<{ active: string; notice: string | null; entries: Array<{ role: string; text: string }> }> {
  const response = await fetch(`${url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ active: string; notice: string | null; entries: Array<{ role: string; text: string }> }>;
}

function partialProvider(gate: Promise<void>): Provider {
  const model: Model = {
    id: "faux-1",
    name: "Faux",
    provider: "faux",
    api: "faux",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0 },
  };
  return {
    id: "faux",
    name: "Faux",
    auth: { apiKey: { env: "FAUX", ambient: "x" } },
    getModels: () => [model],
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    streamSimple(active) {
      const stream = createAssistantEventStream();
      void (async () => {
        const partial = baseAssistant(active, [{ type: "text", text: "partial-web" }], "stop");
        stream.push({ type: "text_delta", contentIndex: 0, delta: "partial-web", partial });
        await gate;
        const message = baseAssistant(active, [{ type: "text", text: "partial-web done" }], "stop");
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    },
  };
}

function readEvents(url: string): { until: (ready: (view: { pendingText: string; busy: boolean }) => boolean) => Promise<{ pendingText: string; busy: boolean }>; stop: () => void } {
  type View = { pendingText: string; busy: boolean };
  const seen: View[] = [];
  const pending: Array<(view: View) => void> = [];
  let buffer = "";
  const request = httpRequest(new URL("/events", url), (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const view = JSON.parse(line.slice("data: ".length)) as View;
        seen.push(view);
        for (const wait of pending.splice(0)) wait(view);
      }
    });
  });
  request.end();
  return {
    until(ready) {
      const existing = seen.find(ready);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the stream did not show the pending text")), 8_000);
        const take = (view: View) => {
          if (!ready(view)) {
            pending.push(take);
            return;
          }
          clearTimeout(timer);
          resolve(view);
        };
        pending.push(take);
      });
    },
    stop() {
      request.destroy();
    },
  };
}
