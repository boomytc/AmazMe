import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantEventStream,
  createModels,
  frameFromEvent,
  messageFromFrames,
  reduceFrames,
  type AssistantEvent,
} from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";
import { checkAssistantStream } from "@amazme/ai/testing";

async function collect(respond: FauxResponder) {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const stream = models.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  const events: AssistantEvent[] = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  return { events, message };
}

test("faux interleaves text, thinking, and tool blocks at stable indexes", async () => {
  const args = { path: "a", nested: { n: 1 } };
  const { events, message } = await collect(() => fauxAssistant([
    { type: "text", text: "A" },
    { type: "thinking", thinking: "one" },
    fauxToolCall("read", args, "call_1"),
    { type: "text", text: "B" },
    { type: "thinking", thinking: "two" },
  ]));
  assert.deepEqual(checkAssistantStream(events), []);
  assert.deepEqual(message.content.map((block) => block.type), ["text", "thinking", "toolCall", "text", "thinking"]);
  assert.equal(message.content[0]?.type === "text" ? message.content[0].text : "", "A");
  assert.equal(message.content[1]?.type === "thinking" ? message.content[1].thinking : "", "one");
  assert.equal(message.content[3]?.type === "text" ? message.content[3].text : "", "B");
  assert.equal(message.content[4]?.type === "thinking" ? message.content[4].thinking : "", "two");
  const toolIndexes = events.flatMap((event) =>
    event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end" ? [event.contentIndex] : []);
  assert.deepEqual([...new Set(toolIndexes)], [2]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  if (terminal?.type === "done") assert.equal(terminal.message, message);

  const start = events.find((event) => event.type === "toolcall_start");
  const delta = events.find((event) => event.type === "toolcall_delta");
  assert.equal(start?.type, "toolcall_start");
  assert.equal(delta?.type, "toolcall_delta");
  const startArgs = start?.type === "toolcall_start" ? start.partial.content[2] : undefined;
  const deltaArgs = delta?.type === "toolcall_delta" ? delta.partial.content[2] : undefined;
  assert.deepEqual(startArgs?.type === "toolCall" ? startArgs.arguments : undefined, {});
  assert.deepEqual(deltaArgs?.type === "toolCall" ? deltaArgs.arguments : undefined, { path: "a", nested: { n: 1 } });
  args.nested.n = 9;
  assert.equal(deltaArgs?.type === "toolCall" && deltaArgs.arguments && typeof deltaArgs.arguments === "object"
    ? (deltaArgs.arguments as { nested: { n: number } }).nested.n
    : 0, 1);
  if (deltaArgs?.type === "toolCall" && deltaArgs.arguments && typeof deltaArgs.arguments === "object") {
    (deltaArgs.arguments as { nested: { n: number } }).nested.n = 3;
  }
  assert.deepEqual(startArgs?.type === "toolCall" ? startArgs.arguments : undefined, {});

  const frames = events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
  const reduced = reduceFrames(frames);
  assert.deepEqual(reduced.content.map((block) => block.type), ["text", "thinking", "toolCall", "text", "thinking"]);
  const prefix = messageFromFrames({ api: "faux", provider: "faux", id: "faux-1" }, frames.filter((frame) => frame.type !== "stop"));
  assert.equal(prefix.stopReason, "aborted");
  assert.equal(prefix.content[2]?.type, "toolCall");
});

test("faux error and abort keep received tool content without a successful toolcall_end", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const { events, message } = await collect(() => fauxAssistant(
      [{ type: "text", text: "kept" }, { type: "thinking", thinking: "why" }, fauxToolCall("read", { path: "a" }, "call_1")],
      { stopReason, errorMessage: "stopped" },
    ));
    assert.deepEqual(checkAssistantStream(events), []);
    assert.equal(message.stopReason, stopReason);
    assert.equal(message.content.some((block) => block.type === "toolCall"), true);
    assert.equal(events.some((event) => event.type === "toolcall_end" || event.type === "text_end" || event.type === "thinking_end"), false);
    assert.equal(events.at(-1)?.type, "error");
    const frames = events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
    assert.equal(frames.some((frame) => frame.type === "toolcall"), false);
    assert.equal(reduceFrames(frames).content.some((block) => block.type === "text"), true);
    assert.equal(reduceFrames(frames).content.some((block) => block.type === "thinking"), true);
  }
});

