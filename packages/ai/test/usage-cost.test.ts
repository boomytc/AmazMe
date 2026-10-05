import assert from "node:assert/strict";
import test from "node:test";
import { cacheHitRate, usageCost, type Model } from "@amazme/ai";
import { usageFromCounts } from "@amazme/ai/api/events";
import { builtinProviders } from "@amazme/ai/providers/builtin";

/** Half a million of each count, so the USD amount is half the per-million rate. */
const HALF_MILLION = {
  input: 500_000,
  output: 500_000,
  cacheRead: 500_000,
  cacheWrite: 500_000,
};

function deepseek(id: string): Model {
  const provider = builtinProviders().find((item) => item.id === "deepseek");
  assert.ok(provider);
  const model = provider.getModels().find((item) => item.id === id);
  assert.ok(model);
  return model;
}

function catalogModel(providerId: string, id: string): Model {
  const provider = builtinProviders().find((item) => item.id === providerId);
  assert.ok(provider);
  const model = provider.getModels().find((item) => item.id === id);
  assert.ok(model);
  return model;
}

test("deepseek-flash peak prices bill half a million tokens at the catalog rates", () => {
  const flash = deepseek("deepseek-flash");
  assert.ok(flash.cost);
  assert.equal("cacheWrite" in flash.cost, false);
  assert.deepEqual(flash.cost, { input: 0.3, output: 1.2, cacheRead: 0.006 });
  // 5e5 / 1e6 × 0.3 = 0.15, × 0.006 = 0.003, write uses 0.3 → 0.15, output × 1.2 = 0.6.
  assert.deepEqual(usageCost(flash, HALF_MILLION), {
    input: 0.15,
    cacheRead: 0.003,
    cacheWrite: 0.15,
    output: 0.6,
    total: 0.903,
  });
  // A missing cache-write count is 0 tokens, so the input-rate fallback adds nothing.
  assert.deepEqual(usageCost(flash, { input: 500_000, output: 500_000, cacheRead: 500_000 }), {
    input: 0.15,
    cacheRead: 0.003,
    cacheWrite: 0,
    output: 0.6,
    total: 0.753,
  });
  const reported = usageFromCounts(flash, 500_000, 500_000, undefined, {
    cacheRead: 500_000,
    cacheWrite: 500_000,
  });
  assert.deepEqual(reported?.cost, { input: 0.15, output: 0.6, total: 0.903 });
});

test("deepseek-v4-pro peak prices bill half a million tokens at the catalog rates", () => {
  const pro = deepseek("deepseek-v4-pro");
  assert.ok(pro.cost);
  assert.equal("cacheWrite" in pro.cost, false);
  assert.deepEqual(pro.cost, { input: 1.32, output: 3.96, cacheRead: 0.044 });
  // 5e5 / 1e6 × 1.32 = 0.66, × 0.044 = 0.022, write uses 1.32 → 0.66, output × 3.96 = 1.98.
  assert.deepEqual(usageCost(pro, HALF_MILLION), {
    input: 0.66,
    cacheRead: 0.022,
    cacheWrite: 0.66,
    output: 1.98,
    total: 3.322,
  });
  const reported = usageFromCounts(pro, 500_000, 500_000, 2_000_000, {
    cacheRead: 500_000,
    cacheWrite: 500_000,
  });
  assert.equal(reported?.totalTokens, 2_000_000);
  assert.deepEqual(reported?.cost, { input: 0.66, output: 1.98, total: 3.322 });
});

