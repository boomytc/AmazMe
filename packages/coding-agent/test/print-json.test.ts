import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheHitRate, createModels, usageCost, type Usage } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/testing";
import { runPrint } from "../src/print-run.ts";

const pricedUsage: Usage = {
  input: 6,
  output: 2,
  cacheRead: 4,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, total: 0 },
};
const rates = { input: 1_000_000, output: 2_000_000, cacheRead: 500_000 };

test("--json prints activity hitRate and cost.total, null when unknown", { timeout: 40_000 }, async () => {
  const pricedDir = mkdtempSync(join(tmpdir(), "amazme-print-json-"));
  const unknownDir = mkdtempSync(join(tmpdir(), "amazme-print-json-null-"));
  try {
    const priced = fauxProvider({
      respond: () => fauxAssistant("priced-reply", { usage: pricedUsage }),
    });
    const model = priced.getModels()[0];
    if (!model) throw new Error("faux model missing");
    model.cost = rates;
    const pricedModels = createModels();
    pricedModels.setProvider(priced);
    const pricedOut = await captureStdout(() => runPrint({
      cwd: pricedDir,
      provider: "faux",
      model: "faux-1",
      models: pricedModels,
      prompt: "quote",
      continueSession: false,
      json: true,
    }));
    const pricedResult = readResult(pricedOut);
    const hitRate = cacheHitRate(pricedUsage);
    const cost = usageCost({ cost: rates }, pricedUsage);
    assert.equal(typeof hitRate, "number");
    assert.equal(typeof cost?.total, "number");
    assert.equal(pricedResult.lastTurn.usage.hitRate, hitRate);
    assert.equal(pricedResult.lastTurn.cost.total, cost?.total ?? null);
    assert.equal(pricedResult.total.usage.hitRate, hitRate);
    assert.equal(pricedResult.total.cost.total, cost?.total ?? null);
    assert.match(pricedOut, /"text":"priced-reply"/);

    const unknown = fauxProvider({
      respond: () => fauxAssistant("unknown-reply", {
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: null } },
      }),
    });
    const unknownModels = createModels();
    unknownModels.setProvider(unknown);
    const unknownOut = await captureStdout(() => runPrint({
      cwd: unknownDir,
      provider: "faux",
      model: "faux-1",
      models: unknownModels,
      prompt: "quote",
      continueSession: false,
      json: true,
    }));
    const unknownResult = readResult(unknownOut);
    assert.equal(unknownResult.lastTurn.usage.hitRate, null);
    assert.equal(unknownResult.lastTurn.cost.total, null);
    assert.equal(unknownResult.total.usage.hitRate, null);
    assert.equal(unknownResult.total.cost.total, null);
    assert.equal(Object.hasOwn(unknownResult.lastTurn.usage, "hitRate"), true);
    assert.equal(Object.hasOwn(unknownResult.lastTurn.cost, "total"), true);
    assert.equal(Object.hasOwn(unknownResult.total.usage, "hitRate"), true);
    assert.equal(Object.hasOwn(unknownResult.total.cost, "total"), true);
  } finally {
    rmSync(pricedDir, { recursive: true, force: true });
    rmSync(unknownDir, { recursive: true, force: true });
  }
});

interface PrintResult {
  type: "result";
  lastTurn: { usage: { hitRate: number | null }; cost: { total: number | null } };
  total: { usage: { hitRate: number | null }; cost: { total: number | null } };
}

function readResult(stdout: string): PrintResult {
  const rows = stdout.trim().split("\n").map((line) => JSON.parse(line) as unknown);
  const found = rows.find(isPrintResult);
  if (!found) throw new Error(`json result missing\n${stdout}`);
  return found;
}

function isPrintResult(value: unknown): value is PrintResult {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "result") return false;
  if (!("lastTurn" in value) || !("total" in value)) return false;
  return side(value.lastTurn) && side(value.total);
}

function side(value: unknown): value is PrintResult["lastTurn"] {
  if (typeof value !== "object" || value === null || !("usage" in value) || !("cost" in value)) return false;
  const usage = value.usage;
  const cost = value.cost;
  if (typeof usage !== "object" || usage === null || !("hitRate" in usage)) return false;
  if (typeof cost !== "object" || cost === null || !("total" in cost)) return false;
  const hitRate = usage.hitRate;
  const total = cost.total;
  return (typeof hitRate === "number" || hitRate === null) && (typeof total === "number" || total === null);
}

function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return original.call(process.stdout, chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stdout.write;
  return run().finally(() => {
    process.stdout.write = original;
  }).then(() => chunks.join(""));
}
