import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { LaneControl } from "../src/control.ts";
import { startCodingHost } from "../src/host.ts";
import { decodeKeys, emptyTui, finishDrive, readHostFrame, reduceTui, renderTui, type TuiWindow } from "@amazme/tui";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "../src/host.ts";

function window(partial: Partial<TuiWindow> = {}): TuiWindow {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: false,
    sessions: ["main"],
    active: "main",
    ...partial,
  };
}

test("streaming text and tool status appear before the turn settles", () => {
  let state = emptyTui();
  state = reduceTui(state, {
    type: "window",
    window: window({ pendingText: "hel", busy: true, tools: [{ name: "read", status: "running" }] }),
  }).state;
  assert.equal(state.pendingText, "hel");
  assert.equal(state.tools[0]?.status, "running");
  assert.match(renderTui(state), /hel/);
  assert.match(renderTui(state), /read running/);
  state = reduceTui(state, {
    type: "window",
    window: window({
      pendingText: "hello",
      busy: true,
      tools: [{ name: "read", status: "settled" }],
    }),
  }).state;
  assert.equal(state.pendingText, "hello");
  assert.match(renderTui(state), /read settled/);
  state = reduceTui(state, {
    type: "window",
    window: window({
      pendingText: "",
      busy: false,
      entries: [
        { id: "u", role: "user", text: "hi" },
        { id: "a", role: "assistant", text: "hello" },
      ],
    }),
  }).state;
  assert.equal(state.pendingText, "");
  assert.match(renderTui(state), /assistant hello/);
});

test("abort, scroll, prompt focus, and slash commands", () => {
  const entries = [
    { id: "u1", role: "user" as const, text: "one" },
    { id: "a1", role: "assistant" as const, text: "a" },
    { id: "u2", role: "user" as const, text: "two" },
    { id: "a2", role: "assistant" as const, text: "b" },
  ];
  let state = reduceTui(emptyTui(), { type: "window", window: window({ entries, busy: true }) }).state;
  const abort = reduceTui(state, { type: "key", key: { type: "ctrl-c" } });
  assert.deepEqual(abort.effect, { type: "abort" });
  state = reduceTui(abort.state, { type: "key", key: { type: "escape" } }).state;
  assert.equal(state.focus, "scroll");
  state = reduceTui(state, { type: "key", key: { type: "down" } }).state;
  assert.equal(state.entryIndex, 1);
  state = reduceTui(state, { type: "key", key: { type: "up" } }).state;
  assert.equal(state.entryIndex, 0);
  state = reduceTui(state, { type: "key", key: { type: "page-down" } }).state;
  assert.equal(state.turnIndex, 1);
  assert.equal(state.entryIndex, 2);
  state = reduceTui(state, { type: "key", key: { type: "page-up" } }).state;
  assert.equal(state.turnIndex, 0);
  assert.equal(state.entryIndex, 0);
  state = reduceTui(state, { type: "key", key: { type: "char", value: "i" } }).state;
  assert.equal(state.focus, "prompt");
  state = reduceTui(state, { type: "key", key: { type: "char", value: "/" } }).state;
  state = reduceTui(state, { type: "key", key: { type: "char", value: "n" } }).state;
  state = reduceTui(state, { type: "key", key: { type: "char", value: "e" } }).state;
  state = reduceTui(state, { type: "key", key: { type: "char", value: "w" } }).state;
  const created = reduceTui(state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(created.effect, { type: "slash", command: { type: "new-session" } });
  const resume = typeLine(created.state, "/resume main");
  assert.deepEqual(resume.effect, { type: "slash", command: { type: "resume", name: "main" } });
  const compact = typeLine(resume.state, "/compact");
  assert.deepEqual(compact.effect, { type: "slash", command: { type: "compact" } });
  const model = typeLine(compact.state, "/model faux/faux-1");
  assert.deepEqual(model.effect, { type: "slash", command: { type: "model", provider: "faux", modelId: "faux-1" } });
  const thinking = typeLine(model.state, "/effort high");
  assert.deepEqual(thinking.effect, { type: "slash", command: { type: "thinking", level: "high" } });
  const login = typeLine(thinking.state, "/login openai");
  assert.deepEqual(login.effect, { type: "slash", command: { type: "login", provider: "openai" } });
  const unknown = typeLine(login.state, "/nope");
  assert.equal(unknown.effect, null);
  assert.match(unknown.state.notice ?? "", /未知命令/);
  const help = typeLine(unknown.state, "/help");
  assert.equal(help.effect, null);
  assert.match(help.state.notice ?? "", /\/login/);
  assert.match(help.state.notice ?? "", /\/fork/);
  const prompt = typeLine(help.state, "hello");
  assert.deepEqual(prompt.effect, { type: "submit", text: "hello" });
});

test("two reads of the host frame show the same assistant text", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-tui-frame-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  const models = createModels();
  models.setProvider(fauxProvider());
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const control = new LaneControl(remote.lane(HOST_LANE), () => undefined);
  await control.open();
  await control.submit("hello");
  await control.close();
  await client.dispose();
  const attach = { socket, serverId: HOST_SERVER_ID, runtimeId: HOST_RUNTIME_ID, lane: HOST_LANE };
  const first = await readHostFrame(attach);
  const second = await readHostFrame(attach);
  assert.equal(first, second);
  assert.match(first, /hello/);
  assert.match(first, /ok/);
});

test("fullscreen submit resends a retryable model error", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-tui-retry-"));
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
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const lane = remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "retry-me" });
  await finishDrive(lane, admitted.operationId);
  const snapshot = await lane.snapshot();
  assert.equal(calls, 2);
  assert.equal(snapshot.operationId, null);
  assert.ok(snapshot.entries.some((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant" && messageText(entry.payload.message) === "after-retry"));
});

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

test("arrow keys decode as entry movement", () => {
  assert.deepEqual(decodeKeys("\u001b[A\u001b[B").keys, [{ type: "up" }, { type: "down" }]);
});

function typeLine(start: ReturnType<typeof emptyTui>, text: string) {
  let state = start;
  for (const value of Array.from(text)) {
    state = reduceTui(state, { type: "key", key: { type: "char", value } }).state;
  }
  return reduceTui(state, { type: "key", key: { type: "enter" } });
}
