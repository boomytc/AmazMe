import assert from "node:assert/strict";
import test from "node:test";
import { baseAssistant, transformMessages, type Message, type Model } from "@amazme/ai";

const model: Model = {
  id: "m", name: "m", api: "openai-completions", provider: "test", input: ["text"],
  contextWindow: 1024, maxTokens: 128, cost: { input: 0, output: 0 },
};
const call = { type: "toolCall" as const, id: "bad|id", name: "work", arguments: {} };

test("failed assistant prefixes stay out of requests without changing the original messages", () => {
  for (const stopReason of ["error", "aborted", "deferred"] as const) {
    const messages: Message[] = [
      { role: "user", content: "first", timestamp: 1 },
      baseAssistant(model, [{ type: "text", text: "partial" }, call], stopReason),
      { role: "user", content: "next", timestamp: 2 },
    ];
    const before = JSON.stringify(messages);
    const projected = transformMessages(messages, model);
    assert.deepEqual(projected.map((message) => message.role), ["user", "user"]);
    assert.equal(JSON.stringify(messages), before);
  }
});

test("an unanswered call receives an error result before a new turn or the end of history", () => {
  for (const next of [undefined, { role: "user" as const, content: "next", timestamp: 2 },
    baseAssistant(model, [{ type: "text", text: "next" }], "stop")]) {
    const assistant = baseAssistant(model, [call], "toolUse");
    const projected = transformMessages(next ? [assistant, next] : [assistant], model);
    const result = projected[1];
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, true);
    const normalized = projected[0];
    assert.ok(normalized?.role === "assistant" && normalized.content[0]?.type === "toolCall");
    assert.equal(result.toolCallId, normalized.content[0].id);
    assert.equal(result.toolName, "work");
    if (next) assert.equal(projected[2]?.role, next.role);
    assert.equal(assistant.content.length, 1);
  }
});

test("completions thinking stays on its field, and another api receives it as answer text", () => {
  const thought = { type: "thinking" as const, thinking: "plan", thinkingField: "reasoning_content" as const };
  const assistant = baseAssistant(model, [thought, { type: "text", text: "go" }], "stop");
  const before = JSON.stringify(assistant);
  const same = transformMessages([assistant], model);
  const kept = same[0];
  assert.ok(kept?.role === "assistant");
  assert.deepEqual(kept.content.filter((block) => block.type === "thinking"), [thought]);
  assert.equal(kept.content.some((block) => block.type === "text" && block.text === "plan"), false);

  const keptNative = transformMessages([baseAssistant(model, [{ type: "thinking", thinking: "hmm" }], "stop")], { ...model, api: "anthropic-messages" });
  const native = keptNative[0];
  assert.ok(native?.role === "assistant");
  assert.equal(native.content[0]?.type === "thinking" ? native.content[0].thinking : "", "hmm");

  const other = transformMessages([assistant], { ...model, api: "faux" });
  const flat = other[0];
  assert.ok(flat?.role === "assistant");
  assert.equal(flat.content.some((block) => block.type === "thinking"), false);
  assert.deepEqual(flat.content.filter((block) => block.type === "text").map((block) => block.text), ["plan", "go"]);
  assert.equal(JSON.stringify(assistant), before);
});

test("system changes do not duplicate an existing result or split a tool response group", () => {
  const second = { ...call, id: "call_second" };
  const messages: Message[] = [
    baseAssistant(model, [call, second], "toolUse"),
    { role: "system", content: "tools changed", timestamp: 2 },
    { role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "actual" }], isError: false, timestamp: 3 },
    { role: "user", content: "next", timestamp: 4 },
  ];
  const projected = transformMessages(messages, model);
  assert.deepEqual(projected.map((message) => message.role), ["assistant", "toolResult", "toolResult", "system", "user"]);
  const results = projected.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((result) => result.isError), [false, true]);
  assert.deepEqual(results[0]?.content, [{ type: "text", text: "actual" }]);
  assert.equal(results[1]?.toolCallId, second.id);
});
