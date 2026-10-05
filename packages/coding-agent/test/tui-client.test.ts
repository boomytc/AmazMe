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
import { decodeKeys, emptyTui, finishDrive, readHostFrame, reduceTui, renderTui, treePickerRows, type TuiWindow } from "@amazme/tui";
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
  assert.match(renderTui(state), /read/);
  assert.match(renderTui(state), /running/);
  state = reduceTui(state, {
    type: "window",
    window: window({
      pendingText: "hello",
      busy: true,
      tools: [{ name: "read", status: "settled" }],
    }),
  }).state;
  assert.equal(state.pendingText, "hello");
  assert.match(renderTui(state), /settled/);
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
  assert.match(renderTui(state), /你/);
  assert.match(renderTui(state), /AmazMe/);
  assert.match(renderTui(state), /hello/);
  assert.equal(renderTui(state).includes("focus "), false);
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
  assert.equal(abort.state.exitArmed, false);
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
  const prefixed = typeLine(emptyTui(), "/n");
  assert.deepEqual(prefixed.effect, { type: "slash", command: { type: "new-session" } });
  const typing = reduceTui(emptyTui(), { type: "key", key: { type: "char", value: "/" } }).state;
  const screen = renderTui({ ...typing, provider: "faux", modelId: "faux-1", thinking: "off" }, 80, 24);
  assert.match(screen, /\/help/);
  assert.match(screen, /faux\/faux-1/);
  assert.match(screen, /›/);
  assert.match(screen, /\/help/);
  const picker = {
    title: "Select provider to configure:",
    hint: "↑↓ navigate    enter select    escape cancel",
    query: "",
    index: 0,
    kind: "login-provider" as const,
    rows: [
      { id: "anthropic", label: "Anthropic", detail: "• not configured", tone: "muted" as const },
      { id: "openai", label: "OpenAI", detail: "✓ stored", tone: "ok" as const },
    ],
  };
  const listed = renderTui({ ...emptyTui(), picker }, 80, 30);
  assert.match(listed, /Select provider to configure:/);
  assert.match(listed, /not configured/);
  assert.match(listed, /✓ stored/);
  assert.match(listed, /\x1b\[38;5;147m/);
  let filtered = { state: { ...emptyTui(), picker } };
  for (const value of ["o", "p", "e", "n"]) {
    filtered = reduceTui(filtered.state, { type: "key", key: { type: "char", value } });
  }
  const chosen = reduceTui(filtered.state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(chosen.effect, { type: "pick", kind: "login-provider", id: "openai" });
  const secret = renderTui({
    ...emptyTui(),
    picker: { ...picker, kind: "api-key", query: "sk-secret", rows: [], subject: "anthropic", secret: true },
  });
  assert.equal(secret.includes("sk-secret"), false);
  const treePicker = {
    title: "Select entry:",
    hint: "↑↓ navigate    enter select    escape cancel",
    query: "",
    index: 0,
    kind: "tree" as const,
    rows: treePickerRows([
      {
        id: "user-1",
        parentId: null,
        seq: 0,
        timestamp: 1,
        payload: { type: "message", message: { role: "user", content: "left-branch", timestamp: 1 } },
      },
      {
        id: "assistant-1",
        parentId: "user-1",
        seq: 1,
        timestamp: 2,
        payload: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "faux-reply" }],
            api: "faux",
            provider: "faux",
            model: "faux-1",
            usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
            stopReason: "stop",
            timestamp: 2,
          },
        },
      },
    ]),
  };
  assert.match(treePicker.rows[1]?.label ?? "", /assistant faux-reply/);
  const tree = renderTui({ ...emptyTui(), picker: treePicker }, 80, 24);
  assert.match(tree, /Select entry:/);
  assert.match(tree, /left-branch/);
  const narrowed = reduceTui({ ...emptyTui(), picker: treePicker }, { type: "key", key: { type: "char", value: "x" } });
  const treeFrame = renderTui(narrowed.state, 80, 24);
  assert.match(treeFrame, /faux-reply/);
  assert.equal(treeFrame.includes("left-branch"), false);
});

