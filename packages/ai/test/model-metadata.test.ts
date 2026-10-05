import assert from "node:assert/strict";
import test from "node:test";
import { resolveThinkingLevel, supportedThinkingLevels, type Model, type ThinkingLevel } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

function model(extra: Partial<Model> = {}): Model {
  return {
    id: "sample",
    name: "sample",
    provider: "sample",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0 },
    ...extra,
  };
}

test("supported thinking levels are derived from reasoning and thinkingLevelMap", () => {
  assert.deepEqual(supportedThinkingLevels(model()), ["off"]);
  assert.deepEqual(supportedThinkingLevels(model({ reasoning: false })), ["off"]);
  assert.deepEqual(resolveThinkingLevel(model(), "low"), { ok: false, level: "low" });

  const open = model({ reasoning: true });
  assert.deepEqual(supportedThinkingLevels(open), [...LEVELS]);
  assert.deepEqual(resolveThinkingLevel(open, "medium"), { ok: true, parameter: "medium" });
  assert.deepEqual(resolveThinkingLevel(open, "off"), { ok: true });

  const mapped = model({
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", high: null },
  });
  assert.deepEqual(supportedThinkingLevels(mapped), ["off", "low", "medium"]);
  assert.deepEqual(resolveThinkingLevel(mapped, "off"), { ok: true, parameter: "none" });
  assert.deepEqual(resolveThinkingLevel(mapped, "minimal"), { ok: false, level: "minimal" });
  assert.deepEqual(resolveThinkingLevel(mapped, "high"), { ok: false, level: "high" });
});

test("builtin deepseek-flash and deepseek-v4-pro match the published DeepSeek API", () => {
  const deepseek = builtinProviders().find((provider) => provider.id === "deepseek");
  assert.ok(deepseek);
  const flash = deepseek.getModels().find((item) => item.id === "deepseek-flash");
  const pro = deepseek.getModels().find((item) => item.id === "deepseek-v4-pro");
  assert.ok(flash);
  assert.ok(pro);

  // Models & Pricing, Model Details: version DeepSeek-V4.1-Flash.
  // https://api-docs.deepseek.com/quick_start/pricing
  // Catalog input is text only. A new user image is refused before any request.
  assert.equal(flash.name, "DeepSeek V4.1 Flash");
  assert.equal(flash.api, "openai-completions");
  assert.equal(flash.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(flash.input, ["text"]);
  assert.equal(flash.reasoning, true);
  // CONTEXT LENGTH: 1M. The agent example writes 1000000.
  // https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
  assert.equal(flash.contextWindow, 1_000_000);
  // Chat Completions, Request, max_tokens: 1 to 384K (393216).
  // https://api-docs.deepseek.com/api/create-chat-completion
  assert.equal(flash.maxTokens, 393_216);
  // Pricing, USD per 1,000,000 tokens: peak cache-miss input, peak output, and peak cache-hit input.
  // Off-peak is half of peak. There is no separate cache-write rate.
  assert.ok(flash.cost);
  assert.equal("cacheWrite" in flash.cost, false);
  assert.deepEqual(flash.cost, { input: 0.3, output: 1.2, cacheRead: 0.006 });

  // Models & Pricing: version DeepSeek-V4-Pro-0813, displayed as DeepSeek V4 Pro, vision not supported.
  assert.equal(pro.name, "DeepSeek V4 Pro");
  assert.equal(pro.api, "openai-completions");
  assert.equal(pro.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(pro.input, ["text"]);
  assert.equal(pro.contextWindow, 1_000_000);
  assert.equal(pro.reasoning, true);
  assert.equal(pro.maxTokens, 393_216);
  assert.ok(pro.cost);
  assert.equal("cacheWrite" in pro.cost, false);
  assert.deepEqual(pro.cost, { input: 1.32, output: 3.96, cacheRead: 0.044 });

  // Chat Completions Request lists reasoning_effort as none | low | high | max.
  // https://api-docs.deepseek.com/api/create-chat-completion
  // flash lists only levels that are sent unchanged. minimal and medium would be rewritten, so they error.
  // off stays supported and has no effort parameter. max is not one of our levels.
  assert.equal("thinkingLevels" in flash, false);
  assert.deepEqual(flash.thinkingLevelMap, { minimal: null, low: "low", medium: null, high: "high" });
  assert.deepEqual(supportedThinkingLevels(flash), ["off", "low", "high"]);
  assert.deepEqual(resolveThinkingLevel(flash, "off"), { ok: true });
  assert.deepEqual(resolveThinkingLevel(flash, "low"), { ok: true, parameter: "low" });
  assert.deepEqual(resolveThinkingLevel(flash, "high"), { ok: true, parameter: "high" });
  assert.deepEqual(resolveThinkingLevel(flash, "minimal"), { ok: false, level: "minimal" });
  assert.deepEqual(resolveThinkingLevel(flash, "medium"), { ok: false, level: "medium" });

  // v4-pro is unchanged in this change.
  const proEffort = {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
  } as const;
  assert.equal("thinkingLevels" in pro, false);
  assert.deepEqual(pro.thinkingLevelMap, proEffort);
  assert.deepEqual(supportedThinkingLevels(pro), [...LEVELS]);
  for (const level of LEVELS) {
    assert.deepEqual(resolveThinkingLevel(pro, level), { ok: true, parameter: proEffort[level] });
  }
});
