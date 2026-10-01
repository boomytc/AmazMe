import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@amazme/agent";
import { createModels, fauxAssistant, fauxProvider, fauxToolCall, messageText } from "@amazme/ai";
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
    models,
    model,
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
