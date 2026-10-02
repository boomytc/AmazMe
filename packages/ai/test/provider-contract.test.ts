import assert from "node:assert/strict";
import test from "node:test";
import { NOOP_TELEMETRY_CONTEXT } from "@amazme/telemetry";
import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  createProvider,
  hasApi,
  ModelsError,
  resolveThinkingLevel,
  supportedThinkingLevels,
  type ApiStreamOptions,
  type AssistantEventStream,
  type Model,
  type Models,
  type ProviderStreams,
  type StreamOptions,
} from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { completionsProvider } from "@amazme/ai/providers/completions";
import { openaiProvider } from "@amazme/ai/providers/openai";

const sample = (api: string, id = "m"): Model => ({
  id,
  name: id,
  provider: "mixed",
  api,
  input: ["text"],
  contextWindow: 100,
  maxTokens: 10,
  cost: { input: 0, output: 0 },
});

function scripted(label: string, seen: string[]): ProviderStreams & { options: StreamOptions[] } {
  const options: StreamOptions[] = [];
  const streams: ProviderStreams & { options: StreamOptions[] } = {
    options,
    stream(model, context, request) {
      return streams.streamSimple(model, context, request);
    },
    streamSimple(model, _context, request) {
      options.push({ ...request });
      seen.push(`${label}:${model.api}`);
      const stream = createAssistantEventStream();
      const message = baseAssistant(model, [{ type: "text", text: label }], "stop");
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  return streams;
}

test("one provider routes each model.api to its protocol implementation", async () => {
  const seen: string[] = [];
  const left = scripted("left", seen);
  const right = scripted("right", seen);
  const provider = createProvider({
    id: "mixed",
    name: "Mixed",
    baseUrl: "https://example.test/v1",
    headers: { "x-tenant": "acme" },
    auth: { env: "MIXED_KEY", ambient: "ambient-key" },
    models: [sample("alpha", "a"), sample("beta", "b")],
    api: { alpha: left, beta: right },
  });
  const models = createModels({ env: {} });
  models.setProvider(provider);
  const alpha = models.getModel("mixed", "a");
  const beta = models.getModel("mixed", "b");
  assert.ok(alpha && beta);
  assert.equal((await models.completeSimple(alpha, { messages: [] })).content[0]?.type === "text" ? "left" : "", "left");
  const specific = await models.stream(beta, { messages: [] }).result();
  assert.equal(specific.content[0]?.type === "text" ? specific.content[0].text : "", "right");
  assert.deepEqual(seen, ["left:alpha", "right:beta"]);
  assert.equal(left.options[0]?.baseUrl, "https://example.test/v1");
  assert.equal(left.options[0]?.headers?.["x-tenant"], "acme");
  assert.equal(left.options[0]?.apiKey, "ambient-key");
});

test("custom protocols receive typed defaults and per-request transport overrides", async () => {
  const api = scripted("custom", []);
  const provider = createProvider({
    id: "mixed",
    baseUrl: "https://default.test/v1",
    headers: { "x-tenant": "default", "x-shared": "shared" },
    auth: { env: "MIXED_KEY", ambient: "k" },
    models: [sample("custom-api")],
    api,
  });
  const models = createModels({ env: {} });
  models.setProvider(provider);
  const request: ApiStreamOptions<"custom-api"> = {
    baseUrl: "https://override.test/v2",
    headers: { "x-tenant": "override", "x-request": "request" },
  };
  await models.stream(sample("custom-api"), { messages: [] }, request).result();
  assert.equal(api.options[0]?.baseUrl, request.baseUrl);
  assert.deepEqual(api.options[0]?.headers, {
    "x-tenant": "override", "x-shared": "shared", "x-request": "request",
  });
  await models.streamSimple(sample("custom-api"), { messages: [] }, request).result();
  assert.deepEqual(api.options[1]?.headers, api.options[0]?.headers);
  assert.equal(api.options[1]?.baseUrl, request.baseUrl);
  assert.deepEqual(provider.headers, { "x-tenant": "default", "x-shared": "shared" });
});

test("a single protocol implementation serves every catalog model", async () => {
  const seen: string[] = [];
  const only = scripted("only", seen);
  const provider = createProvider({
    id: "mixed",
    auth: { env: "MIXED_KEY", ambient: "k" },
    models: [sample("alpha", "a"), sample("beta", "b")],
    api: only,
  });
  assert.equal((await provider.streamSimple(sample("alpha", "a"), { messages: [] }).result()).stopReason, "stop");
  assert.equal((await provider.stream(sample("beta", "b"), { messages: [] }).result()).stopReason, "stop");
  assert.deepEqual(seen, ["only:alpha", "only:beta"]);
});

test("assembling a provider without a protocol implementation throws", () => {
  assert.throws(
    () => createProvider({ id: "empty", auth: { env: "EMPTY" }, models: [], api: {} }),
    (error: unknown) => error instanceof ModelsError && /api implementation is required/.test(error.message),
  );
  assert.throws(
    () => createProvider({
      id: "gap",
      auth: { env: "GAP" },
      models: [sample("missing")],
      api: { other: scripted("other", []) },
    }),
    (error: unknown) => error instanceof ModelsError && /no API implementation for "missing"/.test(error.message),
  );
});

test("calling an API the provider does not implement ends as one error", async () => {
  const provider = createProvider({
    id: "mixed",
    auth: { env: "MIXED_KEY", ambient: "k" },
    models: [sample("alpha")],
    api: { alpha: scripted("alpha", []) },
  });
  const stream = provider.streamSimple({ ...sample("beta"), id: "m" }, { messages: [] });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const message = await stream.result();
  assert.deepEqual(events, ["error"]);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /no API implementation for "beta"/);
});

test("a plain object satisfies Models without extending a class", async () => {
  const model = sample("faux", "plain");
  const models: Models = {
    telemetryContext: NOOP_TELEMETRY_CONTEXT,
    getProvider: () => undefined,
    getModel: () => model,
    listModels: () => [model],
    getAuth: async () => undefined,
    streamSimple(active) {
      const stream: AssistantEventStream = createAssistantEventStream();
      const message = baseAssistant(active, [{ type: "text", text: "plain" }], "stop");
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    completeSimple(active, context, options) {
      return this.streamSimple(active, context, options).result();
    },
  };
  const message = await models.completeSimple(model, { messages: [] });
  assert.equal(message.content[0]?.type === "text" ? message.content[0].text : "", "plain");
});

test("thinking support follows the model map and does not clamp an unsupported level", () => {
  const plain = sample("faux");
  assert.deepEqual(supportedThinkingLevels(plain), ["off"]);
  assert.deepEqual(resolveThinkingLevel(plain, "low"), { ok: false, level: "low" });
  assert.deepEqual(resolveThinkingLevel(plain), { ok: true });
  const reasoning: Model = {
    ...sample("openai-completions"),
    reasoning: true,
    thinkingLevelMap: { low: "x-low", high: null, off: "none" },
  };
  assert.deepEqual(supportedThinkingLevels(reasoning), ["off", "minimal", "low", "medium"]);
  assert.deepEqual(resolveThinkingLevel(reasoning, "low"), { ok: true, parameter: "x-low" });
  assert.deepEqual(resolveThinkingLevel(reasoning, "minimal"), { ok: true, parameter: "minimal" });
  assert.deepEqual(resolveThinkingLevel(reasoning, "off"), { ok: true, parameter: "none" });
  assert.deepEqual(resolveThinkingLevel(reasoning, "high"), { ok: false, level: "high" });
});

test("completions receives the composed base URL and headers", async () => {
  let url = "";
  let authorization = "";
  let tenant = "";
  const api = openaiCompletionsApi({
    fetch: async (input, init) => {
      url = String(input);
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? "";
      tenant = headers.get("x-tenant") ?? "";
      const body = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(body, { status: 200 });
    },
  });
  const model: Model<"openai-completions"> = {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    provider: "openai",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0.15, output: 0.6 },
  };
  const models = createModels({ env: { OPENAI_API_KEY: "sk-test" } });
  models.setProvider(createProvider({
    id: "openai",
    baseUrl: "https://example.test/v1",
    headers: { "x-tenant": "acme" },
    auth: { env: "OPENAI_API_KEY" },
    models: [model],
    api,
  }));
  const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  assert.equal(message.content[0]?.type === "text" ? message.content[0].text : "", "Hi");
  assert.equal(url, "https://example.test/v1/chat/completions");
  assert.equal(authorization, "Bearer sk-test");
  assert.equal(tenant, "acme");
});

test("known APIs keep their own stream option types", () => {
  const completions: Model = sample("openai-completions");
  assert.equal(hasApi(completions, "openai-completions"), true);
  if (!hasApi(completions, "openai-completions")) return;
  const accepted: ApiStreamOptions<typeof completions.api> = { reasoningEffort: "low", apiKey: "k" };
  assert.equal(accepted.reasoningEffort, "low");
  const take = <T>(value: T): T => value;
  take<ApiStreamOptions<"openai-completions">>({ reasoningEffort: "medium" });
  // @ts-expect-error faux stream options do not include reasoningEffort
  take<ApiStreamOptions<"faux">>({ reasoningEffort: "low" });
  // @ts-expect-error an unknown API stays on the unified stream options
  take<ApiStreamOptions<"custom-api">>({ reasoningEffort: "high" });
});

test("a completions catalog without configured rates does not invent a price", async () => {
  const provider = completionsProvider({
    id: "custom", name: "Custom", baseUrl: "https://example.test/v1", env: "CUSTOM_KEY", modelIds: ["unpriced"],
    contextWindow: 8_000, maxTokens: 1_000,
    fetch: async () => new Response([
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n',
      "data: [DONE]\n\n",
    ].join("")),
  });
  const models = createModels({ env: { CUSTOM_KEY: "k" } });
  models.setProvider(provider);
  const active = models.getModel("custom", "unpriced");
  assert.ok(active);
  assert.deepEqual(active.cost, { input: 0, output: 0 });
  const message = await models.completeSimple(active, { messages: [] });
  assert.equal(message.usage.totalTokens, 17);
  assert.deepEqual(message.usage.cost, { input: 0, output: 0, total: 0 });

  const priced = completionsProvider({
    id: "configured", name: "Configured", baseUrl: "https://example.test/v1", env: "CONFIGURED_KEY",
    modelIds: ["priced"], contextWindow: 8_000, maxTokens: 1_000, cost: { input: 2, output: 3 },
  });
  assert.deepEqual(priced.getModels()[0]?.cost, { input: 2, output: 3 });
  const openai = openaiProvider({
    modelIds: ["gpt-4o-mini", "unpriced"],
    models: { unpriced: { contextWindow: 8_000, maxTokens: 1_000 } },
  });
  assert.deepEqual(openai.getModels()[0]?.cost, { input: 0.15, output: 0.6 });
  assert.equal(openai.getModels()[0]?.contextWindow, 128_000);
  assert.deepEqual(openai.getModels()[1]?.cost, { input: 0, output: 0 });
  assert.equal(openai.getModels()[1]?.contextWindow, 8_000);
  assert.deepEqual(openai.getModels()[1]?.input, ["text"]);
});

test("an unknown model id does not inherit a verified window or output cap", () => {
  assert.throws(() => openaiProvider({ modelIds: ["gpt-4.1"] }), /contextWindow/);
  assert.throws(() => completionsProvider({
    id: "custom", name: "Custom", baseUrl: "https://example.test/v1", env: "CUSTOM_KEY", modelIds: ["x"],
  }), /contextWindow/);
  assert.throws(() => completionsProvider({
    id: "custom", name: "Custom", baseUrl: "https://example.test/v1", env: "CUSTOM_KEY",
    modelIds: ["x"], contextWindow: 0, maxTokens: 10,
  }), /positive integer/);
});
