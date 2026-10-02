import assert from "node:assert/strict";
import test from "node:test";
import { createModels, createProvider, frameFromEvent, messageFromFrames, reduceFrames, type AssistantEvent, type AssistantMessage, type Model, type OpenAICompletionsOptions } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { checkAssistantStream } from "@amazme/ai/testing";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

function model(extra: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
  return {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    provider: "openai",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 1_000_000, output: 2_000_000 },
    ...extra,
  };
}

function textOf(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function terminals(events: AssistantEvent[]): AssistantEvent[] {
  return events.filter((event) => event.type === "done" || event.type === "error");
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, error: unknown): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

async function run(
  fetchImpl: typeof fetch,
  options: OpenAICompletionsOptions = {},
  active: Model<"openai-completions"> = model(),
  onEvent?: (event: AssistantEvent) => void,
): Promise<{ message: AssistantMessage; events: AssistantEvent[]; bodies: Array<Record<string, unknown>>; calls: number }> {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const api = openaiCompletionsApi({
    fetch: async (input, init) => {
      calls += 1;
      if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return fetchImpl(input, init);
    },
  });
  const stream = api.stream(active, CONTEXT, { baseUrl: "https://example.test/v1", apiKey: "sk-test", ...options });
  const events: AssistantEvent[] = [];
  const finished = (async () => {
    for await (const event of stream) {
      events.push(event);
      onEvent?.(event);
    }
  })();
  const message = await Promise.race([
    stream.result(),
    new Promise<AssistantMessage>((_, reject) => setTimeout(() => reject(new Error("result hung")), 1000)),
  ]);
  await finished;
  assert.deepEqual(checkAssistantStream(events), []);
  const terminal = events.at(-1);
  if (terminal?.type === "done") assert.equal(terminal.message, message);
  if (terminal?.type === "error") assert.equal(terminal.error, message);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    assert.equal(events.some((event) => event.type === "toolcall_end"), false);
  }
  return { message, events, bodies, calls };
}

test("a usage-only chunk sets tokens and cost from the model rate", async () => {
  const { message, events, bodies } = await run(async () => sse([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n',
    "data: [DONE]\n\n",
  ]));
  assert.equal(textOf(message), "Hi");
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.usage, {
    input: 12,
    output: 5,
    totalTokens: 17,
    cost: { input: 12, output: 10, total: 22 },
  });
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true });
  assert.equal(bodies[0]?.reasoning_effort, undefined);
  assert.equal(terminals(events).length, 1);
  assert.equal(terminals(events)[0]?.type, "done");
});

test("split frames and a trailing usage line without a newline still settle once", async () => {
  const { message, events } = await run(async () => sse([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
    "\n",
    'data: {"choi',
    'ces":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}',
  ]));
  assert.equal(textOf(message), "Hi");
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.input, 12);
  assert.equal(message.usage.output, 5);
  assert.equal(message.usage.totalTokens, 17);
  assert.equal(terminals(events).length, 1);
});

test("string token counts are not coerced, and a missing rate is not invented", async () => {
  const unpriced = model();
  delete (unpriced as { cost?: Model["cost"] }).cost;
  const coerced = await run(async () => sse([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"prompt_tokens":"12","completion_tokens":"5","total_tokens":"17"}}\n\n',
    "data: [DONE]\n\n",
  ]));
  assert.deepEqual(coerced.message.usage, { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } });
  const priced = await run(async () => sse([
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n',
    "data: [DONE]\n\n",
  ]), {}, unpriced);
  assert.equal(priced.message.usage.input, 12);
  assert.equal(priced.message.usage.output, 5);
  assert.equal(priced.message.usage.totalTokens, 17);
  assert.deepEqual(priced.message.usage.cost, { input: 0, output: 0, total: 0 });
});

test("an unsupported thinking level fails before the request is sent", async () => {
  const { message, calls, events } = await run(
    async () => new Response("unused", { status: 200 }),
    { thinkingLevel: "low", reasoningEffort: "high" },
  );
  assert.equal(calls, 0);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /Thinking level "low" is not supported by gpt-4o-mini/);
  assert.notEqual(message.retryable, true);
  assert.equal(terminals(events).length, 1);
});