test("a frame separates the user, markdown, and a live tool, and a picker commits model, thinking, and resume", () => {
  const assistant = "# Title\n- item\nuse `code`\n```\nconst value = 1;\n```";
  const state = {
    ...emptyTui(),
    directory: "~/workspace/AmazMe",
    provider: "faux",
    modelId: "faux-1",
    thinking: "off",
    entries: [
      { id: "u", role: "user" as const, text: "hello" },
      { id: "a", role: "assistant" as const, text: assistant },
      { id: "t", role: "tool" as const, title: "read", text: "file body" },
    ],
    tools: [{ name: "bash", status: "running" as const }],
  };
  const first = renderTui(state, 80, 40);
  const second = renderTui(state, 80, 40);
  assert.equal(first, second);
  assert.match(first, /┌ 你/);
  assert.match(first, /Title/);
  assert.equal(first.includes("# Title"), false);
  assert.match(first, /• item/);
  assert.match(first, /code/);
  assert.equal(first.includes("```"), false);
  assert.match(first, /const value = 1;/);
  assert.match(first, /bash/);
  assert.match(first, /running/);
  assert.match(first, /read/);
  assert.match(first, /file body/);
  assert.match(first, /~/);
  assert.match(first, /─/);
  const model = commitPicker("model", [
    { id: "faux\tfaux-1", label: "faux/faux-1", detail: "", tone: "muted" },
    { id: "other\tother-1", label: "other/other-1", detail: "", tone: "muted" },
  ], "other");
  assert.deepEqual(model, { type: "pick", kind: "model", id: "other\tother-1" });
  const thinking = commitPicker("thinking", [
    { id: "off", label: "off", detail: "", tone: "muted" },
    { id: "high", label: "high", detail: "", tone: "muted" },
  ], "high");
  assert.deepEqual(thinking, { type: "pick", kind: "thinking", id: "high" });
  const resume = commitPicker("resume", [
    { id: "main", label: "main", detail: "", tone: "muted" },
    { id: "notes", label: "notes", detail: "", tone: "muted" },
  ], "note");
  assert.deepEqual(resume, { type: "pick", kind: "resume", id: "notes" });
});

function commitPicker(kind: "model" | "thinking" | "resume", rows: Array<{ id: string; label: string; detail: string; tone: "ok" | "muted" }>, query: string) {
  let state = {
    ...emptyTui(),
    picker: { title: kind, hint: "navigate", query: "", index: 0, kind, rows },
  };
  for (const value of Array.from(query)) {
    state = reduceTui(state, { type: "key", key: { type: "char", value } }).state;
  }
  return reduceTui(state, { type: "key", key: { type: "enter" } }).effect;
}

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

test("an idle empty prompt quits on the second ctrl-c", () => {
  const armed = reduceTui(emptyTui(), { type: "key", key: { type: "ctrl-c" } });
  assert.equal(armed.effect, null);
  assert.equal(armed.state.exitArmed, true);
  assert.match(armed.state.notice ?? "", /再按一次 Ctrl-C 退出/);
  const typed = reduceTui(armed.state, { type: "key", key: { type: "char", value: "a" } });
  assert.equal(typed.state.exitArmed, false);
  assert.equal(typed.state.input, "a");
  const quit = reduceTui(armed.state, { type: "key", key: { type: "ctrl-c" } });
  assert.deepEqual(quit.effect, { type: "quit" });
  const cleared = reduceTui({ ...emptyTui(), input: "draft", cursor: 5 }, { type: "key", key: { type: "ctrl-c" } });
  assert.equal(cleared.effect, null);
  assert.equal(cleared.state.input, "");
  assert.equal(cleared.state.exitArmed, false);
});

function typeLine(start: ReturnType<typeof emptyTui>, text: string) {
  let state = start;
  for (const value of Array.from(text)) {
    state = reduceTui(state, { type: "key", key: { type: "char", value } }).state;
  }
  return reduceTui(state, { type: "key", key: { type: "enter" } });
}
