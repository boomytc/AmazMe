import assert from "node:assert/strict";
import test from "node:test";
import { baseAssistant, type Model, type Message } from "@amazme/ai";
import { selectTail, type TranscriptEntry } from "../src/compaction/select.ts";

const model: Model = {
  id: "m", name: "m", provider: "test", api: "openai-completions",
  input: ["text"], contextWindow: 2_000, maxTokens: 200, cost: { input: 0, output: 0 },
};
const entry = (id: string, message: Message): TranscriptEntry => ({ id, timestamp: 1, kind: "message", message });
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const system = (text: string): Message => ({ role: "system", content: text, timestamp: 1 });

test("compaction keeps an entire tool group across intervening system updates", () => {
  const entries = [
    entry("old", user("old goal")),
    entry("answered", baseAssistant(model, [{ type: "text", text: "done" }], "stop")),
    entry("call", baseAssistant(model, [
      { type: "toolCall", id: "a", name: "work", arguments: {} },
      { type: "toolCall", id: "b", name: "work", arguments: {} },
    ], "toolUse")),
    entry("system", system("updated rules")),
    entry("a", { role: "toolResult", toolCallId: "a", toolName: "work", content: [{ type: "text", text: "first" }], timestamp: 1, isError: false }),
    entry("b", { role: "toolResult", toolCallId: "b", toolName: "work", content: [{ type: "text", text: "second" }], timestamp: 1, isError: false }),
  ];
  const selected = selectTail(entries, 0, "resume");
  assert.ok(selected.ok);
  assert.deepEqual(selected.cut.summarized.map(item => item.id), ["old", "answered"]);
  assert.deepEqual(selected.cut.kept.map(item => item.id), ["call", "system", "a", "b"]);
});

test("a trailing system update does not hide the unanswered user from compaction", () => {
  const entries = [
    entry("old", user("old goal")),
    entry("answered", baseAssistant(model, [{ type: "text", text: "done" }], "stop")),
    entry("current", user("CURRENT_EXACT")),
    entry("system", system("new rules")),
  ];
  const selected = selectTail(entries, 0, "finish");
  assert.ok(selected.ok);
  assert.deepEqual(selected.cut.summarized.map(item => item.id), ["old", "answered"]);
  assert.deepEqual(selected.cut.kept.map(item => item.id), ["current", "system"]);
});
