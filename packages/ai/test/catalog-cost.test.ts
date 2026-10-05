import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { usageCost, type Model } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";

const UNKNOWN_PRICE = ["openrouter/auto", "openrouter/auto-beta", "typesafe/jev-router"];

test("the chat catalog has no negative cost, and unknown OpenRouter prices are omitted", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../src/providers/data/catalog.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(typeof parsed, "object");
  assert.ok(parsed);
  assert.equal(Array.isArray(parsed), false);
  const catalog = parsed as Record<string, unknown>;
  const rows: Array<Record<string, unknown>> = [];
  for (const [provider, value] of Object.entries(catalog)) {
    assert.equal(Array.isArray(value), true, provider);
    for (const row of value as unknown[]) {
      assert.equal(typeof row, "object");
      assert.ok(row);
      const model = row as Record<string, unknown>;
      rows.push(model);
      walkCost(model, `${provider}/${String(model.id)}`);
    }
  }
  for (const id of UNKNOWN_PRICE) {
    const row = rows.find((model) => model.id === id);
    assert.ok(row, id);
    assert.equal("cost" in row, false, id);
  }
  const openrouter = builtinProviders().find((provider) => provider.id === "openrouter");
  assert.ok(openrouter);
  for (const id of UNKNOWN_PRICE) {
    const model: Model | undefined = openrouter.getModels().find((item) => item.id === id);
    assert.ok(model, id);
    assert.equal("cost" in model, false, id);
    assert.equal(usageCost(model, { input: 1_000_000, output: 1_000_000 }), null, id);
  }
});

function walkCost(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkCost(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const cost = record.cost;
  if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    for (const [field, rate] of Object.entries(cost)) {
      if (typeof rate === "number") assert.equal(rate < 0, false, `${path}.cost.${field} = ${rate}`);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "cost") continue;
    walkCost(child, `${path}.${key}`);
  }
}
