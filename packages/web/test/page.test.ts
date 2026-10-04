import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(html, /Abort/);
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
