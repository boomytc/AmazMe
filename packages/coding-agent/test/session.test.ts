import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@amazme/agent";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";
import { AgentSession, createCodingTools, SessionStore } from "@amazme/coding-agent";

test("the session tree can move the tip and compaction hides the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-tree-"));
  const file = join(dir, "session.jsonl");
  const store = SessionStore.create(file, dir);
  const first = store.appendMessage({ role: "user", content: "one", timestamp: 1 });
  store.appendMessage({ role: "assistant", content: [{ type: "text", text: "two" }], api: "faux", provider: "faux", model: "faux-1", usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  const third = store.appendMessage({ role: "user", content: "three", timestamp: 3 });
  store.select(first.id);
  store.appendMessage({ role: "user", content: "branch", timestamp: 4 });
  assert.deepEqual(
    store.modelMessages().map((message) => (typeof message.content === "string" ? message.content : "")),
    ["one", "branch"],
  );
  store.select(third.id);
  store.compact("SUM", 1);
  const messages = store.modelMessages();
  assert.equal(typeof messages[0]?.content === "string" ? messages[0].content : "", "SUM");
  assert.equal(typeof messages[messages.length - 1]?.content === "string" ? messages[messages.length - 1].content : "", "three");
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /"content":"one"/);
  const reopened = SessionStore.open(file);
  assert.equal(reopened.modelMessages().length, store.modelMessages().length);
  appendFileSync(file, "{\"type\":\"message\"");
  const torn = SessionStore.open(file);
  assert.equal(torn.modelMessages().length, reopened.modelMessages().length);
  torn.appendMessage({ role: "user", content: "after-tear", timestamp: 9 });
  const again = SessionStore.open(file);
  assert.equal(
    again.modelMessages().some((message) => message.role === "user" && message.content === "after-tear"),
    true,
  );
});

test("compaction keeps a split tool call with its result", () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-pair-"));
  const store = SessionStore.create(join(dir, "session.jsonl"), dir);
  store.appendMessage({ role: "user", content: "one", timestamp: 1 });
  store.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  });
  store.appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "body" }],
    isError: false,
    timestamp: 3,
  });
  store.compact("SUM", 1);
  const messages = store.modelMessages();
  const assistant = messages.find((message) => message.role === "assistant");
  const tool = messages.find((message) => message.role === "toolResult");
  assert.equal(messages[0]?.role, "user");
  assert.ok(assistant && assistant.role === "assistant");
  assert.equal(assistant.content.some((block) => block.type === "toolCall" && block.id === "call_1"), true);
  assert.equal(tool && tool.role === "toolResult" ? tool.toolCallId : "", "call_1");
  assert.equal(messages.some((message) => message.role === "user" && message.content === "one"), false);
});

test("compaction pairs a reused tool id with the nearest call in the current context", () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-reuse-"));
  const store = SessionStore.create(join(dir, "session.jsonl"), dir);
  const usage = { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } };
  const round = (prompt: string, body: string) => {
    store.appendMessage({ role: "user", content: prompt, timestamp: 1 });
    store.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: prompt } }],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    store.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: body }],
      isError: false,
      timestamp: 3,
    });
  };
  round("prompt-old", "body-old");
  round("prompt-new", "body-new");
  store.compact("SUM", 1);
  const once = store.modelMessages().map((message) => messageText(message)).join("\n");
  assert.match(once, /body-new/);
  assert.doesNotMatch(once, /body-old/);
  assert.doesNotMatch(once, /prompt-old/);
  assert.doesNotMatch(once, /prompt-new/);
  store.compact("SUM2", 1);
  const twice = store.modelMessages();
  assert.equal(twice.filter((message) => message.role === "assistant").length, 1);
  assert.equal(twice.filter((message) => message.role === "toolResult").length, 1);
  const tool = twice.find((message) => message.role === "toolResult");
  assert.equal(tool ? messageText(tool) : "", "body-new");
  assert.doesNotMatch(twice.map((message) => messageText(message)).join("\n"), /body-old/);
});

test("agent session persists the loop and reloads the active branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-agent-"));
  writeFileSync(join(dir, "note.txt"), "note-body");
  const provider = fauxProvider({
    respond: (context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("read", { path: "note.txt" })]);
      const tool = context.messages.find((message) => message.role === "toolResult");
      return fauxAssistant(tool ? messageText(tool) : "missing");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const file = join(dir, "session.jsonl");
  const agent = new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    telemetryContext: models.telemetryContext,
    systemPrompt: "coder",
    tools: createCodingTools(dir),
  });
  const session = new AgentSession(SessionStore.create(file, dir), agent);
  const produced = await session.prompt("read the note");
  session.close();
  const last = [...produced].reverse().find((message) => message.role === "assistant");
  assert.equal(last && last.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "", "note-body");
  const reloaded = SessionStore.open(file);
  assert.match(reloaded.modelMessages().map((message) => messageText(message.role === "custom" ? { role: "user", content: message.content, timestamp: 0 } : message)).join("\n"), /note-body/);
});

test("write and edit stay inside the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-tools-"));
  const tools = createCodingTools(dir);
  const write = tools.find((item) => item.name === "write");
  const edit = tools.find((item) => item.name === "edit");
  const read = tools.find((item) => item.name === "read");
  const bash = tools.find((item) => item.name === "bash");
  assert.ok(write && edit && read && bash);
  await write.execute({ path: "a.txt", content: "alpha" }, { signal: new AbortController().signal });
  await edit.execute({ path: "a.txt", old: "alpha", replacement: "beta" }, { signal: new AbortController().signal });
  const body = await read.execute({ path: "a.txt" }, { signal: new AbortController().signal });
  assert.equal(body.content[0]?.text, "beta");
  const echoed = await bash.execute({ command: "echo hello-from-bash" }, { signal: new AbortController().signal });
  assert.match(echoed.content[0]?.text ?? "", /hello-from-bash/);
  await assert.rejects(() => read.execute({ path: "../secret" }, { signal: new AbortController().signal }));
});
