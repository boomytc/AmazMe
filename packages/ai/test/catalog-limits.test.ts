import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supportedThinkingLevels, type ThinkingLevel } from "@amazme/ai";
import { catalogModels, catalogProviderIds } from "@amazme/ai/providers/catalog";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/**
 * Catalog declaration.
 * `contextWindow` and `maxTokens` are positive integers on the row.
 * `reasoning: false` is the unsupported thinking shape: only "off".
 * `thinkingLevelMap` lists exclusions (`null`) and protocol parameters (string).
 * A map that sets every level to `null` is the explicit empty shape.
 * Omitting that map on a reasoning model keeps every level under its own name.
 */
test("every preset catalog model declares contextWindow, maxTokens, and thinking", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../src/providers/data/catalog.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(typeof parsed, "object");
  assert.ok(parsed);
  assert.equal(Array.isArray(parsed), false);
  const catalog = parsed as Record<string, unknown>;
  const providers = catalogProviderIds();
  assert.deepEqual([...Object.keys(catalog)].sort(), [...providers].sort());
  for (const providerId of providers) {
    const rows = catalog[providerId];
    assert.equal(Array.isArray(rows), true, providerId);
    const models = catalogModels(providerId);
    assert.equal(models.length, (rows as unknown[]).length, providerId);
    for (let index = 0; index < models.length; index += 1) {
      const row: unknown = (rows as unknown[])[index];
      const model = models[index];
      assert.ok(row && typeof row === "object" && !Array.isArray(row));
      const record = row as Record<string, unknown>;
      const id = `${providerId}/${String(record.id)}`;
      assert.equal(model?.id, record.id, id);
      assert.equal(Number.isInteger(record.contextWindow) && (record.contextWindow as number) > 0, true, `${id} contextWindow`);
      assert.equal(Number.isInteger(record.maxTokens) && (record.maxTokens as number) > 0, true, `${id} maxTokens`);
      assert.equal(model?.contextWindow, record.contextWindow, id);
      assert.equal(model?.maxTokens, record.maxTokens, id);
      assert.equal(typeof record.reasoning, "boolean", `${id} reasoning`);
      assert.ok(model);
      const levels = supportedThinkingLevels(model);
      if (record.thinkingLevelMap !== undefined) {
        assert.equal(typeof record.thinkingLevelMap, "object", id);
        assert.ok(record.thinkingLevelMap);
        assert.equal(Array.isArray(record.thinkingLevelMap), false, id);
        for (const [level, parameter] of Object.entries(record.thinkingLevelMap as Record<string, unknown>)) {
          assert.equal(LEVELS.includes(level as ThinkingLevel), true, `${id} ${level}`);
          assert.equal(parameter === null || typeof parameter === "string", true, `${id} ${level}`);
        }
        assert.deepEqual(model.thinkingLevelMap, record.thinkingLevelMap, id);
      }
      if (record.reasoning !== true) {
        assert.deepEqual(levels, ["off"], id);
      } else if (record.thinkingLevelMap === undefined) {
        assert.deepEqual(levels, [...LEVELS], id);
        assert.equal("thinkingLevelMap" in model, false, id);
      } else {
        assert.deepEqual(levels, LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null), id);
      }
      if (record.thinkingSwitch === undefined) {
        assert.equal("thinkingSwitch" in model, false, id);
      } else {
        assert.equal(record.thinkingSwitch, "thinking", id);
        assert.equal(model.thinkingSwitch, "thinking", id);
        assert.equal(model.api, "openai-completions", id);
      }
    }
  }
});
