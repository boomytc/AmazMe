import assert from "node:assert/strict";
import test from "node:test";
import { NOOP_TELEMETRY_CONTEXT } from "@amazme/telemetry";
import {
  contextSafetyMargin,
  createModels,
  createProvider,
  estimateRequestTokens,
  IMAGE_TOKEN_COST,
  MESSAGE_OVERHEAD_TOKENS,
  resolveOutputBudget,
  transformMessages,
  type AssistantMessage,
  type Context,
  type JsonSchema,
  type Message,
  type Model,
  type UserContent,
} from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { completionsProvider } from "@amazme/ai/providers/completions";
import { openaiProvider } from "@amazme/ai/providers/openai";

function model(extra: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
  return {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    provider: "openai",
    api: "openai-completions",
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0 },
    ...extra,
  };
}

function user(content: string | UserContent[]): Message {
  return { role: "user", content, timestamp: 1 };
}

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: extra.usage ?? { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: extra.stopReason ?? "stop",
    timestamp: 1,
    ...extra,
  };
}

function sse(chunks: string[]): Response {
  return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function outputField(body: Record<string, unknown>): { name: string; value: unknown } {
  const names = ["max_completion_tokens", "max_tokens"].filter((name) => name in body);
  assert.equal(names.length, 1);
  const name = names[0] ?? "";
  return { name, value: body[name] };
}

test("the shared output budget includes tool results synthesized by request projection", () => {
  const active = model({ contextWindow: 100, maxTokens: 32 });
  const context: Context = { messages: [assistant([
    { type: "toolCall", id: "call_1", name: "work", arguments: {} },
  ])] };
  const projected = { ...context, messages: transformMessages(context.messages, active) };
  const budget = resolveOutputBudget(active, context, 32);
  assert.equal(budget.estimatedInput, estimateRequestTokens(projected));
  assert.equal(budget.outputCap, resolveOutputBudget(active, projected, 32).outputCap);
  assert.equal(context.messages.length, 1);
});

test("the safety margin scales down for a small window", () => {
  assert.equal(contextSafetyMargin(1_000), 50);
  assert.equal(contextSafetyMargin(128_000), 4_096);
  assert.equal(contextSafetyMargin(200), 32);
  assert.ok(contextSafetyMargin(200) < 4_096);
});

test("budget numbers distinguish input, requested output, model cap, and remaining room", () => {
  const active = model({ contextWindow: 100, maxTokens: 80 });
  const context: Context = { messages: [user("a".repeat(40))] };
  const budget = resolveOutputBudget(active, context, 70);
  assert.equal(budget.estimatedInput, MESSAGE_OVERHEAD_TOKENS + Math.ceil(40 / 4));
  assert.equal(budget.requestedOutput, 70);
  assert.equal(budget.modelOutputCap, 80);
  assert.equal(budget.remainingOutputRoom, 100 - budget.estimatedInput - contextSafetyMargin(100));
  assert.equal(budget.status, "ok");
  assert.equal(budget.outputCap, Math.min(70, 80, budget.remainingOutputRoom));
  assert.equal(budget.outputCap, 54);
  const omitted = resolveOutputBudget(active, context, undefined);
  assert.equal(omitted.requestedOutput, 80);
  assert.equal(omitted.outputCap, 54);
});

test("schema, tool arguments, tool results, unicode, and images increase the estimate", () => {
  const smallSchema: JsonSchema = { type: "object", properties: { a: { type: "string" } } };
  const base = estimateRequestTokens({ messages: [user("look")] });
  const withSchema = estimateRequestTokens({
    messages: [user("look")],
    tools: [{ name: "read", description: "read a file", parameters: smallSchema }],
  });
  const grown: JsonSchema = {
    type: "object",
    properties: { a: { type: "string" }, note: { type: "string", description: "n".repeat(400) } },
  };
  const withLargeSchema = estimateRequestTokens({
    messages: [user("look")],
    tools: [{ name: "read", description: "read a file", parameters: grown }],
  });
  smallSchema.properties = { ...smallSchema.properties, extra: { type: "string", description: "z".repeat(800) } };
  const afterMutation = estimateRequestTokens({
    messages: [user("look")],
    tools: [{ name: "read", description: "read a file", parameters: smallSchema }],
  });
  const withArgs = estimateRequestTokens({
    messages: [assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "p".repeat(500) } }])],
  });
  const withResult = estimateRequestTokens({
    messages: [{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "r".repeat(500) }], isError: false, timestamp: 1 }],
  });
  const ascii = estimateRequestTokens({ messages: [user("aaaa")] });
  const unicode = estimateRequestTokens({ messages: [user("你你你你")] });
  const image = "A".repeat(8_000);
  const withImage = estimateRequestTokens({
    messages: [user([{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: image }])],
  });
  const shortImage = estimateRequestTokens({
    messages: [user([{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "AA" }])],
  });
  assert.ok(withSchema > base);
  assert.ok(withLargeSchema > withSchema);
  assert.ok(afterMutation > withSchema);
  assert.ok(withArgs > estimateRequestTokens({ messages: [assistant([{ type: "text", text: "ok" }])] }));
  assert.ok(withResult > base);
  assert.ok(unicode > ascii);
  assert.equal(withImage - estimateRequestTokens({ messages: [user([{ type: "text", text: "look" }])] }), IMAGE_TOKEN_COST);
  assert.equal(withImage, shortImage);
  const toolText = estimateRequestTokens({
    messages: [{ role: "toolResult", toolCallId: "call", toolName: "shot", content: [{ type: "text", text: "look" }], isError: false, timestamp: 1 }],
  });
  const toolImage = estimateRequestTokens({
    messages: [{
      role: "toolResult",
      toolCallId: "call",
      toolName: "shot",
      content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: image }],
      isError: false,
      timestamp: 1,
    }],
  });
  const shortToolImage = estimateRequestTokens({
    messages: [{
      role: "toolResult",
      toolCallId: "call",
      toolName: "shot",
      content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "AA" }],
      isError: false,
      timestamp: 1,
    }],
  });
  assert.equal(toolImage - toolText, IMAGE_TOKEN_COST);
  assert.equal(toolImage, shortToolImage);
});

