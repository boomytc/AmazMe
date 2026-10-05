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

test("deepseek-flash peak prices bill half a million tokens at the catalog rates", () => {
  const flash = deepseek("deepseek-flash");
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

test("an unset cache-hit rate charges nothing for those tokens", () => {
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
  // 5e5 / 1e6 × 2 = 1, hit rate unset → 0, write × 2 = 1, output × 4 = 2.
  assert.deepEqual(usageCost(model, HALF_MILLION), {
    input: 1,
    cacheRead: 0,
    cacheWrite: 1,
    output: 2,
    total: 4,
  });
  const reported = usageFromCounts(model, 500_000, 500_000, undefined, {
    cacheRead: 500_000,
    cacheWrite: 500_000,
  });
  assert.deepEqual(reported?.cost, { input: 1, output: 2, total: 4 });
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
  assert.deepEqual(usageCost(model, HALF_MILLION), {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
  });
});

test("cache hit rate is null for an empty prompt and cache reads over the full prompt otherwise", () => {
  assert.equal(cacheHitRate({ input: 0 }), null);
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  // Missing cache counts are 0. Six miss tokens and four hits is 4 / 10.
  assert.equal(cacheHitRate({ input: 6, cacheRead: 4 }), 0.4);
  // Two misses, three hits, five writes: 3 / 10.
  assert.equal(cacheHitRate({ input: 2, cacheRead: 3, cacheWrite: 5 }), 0.3);
});
