import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type AssistantEvent, type AssistantMessage, type Context, type ToolDefinition } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { checkAssistantStream } from "@amazme/ai/testing";

/**
 * Offline replay of the documented DeepSeek chat-completions stream.
 * Frames are hand-written. Nothing calls api.deepseek.com and no API key is used.
 */

const KEY = "sk-replay";
const STREAM_ID = "1f633d8bfc032625086f14113c411638";
const DATE_ID = "call_00_kw66qNnNto11bSfJVIdlV5Oo";
const WEATHER_ID = "call_00_H2SCW6136vWJGq9SQlBuhVt4";
const REASON_DATE = "The user is asking about the weather in Hangzhou tomorrow. I need to get tomorrow's date first, then call the weather function.";
const REASON_DATE_A = "The user is asking about the weather in Hangzhou tomorrow. ";
const REASON_DATE_B = "I need to get tomorrow's date first, then call the weather function.";
const ANSWER_DATE = "Let me check tomorrow's weather in Hangzhou for you.";
const REASON_WEATHER = "Today is 2026-04-19, so tomorrow is 2026-04-20. Now I'll call the weather function for Hangzhou.";
const REASON_WEATHER_A = "Today is 2026-04-19, so tomorrow is 2026-04-20. ";
const REASON_WEATHER_B = "Now I'll call the weather function for Hangzhou.";
const WEATHER_ARGS = '{"location": "Hangzhou", "date": "2026-04-20"}';
const WEATHER_ARGS_HEAD = '{"location": "Hang';
const WEATHER_ARGS_TAIL = 'zhou", "date": "2026-04-20"}';

const TOOLS: ToolDefinition[] = [
  {
    name: "get_date",
    description: "Get the current date",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_weather",
    description: "Get weather of a location, the user should supply the location and date.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The city name" },
        date: { type: "string", description: "The date in format YYYY-mm-dd" },
      },
      required: ["location", "date"],
    },
  },
];

const USER = { role: "user" as const, content: "How's the weather in Hangzhou Tomorrow", timestamp: 1 };

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: STREAM_ID,
    object: "chat.completion.chunk",
    created: 1718345013,
    model: "deepseek-flash",
    system_fingerprint: "fp_a49d71b8a1",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function responseOf(frames: readonly string[], options: { splitFrame?: number; tail?: string } = {}): Response {
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];
  frames.forEach((frame, index) => {
    const bytes = encoder.encode(frame);
    if (index === options.splitFrame) {
      const mid = Math.max(1, Math.floor(bytes.length / 2));
      pieces.push(bytes.slice(0, mid), bytes.slice(mid));
    } else {
      pieces.push(bytes);
    }
  });
  if (options.tail) pieces.push(encoder.encode(options.tail));
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assistants(body: unknown): Array<Record<string, unknown>> {
  assert.ok(isRecord(body) && Array.isArray(body.messages));
  return body.messages.filter((item): item is Record<string, unknown> => isRecord(item) && item.role === "assistant");
}

async function settle(
  stream: AsyncIterable<AssistantEvent> & { result: () => Promise<AssistantMessage> },
  limitMs: number,
): Promise<{ message: AssistantMessage; events: AssistantEvent[] }> {
  const events: AssistantEvent[] = [];
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const message = await Promise.race([
    (async () => {
      for await (const event of stream) events.push(event);
      return stream.result();
    })(),
    new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(timeout), limitMs);
    }),
  ]);
  clearTimeout(timer);
  if (typeof message === "symbol") assert.fail("stream did not settle");
  return { message, events };
}