test("a repeated system prompt is counted once, and previous usage is ignored", () => {
  const prompt = "same rules";
  const once = estimateRequestTokens({
    systemPrompt: prompt,
    messages: [{ role: "system", content: prompt, timestamp: 1 }],
  });
  const promptOnly = estimateRequestTokens({ systemPrompt: prompt, messages: [] });
  const messageOnly = estimateRequestTokens({ messages: [{ role: "system", content: prompt, timestamp: 1 }] });
  const both = estimateRequestTokens({
    systemPrompt: prompt,
    messages: [{ role: "system", content: "other rules", timestamp: 1 }],
  });
  assert.equal(once, promptOnly);
  assert.equal(once, messageOnly);
  assert.ok(both > once);
  const text = assistant([{ type: "text", text: "done" }]);
  const cheap = estimateRequestTokens({ messages: [text] });
  const expensive = estimateRequestTokens({
    messages: [assistant([{ type: "text", text: "done" }], {
      usage: { input: 50_000, output: 50_000, totalTokens: 100_000, cost: { input: 0, output: 0, total: 0 } },
    })],
  });
  assert.equal(cheap, expensive);
});

test("thinking that remains in the projected request is counted", () => {
  const kept = estimateRequestTokens({
    messages: [assistant([{ type: "thinking", thinking: "r".repeat(200) }, { type: "text", text: "ok" }])],
  });
  const plain = estimateRequestTokens({ messages: [assistant([{ type: "text", text: "ok" }])] });
  assert.ok(kept > plain);
});