test("a supported thinking level is mapped, and reasoningEffort overrides it", async () => {
  const reasoning = model({ reasoning: true, thinkingLevelMap: { low: "x-low", high: null } });
  const mapped = await run(
    async () => sse(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
    { thinkingLevel: "low" },
    reasoning,
  );
  assert.equal(mapped.bodies[0]?.reasoning_effort, "x-low");
  assert.equal(mapped.message.stopReason, "stop");

  const off = await run(
    async () => sse(['data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
    { thinkingLevel: "off" },
    reasoning,
  );
  assert.equal(off.bodies[0]?.reasoning_effort, undefined);
  const mappedOff = await run(
    async () => sse(['data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
    { thinkingLevel: "off" },
    model({ reasoning: true, thinkingLevelMap: { off: "none" } }),
  );
  assert.equal(mappedOff.bodies[0]?.reasoning_effort, "none");

  const rejected = await run(async () => new Response("unused"), { thinkingLevel: "high" }, reasoning);
  assert.equal(rejected.calls, 0);
  assert.match(rejected.message.errorMessage ?? "", /not supported/);

  const override = await run(
    async () => sse(['data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
    { thinkingLevel: "low", reasoningEffort: "high" },
    reasoning,
  );
  assert.equal(override.bodies[0]?.reasoning_effort, "high");

  const explicit = await run(
    async () => sse(['data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
    { reasoningEffort: "medium" },
  );
  assert.equal(explicit.calls, 1);
  assert.equal(explicit.bodies[0]?.reasoning_effort, "medium");
});

test("Models forwards thinkingLevel and reasoningEffort onto the completions body", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const active = model({ id: "reasoner", reasoning: true, thinkingLevelMap: { low: "x-low" } });
  const models = createModels({ env: { OPENAI_API_KEY: "sk-test" } });
  models.setProvider(createProvider({
    id: "openai",
    baseUrl: "https://example.test/v1",
    auth: { env: "OPENAI_API_KEY" },
    models: [active],
    api: openaiCompletionsApi({
      fetch: async (_input, init) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]);
      },
    }),
  }));
  const simple = await models.streamSimple(active, CONTEXT, { thinkingLevel: "low" }).result();
  assert.equal(simple.stopReason, "stop");
  assert.equal(seen[0]?.reasoning_effort, "x-low");
  const direct = await models.stream(active, CONTEXT, { thinkingLevel: "low", reasoningEffort: "high" }).result();
  assert.equal(direct.stopReason, "stop");
  assert.equal(seen[1]?.reasoning_effort, "high");
  assert.deepEqual(seen[1]?.stream_options, { include_usage: true });
});

test("http failures are classified without treating every 429 or 5xx as retryable", async () => {
  const cases: Array<{ name: string; status: number; error: unknown; retryable: boolean; kind: string }> = [
    { name: "rate limit", status: 429, error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached" }, retryable: true, kind: "rate_limit" },
    { name: "empty 429", status: 429, error: { message: "" }, retryable: true, kind: "rate_limit" },
    { name: "quota", status: 429, error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" }, retryable: false, kind: "quota" },
    { name: "billing", status: 429, error: { code: "billing_hard_limit_reached", message: "billing hard limit" }, retryable: false, kind: "quota" },
    { name: "payment", status: 402, error: { message: "payment required" }, retryable: false, kind: "quota" },
    { name: "auth", status: 401, error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key" }, retryable: false, kind: "authentication" },
    { name: "forbidden", status: 403, error: { message: "forbidden" }, retryable: false, kind: "authentication" },
    { name: "bad request", status: 400, error: { type: "invalid_request_error", message: "rate limit field is invalid" }, retryable: false, kind: "invalid_request" },
    { name: "not found", status: 404, error: { message: "missing model" }, retryable: false, kind: "invalid_request" },
    { name: "unprocessable", status: 422, error: { message: "bad schema" }, retryable: false, kind: "invalid_request" },
    { name: "timeout", status: 408, error: { message: "timeout" }, retryable: true, kind: "unavailable" },
    { name: "internal", status: 500, error: { message: "internal" }, retryable: true, kind: "unavailable" },
    { name: "bad gateway", status: 502, error: { message: "bad gateway" }, retryable: true, kind: "unavailable" },
    { name: "overloaded", status: 503, error: { message: "overloaded" }, retryable: true, kind: "unavailable" },
    { name: "gateway timeout", status: 504, error: { message: "gateway timeout" }, retryable: true, kind: "unavailable" },
    { name: "quota on 500", status: 500, error: { code: "insufficient_quota", message: "quota" }, retryable: false, kind: "quota" },
    { name: "not implemented", status: 501, error: { message: "not implemented" }, retryable: false, kind: "server" },
    { name: "http version", status: 505, error: { message: "version" }, retryable: false, kind: "server" },
  ];
  for (const item of cases) {
    const { message, calls, events } = await run(async () => jsonError(item.status, item.error));
    assert.equal(calls, 1, item.name);
    assert.equal(message.stopReason, "error", item.name);
    assert.equal(message.retryable === true, item.retryable, item.name);
    assert.match(message.errorMessage ?? "", new RegExp(`${item.status} ${item.kind}`), item.name);
    assert.equal(textOf(message), "", item.name);
    assert.equal(terminals(events).length, 1, item.name);
  }
});

test("a network failure is retryable and keeps one terminal", async () => {
  const { message, events } = await run(async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(message.stopReason, "error");
  assert.equal(message.retryable, true);
  assert.match(message.errorMessage ?? "", /fetch failed/);
  assert.equal(terminals(events).length, 1);
});

test("a stream that ends without a finish reason keeps the partial text and is not retryable", async () => {
  const { message, events } = await run(async () => sse([
    'data: {"choices":[{"delta":{"content":"Keep"}}]}\n\n',
  ]));
  assert.equal(message.stopReason, "error");
  assert.equal(textOf(message), "Keep");
  assert.match(message.errorMessage ?? "", /finish reason/);
  assert.notEqual(message.retryable, true);
  assert.equal(terminals(events).length, 1);
});

test("a reader failure keeps partial text and tool calls on one retryable terminal", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const encoder = new TextEncoder();
  const { message, events } = await run(async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.error(new Error("connection reset"));
    },
  }), { status: 200 }));
  assert.equal(message.stopReason, "error");
  assert.equal(message.retryable, true);
  assert.equal(textOf(message), "Hello");
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "a" });
  assert.match(message.errorMessage ?? "", /connection reset/);
  assert.equal(terminals(events).length, 1);
  const terminal = terminals(events)[0];
  assert.ok(terminal && terminal.type === "error");
  assert.equal(terminal.error, message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test("malformed sse keeps partial text on one non-retryable terminal", async () => {
  const { message, events } = await run(async () => sse([
    'data: {"choices":[{"delta":{"content":"Pa"}}]}\n\n',
    "data: {not-json}\n\n",
    'data: {"choices":[{"delta":{"content":" later"}}]}\n\n',
    "data: [DONE]\n\n",
  ]));
  assert.equal(textOf(message), "Pa");
  assert.equal(message.stopReason, "error");
  assert.notEqual(message.retryable, true);
  assert.match(message.errorMessage ?? "", /malformed/);
  assert.equal(terminals(events).length, 1);
});

test("streamed error envelopes override a finish reason and retain partial output and usage", async () => {
  for (const [error, retryable] of [
    [{ type: "rate_limit_error", message: "Rate limit reached" }, true],
    [{ type: "server_error", message: "temporary failure" }, true],
    [{ code: "insufficient_quota", message: "quota exhausted" }, false],
    [{ code: "invalid_api_key", message: "bad key" }, false],
    [{ type: "invalid_request_error", message: "bad request" }, false],
  ] as const) {
    const { message, events, calls } = await run(async () => sse([
      'data: {"choices":[{"delta":{"content":"Keep"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n',
      `data: ${JSON.stringify({ error })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    assert.equal(calls, 1);
    assert.equal(message.stopReason, "error");
    assert.equal(message.retryable === true, retryable);
    assert.equal(textOf(message), "Keep");
    assert.equal(message.usage.totalTokens, 17);
    assert.match(message.errorMessage ?? "", new RegExp(error.message));
    assert.deepEqual(terminals(events).map((event) => event.type), ["error"]);
  }
});

test("valid JSON with malformed completion fields is a non-retryable protocol error", async () => {
  for (const event of [null, [], { choices: {} }, { choices: [null] },
    { choices: [{ delta: { content: 42 } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: {} } }] } }] },
    { choices: [{ finish_reason: "unexpected" }] },
  ]) {
    const { message, events } = await run(async () => sse([
      'data: {"choices":[{"delta":{"content":"Keep"}}]}\n\n',
      `data: ${JSON.stringify(event)}\n\n`,
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    assert.equal(message.stopReason, "error", JSON.stringify(event));
    assert.notEqual(message.retryable, true);
    assert.equal(textOf(message), "Keep");
    assert.match(message.errorMessage ?? "", /malformed/);
    assert.deepEqual(terminals(events).map((event) => event.type), ["error"]);
  }
});

test("invalid final tool arguments cannot become a successful tool call", async () => {
  const call = { index: 0, id: "call_1", function: { name: "work", arguments: '{"value":' } };
  const { message, events } = await run(async () => sse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`,
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]));
  assert.equal(message.stopReason, "error");
  assert.notEqual(message.retryable, true);
  assert.match(message.errorMessage ?? "", /tool arguments/);
  assert.equal(message.content[0]?.type, "toolCall");
  assert.equal(events.some((event) => event.type === "toolcall_end"), false);
  assert.deepEqual(terminals(events).map((event) => event.type), ["error"]);
  const frames = events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
  assert.equal(frames.some((frame) => frame.type === "toolcall"), false);
  const recovered = messageFromFrames(
    { api: "openai-completions", provider: "openai", id: "gpt-4o-mini" },
    frames.filter((frame) => frame.type !== "stop"),
  );
  assert.equal(recovered.stopReason, "aborted");
  assert.equal(recovered.content.some((block) => block.type === "toolCall"), false);

  const truncated = await run(async () => sse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`,
    'data: {"choices":[{"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n",
  ]));
  assert.equal(truncated.message.stopReason, "length");
  assert.equal(truncated.message.content[0]?.type, "toolCall");
});

test("a content-filter finish is a non-retryable error retaining received output", async () => {
  const { message, events } = await run(async () => sse([
    'data: {"choices":[{"delta":{"content":"Keep"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"content_filter"}]}\n\n',
    "data: [DONE]\n\n",
  ]));
  assert.equal(message.stopReason, "error");
  assert.notEqual(message.retryable, true);
  assert.equal(textOf(message), "Keep");
  assert.match(message.errorMessage ?? "", /content_filter/);
  assert.deepEqual(terminals(events).map((event) => event.type), ["error"]);
});

test("local request serialization errors do not send or retry the request", async () => {
  let calls = 0;
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const api = openaiCompletionsApi({ fetch: async () => { calls++; return sse([]); } });
  const stream = api.stream(model(), { messages: [{
    role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "work", arguments: circular }],
    api: "openai-completions", provider: "openai", model: "gpt-4o-mini", timestamp: 1,
    stopReason: "toolUse", usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
  }] }, { baseUrl: "https://example.test/v1", apiKey: "k" });
  const message = await stream.result();
  assert.equal(calls, 0);
  assert.equal(message.stopReason, "error");
  assert.notEqual(message.retryable, true);
  assert.match(message.errorMessage ?? "", /circular/i);
});

test("cancelling during the stream settles the partial text and does not hang", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const controller = new AbortController();
  const encoder = new TextEncoder();
  const { message, events, calls } = await run(
    async (_input, init) => new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'));
        const timer = setTimeout(() => streamController.error(new Error("still open")), 1500);
        init?.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
      },
    }), { status: 200 }),
    { signal: controller.signal },
    model(),
    (event) => {
      if (event.type === "text_delta") controller.abort();
    },
  );
  assert.equal(calls, 1);
  assert.equal(message.stopReason, "aborted");
  assert.equal(textOf(message), "Partial");
  assert.notEqual(message.retryable, true);
  assert.equal(terminals(events).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test("an already aborted signal does not send the request", async () => {
  const { message, calls } = await run(async () => {
    throw new Error("fetch should not run");
  }, { signal: AbortSignal.abort() });
  assert.equal(calls, 0);
  assert.equal(message.stopReason, "aborted");
  assert.notEqual(message.retryable, true);
});

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function indexes(events: AssistantEvent[], kind: "text_" | "toolcall_"): number[] {
  return events.flatMap((event) => {
    if (!event.type.startsWith(kind)) return [];
    switch (event.type) {
      case "text_start":
      case "text_delta":
      case "text_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        return [event.contentIndex];
      default:
        return [];
    }
  });
}

function streamedToolName(event: AssistantEvent): string | undefined {
  if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") return undefined;
  const block = event.partial.content[event.contentIndex];
  return block?.type === "toolCall" ? block.name : undefined;
}

test("a tool that appears before text keeps one content index and frames restore that order", async () => {
  const { message, events } = await run(async () => sse([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] } }] }),
    data({ choices: [{ delta: { content: "after" } }] }),
    data({ choices: [{ finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(message.stopReason, "toolUse");
  assert.equal(message.content[0]?.type === "toolCall" ? message.content[0].name : "", "read");
  assert.deepEqual(message.content[0]?.type === "toolCall" ? message.content[0].arguments : undefined, { path: "a" });
  assert.equal(message.content[1]?.type === "text" ? message.content[1].text : "", "after");
  assert.deepEqual([...new Set(indexes(events, "toolcall_"))], [0]);
  assert.deepEqual([...new Set(indexes(events, "text_"))], [1]);
  const frames = events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
  const reduced = reduceFrames(frames);
  assert.equal(reduced.content[0]?.type, "toolCall");
  assert.equal(reduced.content[1]?.type === "text" ? reduced.content[1].text : "", "after");
  const prefix = messageFromFrames(
    { api: "openai-completions", provider: "openai", id: "gpt-4o-mini" },
    frames.filter((frame) => frame.type !== "stop"),
  );
  assert.equal(prefix.stopReason, "aborted");
  assert.equal(prefix.content[0]?.type, "toolCall");
});

test("server tool index 1 appearing before index 0 does not become the content index", async () => {
  let early: AssistantEvent | undefined;
  const { message, events } = await run(async () => sse([
    data({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "beta", arguments: "{" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "alpha", arguments: "{" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "\"n\":1}" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"n\":2}" } }] } }] }),
    data({ choices: [{ finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]), {}, model(), (event) => {
    if (!early && event.type === "toolcall_delta") early = event;
  });
  assert.equal(message.content[0]?.type === "toolCall" ? message.content[0].name : "", "beta");
  assert.deepEqual(message.content[0]?.type === "toolCall" ? message.content[0].arguments : undefined, { n: 1 });
  assert.equal(message.content[1]?.type === "toolCall" ? message.content[1].name : "", "alpha");
  assert.deepEqual(message.content[1]?.type === "toolCall" ? message.content[1].arguments : undefined, { n: 2 });
  const beta = events.filter((event) => streamedToolName(event) === "beta");
  const alpha = events.filter((event) => streamedToolName(event) === "alpha");
  assert.deepEqual([...new Set(indexes(beta, "toolcall_"))], [0]);
  assert.deepEqual([...new Set(indexes(alpha, "toolcall_"))], [1]);
  assert.equal(early?.type, "toolcall_delta");
  const earlyArgs = early?.type === "toolcall_delta" ? early.partial.content[early.contentIndex] : undefined;
  assert.deepEqual(earlyArgs?.type === "toolCall" ? earlyArgs.arguments : undefined, { _raw: "{" });
  const finalBeta = message.content[0];
  if (finalBeta?.type === "toolCall" && finalBeta.arguments && typeof finalBeta.arguments === "object") {
    (finalBeta.arguments as { n: number }).n = 9;
  }
  assert.deepEqual(earlyArgs?.type === "toolCall" ? earlyArgs.arguments : undefined, { _raw: "{" });
});

test("text and tool calls keep separate blocks when they alternate", async () => {
  const { message, events } = await run(async () => sse([
    data({ choices: [{ delta: { content: "A" } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] } }] }),
    data({ choices: [{ delta: { content: "B" } }] }),
    data({ choices: [{ finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.deepEqual(message.content.map((block) => block.type), ["text", "toolCall", "text"]);
  assert.equal(message.content[0]?.type === "text" ? message.content[0].text : "", "A");
  assert.equal(message.content[2]?.type === "text" ? message.content[2].text : "", "B");
  const textStarts = events.filter((event) => event.type === "text_start").map((event) => event.contentIndex);
  assert.deepEqual(textStarts, [0, 2]);
  assert.equal(events.filter((event) => event.type === "text_end").length, 2);
  assert.equal(events.filter((event) => event.type === "toolcall_end").map((event) => event.contentIndex)[0], 1);
});

test("crlf framing, a split utf-8 character, an empty body, and a usage-only chunk settle once", async () => {
  const crlf = await run(async () => sse([
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\r\n\r\n",
    "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\r\n\r\n",
    "data: [DONE]\r\n\r\n",
  ]));
  assert.equal(textOf(crlf.message), "Hi");
  assert.equal(crlf.message.stopReason, "stop");

  const encoded = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );
  const marker = new TextEncoder().encode("你");
  const at = encoded.indexOf(marker[0] ?? 0);
  assert.ok(at > 0);
  const utf8 = await run(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, at + 1));
      controller.enqueue(encoded.slice(at + 1));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  assert.equal(textOf(utf8.message), "你");
  assert.deepEqual([...new Set(indexes(utf8.events, "text_"))], [0]);

  const empty = await run(async () => sse([]));
  assert.equal(empty.message.stopReason, "error");
  assert.match(empty.message.errorMessage ?? "", /finish reason/);
  assert.equal(empty.events.some((event) => event.type === "toolcall_end"), false);

  const usageOnly = await run(async () => sse([
    'data: {"usage":{"prompt_tokens":4,"completion_tokens":0,"total_tokens":4}}\n\n',
  ]));
  assert.equal(usageOnly.message.stopReason, "error");
  assert.equal(usageOnly.message.usage.input, 4);
  assert.equal(usageOnly.message.usage.totalTokens, 4);
  assert.equal(usageOnly.events.some((event) => event.type.startsWith("text_")), false);

  const usageThenText = await run(async () => sse([
    'data: {"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
    data({ choices: [{ delta: { content: "Hi" } }] }),
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(textOf(usageThenText.message), "Hi");
  assert.equal(usageThenText.message.usage.input, 4);
  assert.equal(usageThenText.message.usage.output, 1);

  const continued = await run(async () => sse([
    data({ choices: [{ delta: { content: "Hel" } }] }),
    data({ choices: [{ delta: { content: "lo" } }] }),
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(textOf(continued.message), "Hello");
  assert.deepEqual(indexes(continued.events.filter((event) => event.type === "text_start"), "text_"), [0]);
  assert.equal(continued.events.filter((event) => event.type === "text_delta").length, 2);
  assert.equal(continued.events.filter((event) => event.type === "text_end").length, 1);

  const quiet = await run(async () => sse([
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(quiet.message.stopReason, "stop");
  assert.equal(textOf(quiet.message), "");
  assert.equal(quiet.events.some((event) => event.type.startsWith("text_") || event.type.startsWith("toolcall_")), false);
});
