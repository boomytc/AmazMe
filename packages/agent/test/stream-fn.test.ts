import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type StreamFn } from "@amazme/agent";
import { baseAssistant, createAssistantEventStream, messageText, type AssistantEventStream, type Model } from "@amazme/ai";

function handModel(id: string): Model {
  return {
    id,
    name: id,
    provider: "hand",
    api: "hand",
    input: ["text"],
    contextWindow: 1024,
    maxTokens: 128,
    cost: { input: 0, output: 0 },
  };
}

function finish(model: Model, text: string): AssistantEventStream {
  const stream = createAssistantEventStream();
  stream.push({ type: "done", reason: "stop", message: baseAssistant(model, [{ type: "text", text }], "stop") });
  return stream;
}

function answer(messages: Awaited<ReturnType<Agent["prompt"]>>): string {
  const last = messages.at(-1);
  return last?.role === "assistant" ? messageText(last) : "";
}

test("a synchronous stream function runs the agent without a Models collection", async () => {
  const model = handModel("hand");
  const agent = new Agent({
    model,
    systemPrompt: "local",
    streamFn(active, context) {
      assert.equal(active, model);
      assert.equal(context.systemPrompt, "local");
      assert.equal(context.messages.at(-1)?.role, "user");
      return finish(active, "sync");
    },
  });
  assert.equal(answer(await agent.prompt("hello")), "sync");
  await agent.waitForIdle();
});

test("a stream function may resolve the event stream asynchronously", async () => {
  const model = handModel("hand");
  const agent = new Agent({
    model,
    async streamFn(active) {
      await Promise.resolve();
      return finish(active, "async");
    },
  });
  assert.equal(answer(await agent.prompt("hello")), "async");
});

test("prepareRequest and later model changes reach the stream function", async () => {
  const original = handModel("original");
  const replacement = handModel("replacement");
  const seen: Array<{ id: string; thinking?: string; tool?: string; system?: string }> = [];
  const agent = new Agent({
    model: original,
    systemPrompt: "be brief",
    thinkingLevel: "off",
    tools: [{
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "unused" }] };
      },
    }],
    prepareRequest: () => ({ model: replacement, thinkingLevel: "low" }),
    streamFn(active, context, options) {
      seen.push({
        id: active.id,
        thinking: options?.thinkingLevel,
        tool: context.tools?.[0]?.name,
        system: context.systemPrompt,
      });
      return finish(active, "prepared");
    },
  });
  assert.equal(answer(await agent.prompt("go")), "prepared");
  agent.prepareRequest = undefined;
  agent.model = handModel("switched");
  agent.thinkingLevel = "high";
  assert.equal(answer(await agent.prompt("again")), "prepared");
  assert.deepEqual(seen, [
    { id: "replacement", thinking: "low", tool: "echo", system: "be brief" },
    { id: "switched", thinking: "high", tool: "echo", system: "be brief" },
  ]);
});

test("aborting during assistant start settles the turn and leaves the agent idle", async () => {
  const model = handModel("hand");
  let calls = 0;
  const agent = new Agent({
    model,
    streamFn(_model, _context, options) {
      calls += 1;
      if (calls > 1) return finish(model, "next");
      const stream = createAssistantEventStream();
      const partial = baseAssistant(model, [{ type: "text", text: "partial" }], "pending");
      stream.push({ type: "start", partial });
      const aborted = baseAssistant(model, [{ type: "text", text: "partial" }], "aborted");
      options?.signal?.addEventListener("abort", () => {
        stream.push({ type: "error", error: aborted });
      }, { once: true });
      return stream;
    },
  });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") agent.abort();
  });
  const output = await Promise.race([
    agent.prompt("go"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("prompt did not settle")), 500);
    }),
  ]);
  unsubscribe();
  const last = output.at(-1);
  assert.equal(last?.role, "assistant");
  if (last?.role === "assistant") {
    assert.equal(last.stopReason, "aborted");
    assert.equal(messageText(last), "partial");
  }
  await agent.waitForIdle();
  assert.equal(answer(await agent.prompt("go")), "next");
});

test("a throwing stream function rejects the turn and still accepts another prompt", async () => {
  const agent = new Agent({
    model: handModel("hand"),
    streamFn() {
      throw new Error("stream failed");
    },
  });
  await assert.rejects(agent.prompt("go"), /stream failed/);
  await agent.waitForIdle();
  await assert.rejects(agent.prompt("go"), /stream failed/);
});

test("a rejected stream function rejects the turn and still accepts another prompt", async () => {
  const agent = new Agent({
    model: handModel("hand"),
    streamFn() {
      return Promise.reject(new Error("stream rejected"));
    },
  });
  await assert.rejects(agent.prompt("go"), /stream rejected/);
  await agent.waitForIdle();
  await assert.rejects(agent.prompt("go"), /stream rejected/);
});

test("Agent maxTokens reaches the injected stream function", async () => {
  const seen: Array<number | undefined> = [];
  const agent = new Agent({
    model: handModel("hand"),
    maxTokens: 40,
    streamFn(_model, _context, options) {
      seen.push(options?.maxTokens);
      return finish(handModel("hand"), "capped");
    },
  });
  assert.equal(answer(await agent.prompt("go")), "capped");
  agent.maxTokens = undefined;
  assert.equal(answer(await agent.prompt("again")), "capped");
  assert.deepEqual(seen, [40, undefined]);
});

test("AgentOptions requires streamFn and does not accept a models collection", () => {
  const model = handModel("typed");
  // @ts-expect-error streamFn is required
  new Agent({ model });
  const streamFn: StreamFn = (active) => finish(active, "typed");
  // @ts-expect-error models is not an Agent option
  new Agent({ model, streamFn, models: undefined });
});