test("a stream has one consumer, and events after the terminal are dropped", async () => {
  const stream = createAssistantEventStream();
  const first = stream[Symbol.asyncIterator]();
  assert.throws(() => stream[Symbol.asyncIterator](), /one consumer/);
  const message = fauxAssistant("done");
  stream.push({ type: "done", reason: "stop", message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "later", partial: message });
  const next = await first.next();
  assert.equal(next.value?.type, "done");
  assert.equal((await first.next()).done, true);
  assert.equal(await stream.result(), next.value?.type === "done" ? next.value.message : undefined);
});

test("dropping a late event does not inspect or clone its payload", async () => {
  const stream = createAssistantEventStream();
  stream.push({ type: "done", reason: "stop", message: fauxAssistant("done") });
  const partial = fauxAssistant([fauxToolCall("work", { uncloneable: () => undefined })]);
  assert.doesNotThrow(() => stream.push({ type: "toolcall_start", contentIndex: 0, partial }));
  assert.equal((await stream.result()).stopReason, "stop");
});

test("faux thinking frames retain the field present on the final message", async () => {
  const { events, message } = await collect(() => fauxAssistant([
    { type: "thinking", thinking: "plan", thinkingField: "reasoning_content" },
  ]));
  const frames = events.map(frameFromEvent).filter(frame => frame !== undefined);
  assert.deepEqual(reduceFrames(frames).content, message.content);
});

test("the shared checker rejects missing message start and changed terminal text", () => {
  const partial = fauxAssistant("heard");
  const blocks: AssistantEvent[] = [
    { type: "text_start", contentIndex: 0, partial: fauxAssistant("") },
    { type: "text_delta", contentIndex: 0, delta: "heard", partial },
    { type: "text_end", contentIndex: 0, partial },
    { type: "done", reason: "stop", message: partial },
  ];
  assert.ok(checkAssistantStream(blocks).some(problem => /start/.test(problem)));
  const changed: AssistantEvent[] = [
    { type: "start", partial: fauxAssistant("") }, ...blocks.slice(0, -1),
    { type: "done", reason: "stop", message: fauxAssistant("different") },
  ];
  assert.ok(checkAssistantStream(changed).some(problem => /terminal content/.test(problem)));
});

test("the shared checker rejects a shifted index, a second terminal, and a toolcall_end on error", () => {
  const tool = fauxToolCall("read", {}, "call_1");
  const toolMessage = fauxAssistant([tool]);
  const shifted: AssistantEvent[] = [
    { type: "toolcall_start", contentIndex: 0, partial: toolMessage },
    { type: "text_start", contentIndex: 0, partial: fauxAssistant([{ type: "text", text: "x" }, tool]) },
    { type: "error", error: fauxAssistant("", { stopReason: "error", errorMessage: "x" }) },
  ];
  assert.ok(checkAssistantStream(shifted).some((problem) => /contentIndex/.test(problem)));
  const twice: AssistantEvent[] = [
    { type: "done", reason: "stop", message: fauxAssistant("a") },
    { type: "error", error: fauxAssistant("", { stopReason: "error", errorMessage: "x" }) },
  ];
  assert.ok(checkAssistantStream(twice).some((problem) => /terminal/.test(problem)));
  const ended: AssistantEvent[] = [
    { type: "toolcall_start", contentIndex: 0, partial: toolMessage },
    { type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: toolMessage },
    { type: "error", error: fauxAssistant([tool], { stopReason: "error", errorMessage: "x" }) },
  ];
  assert.ok(checkAssistantStream(ended).some((problem) => /toolcall_end/.test(problem)));
  assert.equal(frameFromEvent({ type: "toolcall_start", contentIndex: 0, partial: toolMessage }), undefined);
  const restored = reduceFrames([
    { type: "text_delta", contentIndex: 1, delta: "after" },
    { type: "toolcall", contentIndex: 0, id: "call_1", name: "read", arguments: { path: "a" } },
  ]);
  assert.equal(restored.content[0]?.type === "toolCall" ? restored.content[0].name : "", "read");
  assert.equal(restored.content[1]?.type === "text" ? restored.content[1].text : "", "after");
});