test("invalid caps and unserializable arguments do not call fetch", async () => {
  let calls = 0;
  const api = openaiCompletionsApi({
    fetch: async () => {
      calls += 1;
      return sse(['data: {"choices":[{"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]);
    },
  });
  const active = model();
  const context: Context = { messages: [user("hi")] };
  for (const maxTokens of [0, -3, Number.NaN, 1.5]) {
    const message = await api.stream(active, context, { baseUrl: "https://example.test/v1", apiKey: "sk-test", maxTokens }).result();
    assert.equal(message.stopReason, "error");
    assert.notEqual(message.overflow, true);
    assert.notEqual(message.retryable, true);
    assert.match(message.errorMessage ?? "", /maxTokens/);
  }
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const fnArgs = { run: () => undefined };
  const badContext: Context = {
    messages: [assistant([{ type: "toolCall", id: "call", name: "read", arguments: circular }]), user("continue")],
  };
  const before = structuredClone(badContext.messages[1]);
  const rejected = await api.stream(active, badContext, { baseUrl: "https://example.test/v1", apiKey: "sk-test" }).result();
  assert.equal(calls, 0);
  assert.equal(rejected.stopReason, "error");
  assert.notEqual(rejected.overflow, true);
  assert.match(rejected.errorMessage ?? "", /circular/);
  assert.deepEqual(badContext.messages[1], before);
  const functionContext: Context = {
    messages: [assistant([{ type: "toolCall", id: "call", name: "read", arguments: fnArgs }])],
  };
  const functionRejected = await api.stream(active, functionContext, { baseUrl: "https://example.test/v1", apiKey: "sk-test" }).result();
  assert.equal(functionRejected.stopReason, "error");
  assert.match(functionRejected.errorMessage ?? "", /not JSON-serializable/);
  const local = resolveOutputBudget(active, badContext, undefined);
  assert.equal(local.status, "unserializable");
  const unfit = model({ contextWindow: 40, maxTokens: 8 });
  const crowded = await api.stream(unfit, { messages: [user("c".repeat(80))] }, { baseUrl: "https://example.test/v1", apiKey: "sk-test", maxTokens: 8 }).result();
  assert.equal(calls, 0);
  assert.equal(crowded.overflow, true);
  assert.equal(crowded.stopReason, "error");
  assert.notEqual(crowded.retryable, true);
  assert.match(crowded.errorMessage ?? "", /cannot fit/);
  assert.notEqual(resolveOutputBudget(unfit, { messages: [user("c".repeat(80))] }, 8).status, "invalid_limit");
});

test("the wire receives one output cap from the direct API, createProvider, and Models", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sse(['data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]);
  };
  const direct = openaiCompletionsApi({ fetch: fetchImpl });
  const wide = model();
  const context: Context = { messages: [user("hi")] };
  const snapshot = structuredClone(context);
  await direct.stream(wide, context, {
    baseUrl: "https://example.test/v1",
    apiKey: "sk-secret",
    headers: { "x-tenant": "acme" },
    thinkingLevel: "off",
    telemetryContext: NOOP_TELEMETRY_CONTEXT,
    signal: new AbortController().signal,
  }).result();
  assert.deepEqual(context, snapshot);
  assert.equal(outputField(bodies[0] ?? {}).name, "max_completion_tokens");
  assert.equal(outputField(bodies[0] ?? {}).value, wide.maxTokens);
  assert.equal("max_tokens" in (bodies[0] ?? {}), false);
  const encoded = JSON.stringify(bodies[0]);
  assert.equal(encoded.includes("sk-secret"), false);
  assert.equal(encoded.includes("telemetryContext"), false);
  assert.equal(encoded.includes("x-tenant"), false);
  assert.equal("thinkingLevel" in (bodies[0] ?? {}), false);
  assert.equal("signal" in (bodies[0] ?? {}), false);

  await direct.stream(model({ maxTokens: 50 }), context, {
    baseUrl: "https://example.test/v1", apiKey: "sk-test", maxTokens: 500, outputTokenField: "max_tokens",
  }).result();
  assert.equal(outputField(bodies[1] ?? {}).name, "max_tokens");
  assert.equal(outputField(bodies[1] ?? {}).value, 50);
  assert.equal("max_completion_tokens" in (bodies[1] ?? {}), false);

  const tight = model({ contextWindow: 100, maxTokens: 80 });
  await direct.stream(tight, { messages: [user("a".repeat(40))] }, {
    baseUrl: "https://example.test/v1", apiKey: "sk-test", maxTokens: 70,
  }).result();
  assert.equal(outputField(bodies[2] ?? {}).value, 54);

  const provider = createProvider({
    id: "custom",
    baseUrl: "https://example.test/v1",
    auth: { env: "CUSTOM_KEY" },
    models: [model({ id: "custom-1", provider: "custom", maxTokens: 90 })],
    api: openaiCompletionsApi({ fetch: fetchImpl, outputTokenField: "max_completion_tokens" }),
  });
  const models = createModels({ env: { CUSTOM_KEY: "k", OPENAI_API_KEY: "sk-openai", COMPAT_KEY: "compat" } });
  models.setProvider(provider);
  const custom = models.getModel("custom", "custom-1");
  assert.ok(custom);
  await models.streamSimple(custom, context, { maxTokens: 32 }).result();
  assert.equal(outputField(bodies[3] ?? {}).name, "max_completion_tokens");
  assert.equal(outputField(bodies[3] ?? {}).value, 32);

  models.setProvider(completionsProvider({
    id: "compat",
    name: "Compat",
    baseUrl: "https://example.test/v1",
    env: "COMPAT_KEY",
    modelIds: ["compat-1"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    fetch: fetchImpl,
  }));
  models.setProvider(openaiProvider({ fetch: fetchImpl }));
  const compat = models.getModel("compat", "compat-1");
  const official = models.getModel("openai", "gpt-4o-mini");
  assert.ok(compat && official);
  await models.stream(compat, context, { maxTokens: 20, outputTokenField: "max_tokens" }).result();
  await models.streamSimple(official, context).result();
  assert.equal(outputField(bodies[4] ?? {}).name, "max_tokens");
  assert.equal(outputField(bodies[4] ?? {}).value, 20);
  assert.equal("max_completion_tokens" in (bodies[4] ?? {}), false);
  assert.equal(outputField(bodies[5] ?? {}).name, "max_completion_tokens");
  assert.equal(outputField(bodies[5] ?? {}).value, official.maxTokens);
  assert.equal("max_tokens" in (bodies[5] ?? {}), false);
});

test("http and sse overflow are classified, and nearby failures are not", async () => {
  const cases: Array<{ name: string; status: number; error: unknown; overflow: boolean; retryable: boolean; kind: string }> = [
    { name: "code", status: 400, error: { code: "context_length_exceeded", type: "invalid_request_error", message: "too big" }, overflow: true, retryable: false, kind: "overflow" },
    { name: "window text", status: 400, error: { message: "This model's maximum context length is 8000 tokens." }, overflow: true, retryable: false, kind: "overflow" },
    { name: "input text", status: 400, error: { message: "Your input exceeds the context window of this model" }, overflow: true, retryable: false, kind: "overflow" },
    { name: "explicit code beats billing words", status: 400, error: { code: "context_length_exceeded", message: "billing notice" }, overflow: true, retryable: false, kind: "overflow" },
    { name: "too many tokens", status: 400, error: { message: "too many tokens" }, overflow: false, retryable: false, kind: "invalid_request" },
    { name: "request too large", status: 400, error: { type: "request_too_large", message: "Request exceeds the maximum size" }, overflow: false, retryable: false, kind: "invalid_request" },
    { name: "bare 400", status: 400, error: { message: "bad parameter" }, overflow: false, retryable: false, kind: "invalid_request" },
    { name: "bare 413", status: 413, error: { message: "payload" }, overflow: false, retryable: false, kind: "server" },
    { name: "rate limit", status: 429, error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached" }, overflow: false, retryable: true, kind: "rate_limit" },
    { name: "429 with context words", status: 429, error: { message: "maximum context length is 8" }, overflow: false, retryable: true, kind: "rate_limit" },
    { name: "quota", status: 429, error: { code: "insufficient_quota", message: "You exceeded your current quota" }, overflow: false, retryable: false, kind: "quota" },
    { name: "billing", status: 402, error: { message: "billing hard limit" }, overflow: false, retryable: false, kind: "quota" },
    { name: "auth", status: 401, error: { code: "invalid_api_key", message: "Incorrect API key" }, overflow: false, retryable: false, kind: "authentication" },
  ];
  for (const item of cases) {
    let calls = 0;
    const api = openaiCompletionsApi({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: item.error }), { status: item.status });
      },
    });
    const message = await api.stream(model(), { messages: [user("hi")] }, { baseUrl: "https://example.test/v1", apiKey: "sk-test" }).result();
    assert.equal(calls, 1, item.name);
    assert.equal(message.overflow === true, item.overflow, item.name);
    assert.equal(message.retryable === true, item.retryable, item.name);
    assert.match(message.errorMessage ?? "", new RegExp(`${item.status} ${item.kind}`), item.name);
  }

  const streamed = openaiCompletionsApi({
    fetch: async () => sse([
      'data: {"choices":[{"delta":{"content":"Keep"}}]}\n\n',
      'data: {"error":{"code":"context_length_exceeded","message":"maximum context length is 8000"}}\n\n',
    ]),
  });
  const partial = await streamed.stream(model(), { messages: [user("hi")] }, { baseUrl: "https://example.test/v1", apiKey: "sk-test" }).result();
  assert.equal(partial.overflow, true);
  assert.notEqual(partial.retryable, true);
  assert.equal(partial.content.some((block) => block.type === "text" && block.text === "Keep"), true);

  const filled = openaiCompletionsApi({
    fetch: async () => sse([
      'data: {"choices":[{"finish_reason":"length"}]}\n\n',
      'data: {"usage":{"prompt_tokens":1000,"completion_tokens":0,"total_tokens":1000}}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  const pressure = await filled.stream(model({ contextWindow: 1_000, maxTokens: 100 }), { messages: [user("hi")] }, {
    baseUrl: "https://example.test/v1", apiKey: "sk-test",
  }).result();
  assert.equal(pressure.stopReason, "length");
  assert.equal(pressure.overflow, true);
  assert.notEqual(pressure.retryable, true);

  const truncated = openaiCompletionsApi({
    fetch: async () => sse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"length"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  const ordinary = await truncated.stream(model({ contextWindow: 1_000, maxTokens: 100 }), { messages: [user("hi")] }, {
    baseUrl: "https://example.test/v1", apiKey: "sk-test",
  }).result();
  assert.equal(ordinary.stopReason, "length");
  assert.notEqual(ordinary.overflow, true);
  assert.equal(ordinary.content.some((block) => block.type === "text" && block.text === "partial"), true);
});

test("projection drops a failed assistant from the estimate and leaves the source unchanged", async () => {
  const failed = assistant(
    [{ type: "toolCall", id: "call", name: "SECRET_TOOL", arguments: { blob: "x".repeat(4_000) } }],
    { stopReason: "error", errorMessage: "boom" },
  );
  const source: Context = { messages: [failed, user("hi")] };
  const snapshot = structuredClone(source);
  const projected = transformMessages(source.messages, model());
  assert.equal(JSON.stringify(projected).includes("SECRET_TOOL"), false);
  assert.ok(estimateRequestTokens({ messages: source.messages }) > estimateRequestTokens({ messages: projected }));
  assert.deepEqual(source, snapshot);
  let body = "";
  const api = openaiCompletionsApi({
    fetch: async (_input, init) => {
      body = String(init?.body);
      return sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]);
    },
  });
  const message = await api.stream(model(), source, { baseUrl: "https://example.test/v1", apiKey: "sk-test" }).result();
  assert.equal(message.stopReason, "stop");
  assert.equal(body.includes("SECRET_TOOL"), false);
  assert.deepEqual(source, snapshot);
});

test("projected native signatures contribute to the budget only for the originating model", () => {
  const active: Model = { ...model(), api: "google-generative-ai", id: "gemini-3-flash-preview" };
  const source: Context = { messages: [{
    ...assistant([
      { type: "text", text: "answer", textSignature: "s".repeat(400) },
      { type: "thinking", thinking: "plan", thinkingSignature: "s".repeat(400) },
      { type: "toolCall", id: "call", name: "read", arguments: {}, thoughtSignature: "s".repeat(400) },
    ]), api: active.api, provider: active.provider, model: active.id,
  }, { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 }] };
  const snapshot = structuredClone(source);
  const same = resolveOutputBudget(active, source, 100);
  const other = resolveOutputBudget({ ...active, id: "another" }, source, 100);
  assert.equal(same.estimatedInput - other.estimatedInput, 300);
  assert.deepEqual(source, snapshot);
});
