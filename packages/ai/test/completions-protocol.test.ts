import assert from "node:assert/strict";
import test from "node:test";
import { createModels, createProvider, frameFromEvent, messageFromFrames, reduceFrames, type AssistantEvent, type AssistantMessage, type Context, type Model, type OpenAICompletionsOptions, type UserContent } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { completionsProvider } from "@amazme/ai/providers/completions";
import { openaiProvider } from "@amazme/ai/providers/openai";
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
  context: Context = CONTEXT,
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
  const stream = api.stream(active, context, { baseUrl: "https://example.test/v1", apiKey: "sk-test", ...options });
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

test("reasoning fields keep the first non-empty string and ignore empty or illegal values", async () => {
  const cases: Array<{ delta: Record<string, unknown>; thinking?: { text: string; field: string }; answer?: string }> = [
    { delta: { reasoning_content: "from-content" }, thinking: { text: "from-content", field: "reasoning_content" } },
    { delta: { reasoning: "from-reasoning" }, thinking: { text: "from-reasoning", field: "reasoning" } },
    { delta: { reasoning_text: "from-text" }, thinking: { text: "from-text", field: "reasoning_text" } },
    { delta: { reasoning_content: "first", reasoning: "first", reasoning_text: "second" }, thinking: { text: "first", field: "reasoning_content" } },
    { delta: { reasoning_content: "", reasoning: "next", reasoning_text: "later" }, thinking: { text: "next", field: "reasoning" } },
    { delta: { reasoning_content: " " }, thinking: { text: " ", field: "reasoning_content" } },
    { delta: { reasoning_content: "", reasoning: "", reasoning_text: "", content: "Hi" } },
    { delta: { reasoning_content: ["x"], reasoning: false, reasoning_text: 0, content: "Hi" } },
    { delta: { reasoning_content: 1, reasoning: { nested: true }, reasoning_text: null, content: "Hi" } },
    { delta: { reasoning_content: "real", reasoning_details: [{ type: "reasoning.text", text: "extra" }] }, thinking: { text: "real", field: "reasoning_content" } },
    { delta: { reasoning_details: [{ type: "reasoning.text", text: "secret-thought" }] }, answer: "" },
  ];
  for (const item of cases) {
    const { message, events } = await run(async () => sse([
      data({ choices: [{ delta: item.delta }] }),
      data({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]));
    const label = JSON.stringify(item.delta);
    assert.equal(message.stopReason, "stop", label);
    const thoughts = message.content.filter((block) => block.type === "thinking");
    if (item.thinking) {
      assert.equal(thoughts.length, 1, label);
      assert.equal(thoughts[0]?.type === "thinking" ? thoughts[0].thinking : "", item.thinking.text, label);
      assert.equal(thoughts[0]?.type === "thinking" ? thoughts[0].thinkingField : "", item.thinking.field, label);
      assert.equal(textOf(message), "", label);
      assert.equal(events.filter((event) => event.type === "thinking_end").length, 1, label);
      assert.equal(JSON.stringify(message).includes("extra"), false, label);
      assert.equal(JSON.stringify(message).includes("second"), false, label);
    } else {
      assert.equal(thoughts.length, 0, label);
      assert.equal(textOf(message), item.answer ?? "Hi", label);
      assert.equal(events.some((event) => event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end"), false, label);
    }
  }
});

test("thinking keeps a stable index beside text and tools, including a field change", async () => {
  let early: AssistantEvent | undefined;
  const { message, events } = await run(async () => sse([
    data({ choices: [{ delta: { reasoning_content: "hel" } }] }),
    data({ choices: [{ delta: { reasoning_content: "lo", reasoning: "nope" } }] }),
    data({ choices: [{ delta: { reasoning: "switched" } }] }),
    data({ choices: [{ delta: { content: "say" } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 7, id: "call_1", function: { name: "read", arguments: "{}" } }] } }] }),
    data({ choices: [{ delta: { reasoning_text: "tail" } }] }),
    data({ choices: [{ finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]), {}, model(), (event) => {
    if (!early && event.type === "thinking_start") early = event;
  });
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content.map((block) => block.type), ["thinking", "thinking", "text", "toolCall", "thinking"]);
  assert.equal(message.content[0]?.type === "thinking" ? message.content[0].thinking : "", "hello");
  assert.equal(message.content[0]?.type === "thinking" ? message.content[0].thinkingField : "", "reasoning_content");
  assert.equal(message.content[1]?.type === "thinking" ? message.content[1].thinking : "", "switched");
  assert.equal(message.content[1]?.type === "thinking" ? message.content[1].thinkingField : "", "reasoning");
  assert.equal(message.content[2]?.type === "text" ? message.content[2].text : "", "say");
  assert.equal(message.content[3]?.type === "toolCall" ? message.content[3].name : "", "read");
  assert.equal(message.content[4]?.type === "thinking" ? message.content[4].thinking : "", "tail");
  assert.equal(message.content[4]?.type === "thinking" ? message.content[4].thinkingField : "", "reasoning_text");
  assert.equal(JSON.stringify(message).includes("nope"), false);
  assert.deepEqual(
    events.flatMap((event) => event.type === "thinking_delta" ? [[event.contentIndex, event.delta]] : []),
    [[0, "hel"], [0, "lo"], [1, "switched"], [4, "tail"]],
  );
  assert.deepEqual([...new Set(indexes(events, "toolcall_"))], [3]);
  assert.equal(events.filter((event) => event.type === "thinking_end").length, 3);
  assert.equal(events.filter((event) => event.type === "text_end").length, 1);
  assert.equal(events.filter((event) => event.type === "toolcall_end").length, 1);
  const started = early?.type === "thinking_start" ? early.partial.content[early.contentIndex] : undefined;
  assert.equal(started?.type === "thinking" ? started.thinking : "missing", "");
  const frames = events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
  const contentFrames = frames.filter((frame) => frame.type !== "stop");
  const reduced = reduceFrames([...contentFrames].reverse());
  assert.equal(reduced.content[0]?.type === "thinking" ? reduced.content[0].thinkingField : "", "reasoning_content");
  assert.equal(reduced.content[1]?.type === "thinking" ? reduced.content[1].thinking : "", "switched");
  assert.equal(reduced.content[3]?.type, "toolCall");
  assert.equal(reduced.content[4]?.type === "thinking" ? reduced.content[4].thinkingField : "", "reasoning_text");
  const prefix = messageFromFrames({ api: "openai-completions", provider: "openai", id: "gpt-4o-mini" }, contentFrames);
  assert.equal(prefix.stopReason, "aborted");
  assert.equal(prefix.content[0]?.type === "thinking" ? prefix.content[0].thinking : "", "hello");
  assert.equal(prefix.content[0]?.type === "thinking" ? prefix.content[0].thinkingField : "", "reasoning_content");
});

test("errors, reader failures, and cancellation keep received thinking without ending it", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const streamed = await run(async () => sse([
    data({ choices: [{ delta: { reasoning_content: "kept" } }] }),
    data({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(streamed.message.stopReason, "error");
  assert.equal(streamed.message.overflow, true);
  assert.notEqual(streamed.message.retryable, true);
  assert.equal(streamed.message.content[0]?.type === "thinking" ? streamed.message.content[0].thinking : "", "kept");
  assert.equal(streamed.message.content[0]?.type === "thinking" ? streamed.message.content[0].thinkingField : "", "reasoning_content");
  assert.equal(streamed.events.some((event) => event.type === "thinking_end" || event.type === "toolcall_end"), false);
  const streamedFrames = streamed.events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
  const recovered = messageFromFrames(
    { api: "openai-completions", provider: "openai", id: "gpt-4o-mini" },
    streamedFrames.filter((frame) => frame.type !== "stop"),
  );
  assert.equal(recovered.stopReason, "aborted");
  assert.equal(recovered.content[0]?.type === "thinking" ? recovered.content[0].thinkingField : "", "reasoning_content");

  const encoder = new TextEncoder();
  const reader = await run(async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(data({ choices: [{ delta: { reasoning: "partial" } }] })));
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.error(new Error("connection reset"));
    },
  }), { status: 200 }));
  assert.equal(reader.message.stopReason, "error");
  assert.equal(reader.message.retryable, true);
  assert.equal(reader.message.content[0]?.type === "thinking" ? reader.message.content[0].thinking : "", "partial");
  assert.equal(reader.message.content[0]?.type === "thinking" ? reader.message.content[0].thinkingField : "", "reasoning");
  assert.equal(reader.message.errorMessage?.includes("partial"), false);
  assert.equal(reader.events.some((event) => event.type === "thinking_end"), false);

  const controller = new AbortController();
  const cancelled = await run(
    async (_input, init) => new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode(data({ choices: [{ delta: { reasoning_text: "stop-me" } }] })));
        const timer = setTimeout(() => streamController.error(new Error("still open")), 1500);
        init?.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
      },
    }), { status: 200 }),
    { signal: controller.signal },
    model(),
    (event) => {
      if (event.type === "thinking_delta") controller.abort();
    },
  );
  assert.equal(cancelled.message.stopReason, "aborted");
  assert.notEqual(cancelled.message.retryable, true);
  assert.equal(cancelled.message.content[0]?.type === "thinking" ? cancelled.message.content[0].thinking : "", "stop-me");
  assert.equal(cancelled.message.content[0]?.type === "thinking" ? cancelled.message.content[0].thinkingField : "", "reasoning_text");
  assert.equal(cancelled.message.errorMessage?.includes("stop-me"), false);
  assert.equal(cancelled.events.some((event) => event.type === "thinking_end"), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test("the next completions request replays thinking on its field and leaves the source message unchanged", async () => {
  const first = await run(async () => sse([
    data({ choices: [{ delta: { reasoning_content: "plan", reasoning: "plan" } }] }),
    data({ choices: [{ delta: { content: "go" } }] }),
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(first.message.content[0]?.type === "thinking" ? first.message.content[0].thinking : "", "plan");
  assert.equal(textOf(first.message), "go");
  assert.equal(JSON.stringify(first.bodies[0]).includes("reasoning"), false);
  const before = JSON.stringify(first.message);
  Object.freeze(first.message);
  Object.freeze(first.message.content);
  for (const block of first.message.content) Object.freeze(block);

  const second = await run(
    async () => sse([
      data({ choices: [{ delta: { content: "next" } }] }),
      data({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]),
    {},
    model(),
    undefined,
    { messages: [first.message, { role: "user", content: "continue", timestamp: 2 }] },
  );
  assert.equal(textOf(second.message), "next");
  const replay = second.bodies[0]?.messages;
  assert.ok(Array.isArray(replay));
  const assistant = replay.find((item) => isRecord(item) && item.role === "assistant");
  assert.ok(assistant && isRecord(assistant));
  assert.equal(assistant.reasoning_content, "plan");
  assert.equal(assistant.content, "go");
  assert.equal("reasoning" in assistant, false);
  assert.equal("reasoning_text" in assistant, false);
  assert.equal(JSON.stringify(first.message), before);

  const illegal = await run(
    async () => sse([
      data({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]),
    {},
    model(),
    undefined,
    { messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "one", thinkingField: "reasoning_content" },
        { type: "thinking", thinking: "two", thinkingField: "reasoning" },
        { type: "thinking", thinking: "three", thinkingField: "reasoning_content" },
        { type: "thinking", thinking: "hidden", thinkingField: "apiKey" as never },
        { type: "text", text: "visible" },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    }, { role: "user", content: "continue", timestamp: 2 }] },
  );
  const history = illegal.bodies[0]?.messages;
  assert.ok(Array.isArray(history));
  const prior = history.find((item) => isRecord(item) && item.role === "assistant");
  assert.ok(prior && isRecord(prior));
  assert.equal(prior.reasoning_content, "one\nthree");
  assert.equal(prior.reasoning, "two");
  assert.equal(prior.content, "hiddenvisible");
  assert.equal("apiKey" in prior, false);
  assert.equal("reasoning_text" in prior, false);
  assert.equal(JSON.stringify(illegal.bodies[0]).includes("reasoning_details"), false);

  const only = await run(
    async () => sse([
      data({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]),
    {},
    model(),
    undefined,
    { messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "only", thinkingField: "reasoning_text" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    }, { role: "user", content: "continue", timestamp: 2 }] },
  );
  const alone = only.bodies[0]?.messages;
  assert.ok(Array.isArray(alone));
  const thought = alone.find((item) => isRecord(item) && item.role === "assistant");
  assert.ok(thought && isRecord(thought));
  assert.equal(thought.content, null);
  assert.equal(thought.reasoning_text, "only");
  assert.equal("reasoning_content" in thought, false);
  assert.equal("reasoning" in thought, false);
});

test("one chunk places text before thinking, and a length stop still ends that block", async () => {
  const mixed = await run(async () => sse([
    data({ choices: [{ delta: { content: "say", reasoning_content: "think", reasoning: "nope" } }] }),
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.deepEqual(mixed.message.content.map((block) => block.type), ["text", "thinking"]);
  assert.equal(textOf(mixed.message), "say");
  assert.equal(mixed.message.content[1]?.type === "thinking" ? mixed.message.content[1].thinking : "", "think");
  assert.equal(mixed.message.content[1]?.type === "thinking" ? mixed.message.content[1].thinkingField : "", "reasoning_content");
  assert.equal(JSON.stringify(mixed.message).includes("nope"), false);
  assert.deepEqual(mixed.events.flatMap((event) => event.type === "text_delta" || event.type === "thinking_delta" ? [[event.contentIndex, event.delta]] : []), [[0, "say"], [1, "think"]]);

  const length = await run(async () => sse([
    data({ choices: [{ delta: { reasoning: "cut" } }] }),
    data({ choices: [{ finish_reason: "length" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(length.message.stopReason, "length");
  assert.equal(length.message.content[0]?.type === "thinking" ? length.message.content[0].thinking : "", "cut");
  assert.equal(length.events.filter((event) => event.type === "thinking_end").length, 1);

  const withTool = await run(async () => sse([
    data({ choices: [{ delta: { reasoning_content: "why", tool_calls: [{ index: 3, id: "call_9", function: { name: "read", arguments: "{}" } }] } }] }),
    data({ choices: [{ finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]));
  assert.equal(withTool.message.stopReason, "toolUse");
  assert.deepEqual(withTool.message.content.map((block) => block.type), ["thinking", "toolCall"]);
  assert.equal(withTool.message.content[0]?.type === "thinking" ? withTool.message.content[0].thinking : "", "why");
  assert.equal(withTool.message.content[1]?.type === "toolCall" ? withTool.message.content[1].name : "", "read");
  assert.deepEqual([...new Set(indexes(withTool.events, "toolcall_"))], [1]);
});

const PNG = "aaaa";
const JPEG = "bbbb";

function image(mimeType: string, data: string) {
  return { type: "image" as const, mimeType, data };
}

function userParts(body: Record<string, unknown> | undefined): unknown {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return undefined;
  const user = messages.find((item) => isRecord(item) && item.role === "user");
  return isRecord(user) ? user.content : undefined;
}

test("a vision model sends image data URLs in source order and leaves the message unchanged", async () => {
  const vision = model({ id: "vision", input: ["text", "image"], contextWindow: 32_000, maxTokens: 1024 });
  const stop = async () => sse([
    data({ choices: [{ delta: { content: "seen" } }] }),
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);
  const block = image("image/png", PNG);
  const source = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "look" }, block, image("image/jpeg", JPEG), { type: "text" as const, text: "tail" }],
    timestamp: 1,
  };
  const before = JSON.stringify(source);
  Object.freeze(source);
  Object.freeze(source.content);
  Object.freeze(block);
  const mixed = await run(stop, {}, vision, undefined, { messages: [source] });
  assert.equal(mixed.message.stopReason, "stop");
  assert.equal(mixed.calls, 1);
  assert.deepEqual(userParts(mixed.bodies[0]), [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
    { type: "text", text: "tail" },
  ]);
  assert.equal(JSON.stringify(mixed.bodies[0]).includes("[image]"), false);
  assert.equal(JSON.stringify(source), before);

  const imageFirst = await run(stop, {}, vision, undefined, {
    messages: [{ role: "user", content: [image("image/png", PNG), { type: "text", text: "after" }], timestamp: 1 }],
  });
  assert.deepEqual(userParts(imageFirst.bodies[0]), [
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    { type: "text", text: "after" },
  ]);

  const only = await run(stop, {}, vision, undefined, {
    messages: [{ role: "user", content: [image("image/png", PNG)], timestamp: 1 }],
  });
  assert.deepEqual(userParts(only.bodies[0]), [
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);

  const plain = await run(stop, {}, vision, undefined, {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
  assert.equal(userParts(plain.bodies[0]), "hello");

  const projected = await run(stop, {}, model(), undefined, {
    messages: [{ role: "user", content: "[image]", timestamp: 1 }],
  });
  assert.equal(projected.calls, 1);
  assert.equal(userParts(projected.bodies[0]), "[image]");
});

test("unsupported and malformed images fail before fetch and do not echo the input", async () => {
  const secret = "secret prompt";
  const refused = await run(async () => {
    throw new Error("fetch should not run");
  }, {}, model(), undefined, {
    messages: [{ role: "user", content: [{ type: "text", text: secret }, image("image/png", PNG)], timestamp: 1 }],
  });
  assert.equal(refused.calls, 0);
  assert.equal(refused.message.stopReason, "error");
  assert.notEqual(refused.message.retryable, true);
  assert.notEqual(refused.message.overflow, true);
  assert.match(refused.message.errorMessage ?? "", /does not accept image input/);
  assert.equal(refused.message.errorMessage?.includes(PNG), false);
  assert.equal(refused.message.errorMessage?.includes(secret), false);

  const vision = model({ id: "vision", input: ["text", "image"], contextWindow: 32_000, maxTokens: 1024 });
  const malformed: Array<{ content: UserContent[]; pattern: RegExp }> = [
    { content: [{ type: "image", mimeType: "", data: PNG }], pattern: /mime type/ },
    { content: [image("image/png", "")], pattern: /base64 data/ },
    { content: [image("image/png", "not valid!")], pattern: /base64 data/ },
    { content: [image("not a mime", PNG)], pattern: /mime type/ },
  ];
  for (const { content, pattern } of malformed) {
    const failed = await run(async () => {
      throw new Error("fetch should not run");
    }, {}, vision, undefined, { messages: [{ role: "user", content, timestamp: 1 }] });
    assert.equal(failed.calls, 0, String(pattern));
    assert.equal(failed.message.stopReason, "error");
    assert.notEqual(failed.message.retryable, true);
    assert.notEqual(failed.message.overflow, true);
    assert.match(failed.message.errorMessage ?? "", pattern);
    assert.doesNotMatch(failed.message.errorMessage ?? "", /does not accept image input/);
    assert.equal(failed.message.errorMessage?.includes(PNG), false);
    assert.equal(failed.message.errorMessage?.includes("not valid"), false);
  }

  const tight = await run(async () => {
    throw new Error("fetch should not run");
  }, {}, model({ input: ["text", "image"], contextWindow: 100, maxTokens: 16 }), undefined, {
    messages: [{ role: "user", content: [image("image/png", PNG)], timestamp: 1 }],
  });
  assert.equal(tight.calls, 0);
  assert.equal(tight.message.overflow, true);
  assert.notEqual(tight.message.retryable, true);
  assert.match(tight.message.errorMessage ?? "", /cannot fit/);
  assert.equal(tight.message.errorMessage?.includes(PNG), false);
});

test("provider and models entries send a declared image and refuse an undeclared one", async () => {
  const stop = async () => sse([
    data({ choices: [{ finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);
  let providerCalls = 0;
  const providerBodies: Array<Record<string, unknown>> = [];
  const compat = createModels({ env: { COMPAT_KEY: "sk-test" } });
  compat.setProvider(completionsProvider({
    id: "compat",
    name: "compat",
    baseUrl: "https://example.test/v1",
    env: "COMPAT_KEY",
    fetch: async (_input, init) => {
      providerCalls += 1;
      if (init?.body) providerBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return stop();
    },
    modelIds: ["see", "blind"],
    models: {
      see: { contextWindow: 8000, maxTokens: 256, input: ["text", "image"] },
      blind: { contextWindow: 8000, maxTokens: 256 },
    },
  }));
  const seeing = compat.getModel("compat", "see");
  const blind = compat.getModel("compat", "blind");
  assert.ok(seeing && blind);
  assert.deepEqual(blind.input, ["text"]);
  const seen = await compat.stream(seeing, {
    messages: [{ role: "user", content: [image("image/png", PNG)], timestamp: 1 }],
  }).result();
  assert.equal(seen.stopReason, "stop");
  assert.deepEqual(userParts(providerBodies[0]), [
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);
  const hidden = await compat.stream(blind, {
    messages: [{ role: "user", content: [image("image/png", PNG)], timestamp: 1 }],
  }).result();
  assert.equal(hidden.stopReason, "error");
  assert.match(hidden.errorMessage ?? "", /does not accept image input/);
  assert.equal(providerCalls, 1);

  let modelCalls = 0;
  const modelBodies: Array<Record<string, unknown>> = [];
  const models = createModels({ env: { OPENAI_API_KEY: "sk-test" } });
  models.setProvider(openaiProvider({
    modelIds: ["gpt-4o-mini", "vision-test"],
    models: {
      "vision-test": { contextWindow: 8000, maxTokens: 256, input: ["text", "image"] },
    },
    fetch: async (_input, init) => {
      modelCalls += 1;
      if (init?.body) modelBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return stop();
    },
  }));
  const custom = models.getModel("openai", "vision-test");
  const known = models.getModel("openai", "gpt-4o-mini");
  assert.ok(custom && known);
  assert.deepEqual(known.input, ["text"]);
  const customResult = await models.stream(custom, {
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, image("image/png", PNG)], timestamp: 1 }],
  }).result();
  assert.equal(customResult.stopReason, "stop");
  assert.deepEqual(userParts(modelBodies[0]), [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);
  const knownResult = await models.stream(known, {
    messages: [{ role: "user", content: [image("image/png", PNG)], timestamp: 1 }],
  }).result();
  assert.equal(knownResult.stopReason, "error");
  assert.match(knownResult.errorMessage ?? "", /does not accept image input/);
  assert.notEqual(knownResult.retryable, true);
  assert.equal(modelCalls, 1);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