test("claude-sonnet-4-6 cache prices bill half a million tokens at the catalog rates", () => {
  const sonnet = catalogModel("anthropic", "claude-sonnet-4-6");
  // 5-minute cache writes are $3.75 / MTok. Cache hits are $0.30 / MTok.
  assert.deepEqual(sonnet.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  // 5e5 / 1e6 × 3 = 1.5, × 0.3 = 0.15, × 3.75 = 1.875, output × 15 = 7.5.
  const cost = usageCost(sonnet, HALF_MILLION);
  assert.deepEqual(cost, {
    input: 1.5,
    cacheRead: 0.15,
    cacheWrite: 1.875,
    output: 7.5,
    total: 11.025,
  });
  assert.ok(cost !== null && cost.cacheRead > 0 && cost.cacheWrite > 0);
});

test("gpt-5.6-sol cache prices bill half a million tokens at the catalog rates", () => {
  const sol = catalogModel("openai", "gpt-5.6-sol");
  assert.deepEqual(sol.cost, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  // 5e5 / 1e6 × 4 = 2, × 0.4 = 0.2, × 5 = 2.5, output × 20 = 10.
  const cost = usageCost(sol, HALF_MILLION);
  assert.deepEqual(cost, {
    input: 2,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 10,
    total: 14.7,
  });
  assert.ok(cost !== null && cost.cacheRead > 0 && cost.cacheWrite > 0);
});

test("gemini-2.5-flash cache read bills half a million tokens at the catalog rate", () => {
  const flash = catalogModel("google", "gemini-2.5-flash");
  // Context caching is $0.03 / MTok. There is no per-token cache-write rate.
  assert.ok(flash.cost);
  assert.equal("cacheWrite" in flash.cost, false);
  assert.deepEqual(flash.cost, { input: 0.3, output: 2.5, cacheRead: 0.03 });
  // 5e5 / 1e6 × 0.3 = 0.15, × 0.03 = 0.015, write uses 0.3 → 0.15, output × 2.5 = 1.25.
  const cost = usageCost(flash, HALF_MILLION);
  assert.deepEqual(cost, {
    input: 0.15,
    cacheRead: 0.015,
    cacheWrite: 0.15,
    output: 1.25,
    total: 1.565,
  });
  assert.ok(cost !== null && cost.cacheRead > 0);
});

test("a listed cache-write rate replaces the input-rate fallback", () => {
  const model: Model = {
    id: "sample",
    name: "sample",
    provider: "sample",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 5 },
  };
  // 5e5 / 1e6 × 2 = 1, × 1 = 0.5, × 5 = 2.5, × 4 = 2.
  assert.deepEqual(usageCost(model, HALF_MILLION), {
    input: 1,
    cacheRead: 0.5,
    cacheWrite: 2.5,
    output: 2,
    total: 6,
  });
});

test("cache hits without a hit price leave the hit charge and the total unknown", () => {
  const model: Model = {
    id: "sample",
    name: "sample",
    provider: "sample",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 2, output: 4 },
  };
  // 5e5 / 1e6 × 2 = 1 input, × 4 = 2 output. Write rate unset, so write uses 2 → 1.
  // Hit tokens are above 0 and cost.cacheRead is missing, so that charge and the total are null.
  const cost = usageCost(model, HALF_MILLION);
  assert.ok(cost);
  assert.equal(cost.cacheRead, null);
  assert.equal(cost.total, null);
  assert.equal(typeof cost.input, "number");
  assert.equal(typeof cost.output, "number");
  assert.equal(cost.input, 1);
  assert.equal(cost.cacheWrite, 1);
  assert.equal(cost.output, 2);
  const reported = usageFromCounts(model, 500_000, 500_000, undefined, {
    cacheRead: 500_000,
    cacheWrite: 500_000,
  });
  assert.deepEqual(reported?.cost, { input: 1, output: 2, total: 4 });
});

test("an explicit zero cache read without a hit price still has a numeric total", () => {
  const model: Model = {
    id: "sample",
    name: "sample",
    provider: "sample",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 2, output: 4 },
  };
  // cacheRead is 0, so a missing cost.cacheRead does not null the charge or the total.
  // 5e5 / 1e6 × 2 = 1 input, × 4 = 2 output. The write count is missing, so that charge is 0.
  const cost = usageCost(model, { input: 500_000, output: 500_000, cacheRead: 0 });
  assert.ok(cost);
  assert.equal(cost.cacheRead, 0);
  assert.equal(typeof cost.total, "number");
  assert.equal(cost.total, 3);
  const reported = usageFromCounts(model, 500_000, 500_000, undefined, { cacheRead: 0 });
  assert.equal(reported?.cacheRead, 0);
  assert.deepEqual(reported?.cost, { input: 1, output: 2, total: 3 });
});

test("a model without a price list returns null", () => {
  const model = deepseek("deepseek-flash");
  delete (model as { cost?: Model["cost"] }).cost;
  assert.equal(usageCost(model, HALF_MILLION), null);
  assert.equal(usageCost({ cost: { input: 0.3 } }, HALF_MILLION), null);
  assert.deepEqual(usageFromCounts(model, 12, 5, 17)?.cost, { input: 0, output: 0, total: 0 });
});

test("a listed zero rate is a zero charge", () => {
  const model = deepseek("deepseek-flash");
  model.cost = { input: 0, output: 0 };
  assert.deepEqual(usageCost(model, { input: 500_000, output: 500_000 }), {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
  });
  model.cost = { input: 2, output: 4, cacheRead: 0 };
  assert.deepEqual(usageCost(model, { input: 0, output: 0, cacheRead: 500_000 }), {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
  });
});

test("a reported reasoning count stays on the usage and leaves the total and the cost unchanged", () => {
  const model: Model = {
    id: "sample",
    name: "sample",
    provider: "sample",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 1_000_000, output: 2_000_000 },
  };
  const plain = usageFromCounts(model, 100, 14, 117, { cacheRead: 3 });
  const withReasoning = usageFromCounts(model, 100, 14, 117, { cacheRead: 3, reasoning: 10 });
  assert.ok(plain);
  assert.ok(withReasoning);
  assert.equal(Object.hasOwn(plain, "reasoning"), false);
  assert.equal(withReasoning.reasoning, 10);
  assert.equal(withReasoning.output, plain.output);
  assert.equal(withReasoning.totalTokens, plain.totalTokens);
  assert.deepEqual(withReasoning.cost, plain.cost);
  assert.deepEqual(withReasoning.cost, { input: 100, output: 28, total: 128 });
});

test("cache hit rate is null for an empty prompt and cache reads over the full prompt otherwise", () => {
  assert.equal(cacheHitRate({ input: 0 }), null);
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  // Missing cache counts are 0. Six miss tokens and four hits is 4 / 10.
  assert.equal(cacheHitRate({ input: 6, cacheRead: 4 }), 0.4);
  // Two misses, three hits, five writes: 3 / 10.
  assert.equal(cacheHitRate({ input: 2, cacheRead: 3, cacheWrite: 5 }), 0.3);
});