function replay(handler: typeof fetch) {
  const seen: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.deepseek.com/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${KEY}`);
    const body = JSON.parse(String(init?.body)) as unknown;
    assert.ok(isRecord(body));
    seen.push(body);
    return handler(input, init);
  };
  const models = createModels({ env: { DEEPSEEK_API_KEY: KEY } });
  models.setProvider(deepseekProvider({ fetch: fetchImpl }));
  const model = models.getModel("deepseek", "deepseek-flash");
  assert.ok(model);
  assert.deepEqual(model.cost, { input: 0.3, output: 1.2, cacheRead: 0.006 });
  return { models, model, seen };
}

function context(messages: Context["messages"]): Context {
  return { messages, tools: TOOLS };
}

test("thinking-mode tool calls assemble across frames and the next request replays each reasoning_content once", async () => {
  assert.equal(WEATHER_ARGS_HEAD + WEATHER_ARGS_TAIL, WEATHER_ARGS);
  const dateUsage = {
    completion_tokens: 10,
    prompt_tokens: 16,
    total_tokens: 26,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 16,
  };
  const weatherUsage = {
    completion_tokens: 12,
    prompt_tokens: 40,
    total_tokens: 52,
    prompt_tokens_details: { cached_tokens: 16 },
    prompt_cache_hit_tokens: 16,
    prompt_cache_miss_tokens: 24,
  };
  const scripts = [
    [
      chunk({ role: "assistant", content: "", reasoning_content: REASON_DATE_A }, null),
      chunk({ reasoning_content: REASON_DATE_B }, null),
      chunk({ content: ANSWER_DATE }, null),
      chunk({ tool_calls: [{ index: 0, id: DATE_ID, type: "function", function: { name: "get_date", arguments: "" } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, null),
      chunk({ content: "", role: null }, "tool_calls", dateUsage),
      DONE,
    ],
    [
      chunk({ role: "assistant", content: null, reasoning_content: REASON_WEATHER_A }, null),
      chunk({ reasoning_content: REASON_WEATHER_B }, null),
      chunk({ tool_calls: [{ index: 0, id: WEATHER_ID, type: "function", function: { name: "get_weather", arguments: WEATHER_ARGS_HEAD } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: WEATHER_ARGS_TAIL } }] }, null),
      chunk({ content: "" }, "tool_calls", weatherUsage),
      DONE,
    ],
    [
      chunk({ role: "assistant", content: "", reasoning_content: "The weather result is in." }, null),
      chunk({ content: "Cloudy 7~13°C" }, null),
      chunk({ content: "" }, "stop", { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } }),
      DONE,
    ],
  ];
  let turn = 0;
  const { models, model, seen } = replay(async () => responseOf(scripts[turn++] ?? [], { splitFrame: 1 }));
  const first = await settle(models.stream(model, context([USER]), { thinkingLevel: "high" }), 1_000);
  assert.deepEqual(checkAssistantStream(first.events), []);
  assert.equal(first.message.stopReason, "toolUse");
  assert.equal(first.message.content.filter((block) => block.type === "thinking").length, 1);
  const thought = first.message.content[0];
  assert.ok(thought && thought.type === "thinking");
  assert.equal(thought.thinking, REASON_DATE);
  assert.equal(thought.thinkingField, "reasoning_content");
  const answer = first.message.content[1];
  assert.ok(answer && answer.type === "text");
  assert.equal(answer.text, ANSWER_DATE);
  const call = first.message.content[2];
  assert.ok(call && call.type === "toolCall");
  assert.equal(call.id, DATE_ID);
  assert.equal(call.name, "get_date");
  assert.deepEqual(call.arguments, {});
  assert.equal(first.message.usage.input, 16);
  assert.equal(first.message.usage.cacheRead, 0);
  assert.equal(first.message.usage.output, 10);
  assert.equal(Object.hasOwn(first.message.usage, "reasoning"), false);
  const before = JSON.stringify(first.message);
  Object.freeze(first.message);

  assert.equal(seen[0]?.model, "deepseek-flash");
  assert.equal(seen[0]?.reasoning_effort, "high");
  assert.deepEqual(seen[0]?.thinking, { type: "enabled" });
  assert.deepEqual(seen[0]?.stream_options, { include_usage: true });
  assert.equal(seen[0]?.max_tokens, model.maxTokens);
  assert.equal("max_completion_tokens" in (seen[0] ?? {}), false);
  assert.equal(JSON.stringify(seen[0]).includes("reasoning_content"), false);
  assert.ok(Array.isArray(seen[0]?.tools) && seen[0]?.tools.length === 2);

  const second = await settle(models.stream(model, context([
    USER,
    first.message,
    { role: "toolResult", toolCallId: DATE_ID, toolName: "get_date", content: [{ type: "text", text: "2026-04-19" }], isError: false, timestamp: 2 },
  ]), { thinkingLevel: "high" }), 1_000);
  assert.equal(JSON.stringify(first.message), before);
  assert.deepEqual(checkAssistantStream(second.events), []);
  assert.equal(second.message.stopReason, "toolUse");
  const weatherThought = second.message.content[0];
  assert.ok(weatherThought && weatherThought.type === "thinking");
  assert.equal(weatherThought.thinking, REASON_WEATHER);
  assert.equal(weatherThought.thinkingField, "reasoning_content");
  const weather = second.message.content[1];
  assert.ok(weather && weather.type === "toolCall");
  assert.equal(weather.id, WEATHER_ID);
  assert.equal(weather.name, "get_weather");
  assert.deepEqual(weather.arguments, { location: "Hangzhou", date: "2026-04-20" });
  assert.equal(second.message.usage.input, 24);
  assert.equal(second.message.usage.cacheRead, 16);

  const prior = assistants(seen[1]);
  assert.equal(prior.length, 1);
  const replayed = prior[0];
  assert.ok(replayed);
  assert.equal(replayed.reasoning_content, REASON_DATE);
  assert.equal(replayed.content, ANSWER_DATE);
  assert.equal(occurrences(JSON.stringify(replayed), REASON_DATE), 1);
  assert.equal("reasoning" in replayed, false);
  assert.equal("reasoning_text" in replayed, false);
  assert.deepEqual(replayed.tool_calls, [{
    id: DATE_ID,
    type: "function",
    function: { name: "get_date", arguments: "{}" },
  }]);

  const third = await settle(models.stream(model, context([
    USER,
    first.message,
    { role: "toolResult", toolCallId: DATE_ID, toolName: "get_date", content: [{ type: "text", text: "2026-04-19" }], isError: false, timestamp: 2 },
    second.message,
    { role: "toolResult", toolCallId: WEATHER_ID, toolName: "get_weather", content: [{ type: "text", text: "Cloudy 7~13°C" }], isError: false, timestamp: 3 },
  ]), { thinkingLevel: "high" }), 1_000);
  assert.equal(third.message.stopReason, "stop");
  assert.equal(third.message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(""), "Cloudy 7~13°C");
  const history = assistants(seen[2]);
  assert.equal(history.length, 2);
  const [firstWire, secondWire] = history;
  assert.ok(firstWire && secondWire);
  assert.equal(firstWire.reasoning_content, REASON_DATE);
  assert.equal(secondWire.reasoning_content, REASON_WEATHER);
  assert.equal(secondWire.content, null);
  assert.equal(occurrences(JSON.stringify(history), REASON_DATE), 1);
  assert.equal(occurrences(JSON.stringify(history), REASON_WEATHER), 1);
  assert.equal(JSON.stringify(firstWire).includes(REASON_WEATHER), false);
  assert.equal(JSON.stringify(secondWire).includes(REASON_DATE), false);
  assert.equal(occurrences(JSON.stringify(secondWire.tool_calls), "get_weather"), 1);
  assert.ok(Array.isArray(seen[2]?.tools));
  assert.deepEqual(seen[1]?.thinking, { type: "enabled" });
  assert.equal(seen[1]?.reasoning_effort, "high");
  assert.deepEqual(seen[2]?.thinking, { type: "enabled" });
  assert.equal(seen[2]?.reasoning_effort, "high");
});

test("deepseek-flash high and low enable thinking with that effort, and off disables it without effort", async () => {
  const stop = [
    chunk({ reasoning_content: "plan", content: "ok" }, null),
    chunk({}, "stop"),
    DONE,
  ];
  const cases = [
    { level: "high" as const, effort: "high" },
    { level: "low" as const, effort: "low" },
  ];
  for (const item of cases) {
    const { models, model, seen } = replay(async () => responseOf(stop));
    const { message } = await settle(models.stream(model, context([USER]), { thinkingLevel: item.level }), 1_000);
    assert.equal(message.stopReason, "stop", item.level);
    const thought = message.content.find((block) => block.type === "thinking");
    assert.ok(thought && thought.type === "thinking", item.level);
    assert.equal(thought.thinking, "plan", item.level);
    assert.equal(thought.thinkingField, "reasoning_content", item.level);
    assert.deepEqual(seen[0]?.thinking, { type: "enabled" }, item.level);
    assert.equal(seen[0]?.reasoning_effort, item.effort, item.level);
  }

  const off = replay(async () => responseOf([
    chunk({ content: "plain" }, null),
    chunk({}, "stop"),
    DONE,
  ]));
  const disabled = await settle(off.models.stream(off.model, context([USER]), { thinkingLevel: "off" }), 1_000);
  assert.equal(disabled.message.stopReason, "stop");
  assert.equal(disabled.message.content.some((block) => block.type === "thinking"), false);
  assert.deepEqual(off.seen[0]?.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in (off.seen[0] ?? {}), false);
  assert.equal(JSON.stringify(off.seen[0]).includes("none"), false);

  const overridden = replay(async () => responseOf([
    chunk({ content: "plain" }, null),
    chunk({}, "stop"),
    DONE,
  ]));
  const stillOff = await settle(overridden.models.stream(overridden.model, context([USER]), {
    thinkingLevel: "off",
    reasoningEffort: "high",
  }), 1_000);
  assert.equal(stillOff.message.stopReason, "stop");
  assert.deepEqual(overridden.seen[0]?.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in (overridden.seen[0] ?? {}), false);
});

test("deepseek-flash rejects a thinking level the chat API would rewrite", async () => {
  for (const level of ["minimal", "medium"] as const) {
    const { models, model, seen } = replay(async () => {
      throw new Error("fetch should not run");
    });
    const { message } = await settle(models.stream(model, context([USER]), { thinkingLevel: level }), 1_000);
    assert.equal(seen.length, 0, level);
    assert.equal(message.stopReason, "error", level);
    assert.notEqual(message.retryable, true, level);
    assert.match(message.errorMessage ?? "", new RegExp(`Thinking level "${level}" is not supported by deepseek-flash`), level);
  }

  const rewritten = replay(async () => {
    throw new Error("fetch should not run");
  });
  const effort = await settle(rewritten.models.stream(rewritten.model, context([USER]), {
    thinkingLevel: "high",
    reasoningEffort: "medium",
  }), 1_000);
  assert.equal(rewritten.seen.length, 0);
  assert.equal(effort.message.stopReason, "error");
  assert.notEqual(effort.message.retryable, true);
  assert.match(effort.message.errorMessage ?? "", /Thinking effort "medium" is not supported by deepseek-flash/);
});

test("cache hit and miss costs follow the deepseek-flash catalog, and a reported zero stays zero", async () => {
  const run = (usage: Record<string, unknown>) => {
    const { models, model } = replay(async () => responseOf([
      chunk({ content: "Hi" }, null),
      chunk({}, "stop", usage),
      DONE,
    ]));
    return settle(models.stream(model, context([USER]), { thinkingLevel: "high" }), 1_000);
  };
  const hit = await run({
    prompt_tokens: 1_000_000,
    completion_tokens: 500_000,
    total_tokens: 1_500_000,
    prompt_tokens_details: { cached_tokens: 500_000 },
    prompt_cache_hit_tokens: 500_000,
    prompt_cache_miss_tokens: 500_000,
  });
  assert.equal(hit.message.stopReason, "stop");
  assert.equal(hit.message.usage.input, 500_000);
  assert.equal(hit.message.usage.cacheRead, 500_000);
  assert.equal(hit.message.usage.output, 500_000);
  assert.equal(Object.hasOwn(hit.message.usage, "cacheWrite"), false);
  // 5e5 / 1e6 × 0.3 = 0.15, × 0.006 = 0.003, output × 1.2 = 0.6. No cache-write count.
  assert.deepEqual(hit.message.usage.cost, { input: 0.15, output: 0.6, total: 0.753 });

  const miss = await run({
    prompt_tokens: 1_000_000,
    completion_tokens: 500_000,
    total_tokens: 1_500_000,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 1_000_000,
  });
  assert.equal(miss.message.usage.input, 1_000_000);
  assert.equal(miss.message.usage.cacheRead, 0);
  assert.equal(miss.message.usage.output, 500_000);
  // Hit count is a reported 0, so that charge is 0. 1e6 / 1e6 × 0.3 = 0.3, output × 1.2 / 2 = 0.6.
  // 0.3 + 0.6 is not the decimal 0.9 in IEEE-754, so compare the sum of the two quoted charges.
  assert.equal(miss.message.usage.cost.input, 0.3);
  assert.equal(miss.message.usage.cost.output, 0.6);
  assert.equal(miss.message.usage.cost.total, 0.3 + 0.6);

  const zero = await run({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  });
  assert.equal(zero.message.usage.cacheRead, 0);
  assert.equal(typeof zero.message.usage.cost.total, "number");
  assert.deepEqual(zero.message.usage.cost, { input: 0, output: 0, total: 0 });
});

test("a deepseek-flash stream with no usage object leaves the quote empty", async () => {
  const { models, model } = replay(async () => responseOf([
    chunk({ content: "Hi" }, null),
    chunk({}, "stop"),
    DONE,
  ]));
  const { message } = await settle(models.stream(model, context([USER]), { thinkingLevel: "high" }), 1_000);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.input, 0);
  assert.equal(message.usage.output, 0);
  assert.equal(message.usage.totalTokens, 0);
  assert.equal(Object.hasOwn(message.usage, "cacheRead"), false);
  assert.equal(message.usage.cost.total, null);
  assert.notEqual(message.usage.cost.total, 0);
  assert.notDeepEqual(message.usage.cost, { input: 0, output: 0, total: 0 });
});

test("deepseek-flash http failures keep the transport category, and a mid-stream abort is not an error", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const cases: Array<{ name: string; status: number; error: unknown; kind: string; retryable: boolean; overflow: boolean }> = [
    {
      name: "401",
      status: 401,
      error: { message: "Authentication Fails, Your api key: **** is invalid", type: "authentication_error", param: null, code: "invalid_request_error" },
      kind: "authentication",
      retryable: false,
      overflow: false,
    },
    {
      name: "429",
      status: 429,
      error: { message: "Rate limit reached for requests", type: "rate_limit_error", param: null, code: "rate_limit_exceeded" },
      kind: "rate_limit",
      retryable: true,
      overflow: false,
    },
    {
      name: "500",
      status: 500,
      error: { message: "Internal Server Error", type: "server_error", param: null, code: null },
      kind: "unavailable",
      retryable: true,
      overflow: false,
    },
    {
      name: "502",
      status: 502,
      error: { message: "Bad gateway", type: "server_error", param: null, code: null },
      kind: "unavailable",
      retryable: true,
      overflow: false,
    },
    {
      name: "503",
      status: 503,
      error: { message: "The engine is currently overloaded", type: "server_error", param: null, code: null },
      kind: "unavailable",
      retryable: true,
      overflow: false,
    },
    {
      name: "504",
      status: 504,
      error: { message: "Gateway timeout", type: "server_error", param: null, code: null },
      kind: "unavailable",
      retryable: true,
      overflow: false,
    },
    {
      name: "context",
      status: 400,
      error: {
        message: "This model's maximum context length is 1000000 tokens. However, you requested 1000001 tokens (1000000 in the messages, 1 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      },
      kind: "overflow",
      retryable: false,
      overflow: true,
    },
  ];
  for (const item of cases) {
    const { models, model } = replay(async () => new Response(JSON.stringify({ error: item.error }), {
      status: item.status,
      headers: { "content-type": "application/json" },
    }));
    const { message, events } = await settle(models.stream(model, context([USER]), { thinkingLevel: "high" }), 1_000);
    assert.equal(message.stopReason, "error", item.name);
    assert.equal(message.retryable === true, item.retryable, item.name);
    assert.equal(message.overflow === true, item.overflow, item.name);
    assert.match(message.errorMessage ?? "", new RegExp(`${item.status} ${item.kind}`), item.name);
    assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1, item.name);
  }

  const streamed = replay(async () => responseOf([
    chunk({ reasoning_content: "kept" }, null),
    `data: ${JSON.stringify({ error: { message: "This model's maximum context length is 1000000 tokens.", type: "invalid_request_error", code: "invalid_request_error" } })}\n\n`,
  ]));
  const partial = await settle(streamed.models.stream(streamed.model, context([USER]), { thinkingLevel: "high" }), 1_000);
  assert.equal(partial.message.stopReason, "error");
  assert.equal(partial.message.overflow, true);
  assert.notEqual(partial.message.retryable, true);
  assert.equal(partial.message.content[0]?.type === "thinking" ? partial.message.content[0].thinking : "", "kept");

  const controller = new AbortController();
  const encoder = new TextEncoder();
  const cancelled = replay(async (_input, init) => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode(chunk({ reasoning_content: "stop-me" }, null)));
      const timer = setTimeout(() => streamController.error(new Error("still open")), 1_500);
      init?.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  const stream = cancelled.models.stream(cancelled.model, context([USER]), {
    thinkingLevel: "high",
    signal: controller.signal,
  });
  const events: AssistantEvent[] = [];
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const message = await Promise.race([
    (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "thinking_delta") controller.abort();
      }
      return stream.result();
    })(),
    new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(timeout), 2_000);
    }),
  ]);
  clearTimeout(timer);
  if (typeof message === "symbol") assert.fail("mid-stream abort did not settle");
  assert.equal(message.stopReason, "aborted");
  assert.notEqual(message.retryable, true);
  assert.notEqual(message.overflow, true);
  assert.equal(message.content[0]?.type === "thinking" ? message.content[0].thinking : "", "stop-me");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(events.filter((event) => event.type === "error").length, 1);

  const server = replay(async () => responseOf([
    chunk({ reasoning_content: "interrupted" }, null),
    chunk({ content: "" }, "aborted"),
    DONE,
  ]));
  const serverAbort = await settle(server.models.stream(server.model, context([USER]), { thinkingLevel: "high" }), 1_000);
  assert.equal(serverAbort.message.stopReason, "aborted");
  assert.notEqual(serverAbort.message.retryable, true);
  assert.equal(serverAbort.message.content[0]?.type === "thinking" ? serverAbort.message.content[0].thinking : "", "interrupted");
  assert.equal(serverAbort.events.some((event) => event.type === "done"), false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test("a deepseek-flash stream cut before [DONE] is retryable and does not hang", async () => {
  const closed = replay(async () => responseOf([
    chunk({ reasoning_content: "partial" }, null),
    chunk({ content: "Hel" }, null),
  ]));
  const cut = await settle(closed.models.stream(closed.model, context([USER]), { thinkingLevel: "high" }), 500);
  assert.equal(cut.message.stopReason, "error");
  assert.equal(cut.message.retryable, true);
  assert.notEqual(cut.message.overflow, true);
  assert.match(cut.message.errorMessage ?? "", /finish reason/);
  assert.equal(cut.message.content[0]?.type === "thinking" ? cut.message.content[0].thinking : "", "partial");
  assert.equal(cut.message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(""), "Hel");
  assert.equal(cut.message.usage.cost.total, null);
  assert.notEqual(cut.message.usage.cost.total, 0);
  assert.equal(cut.events.filter((event) => event.type === "done" || event.type === "error").length, 1);

  const torn = replay(async () => responseOf([
    chunk({ reasoning_content: "kept" }, null),
  ], { tail: 'data: {"id":"1f633d8bfc032625086f14113c411638","choices":[{"delta":{"content":"Hel"' }));
  const mid = await settle(torn.models.stream(torn.model, context([USER]), { thinkingLevel: "high" }), 500);
  assert.equal(mid.message.stopReason, "error");
  assert.equal(mid.message.retryable, true);
  assert.notEqual(mid.message.overflow, true);
  assert.match(mid.message.errorMessage ?? "", /malformed/);
  assert.equal(mid.message.content[0]?.type === "thinking" ? mid.message.content[0].thinking : "", "kept");
  assert.equal(mid.events.filter((event) => event.type === "done" || event.type === "error").length, 1);
});
