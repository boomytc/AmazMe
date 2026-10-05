import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheHitRate, createModels, usageCost, type Model, type Usage } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { validSummary } from "./valid-summary.ts";
import { AgentHarness, effectiveInputThreshold, value, type AgentLane, type HarnessTool, type LaneUsage, type LaneUsageView } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";

function tokens(
  input: number,
  output: number,
  extra: { cacheRead?: number; cacheWrite?: number; reasoning?: number } = {},
): Usage {
  return { input, output, totalTokens: input + output, cost: { input: 0, output: 0, total: 0 }, ...extra };
}

function assistantMessage(text: string, usage: Usage, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage,
    stopReason: "stop" as const,
    timestamp,
  };
}

const zeroPrice = { cost: { input: 0, output: 0 } };

function turn(
  input: number,
  output: number,
  cache: { cacheRead?: number | null; cacheWrite?: number | null; reasoning?: number | null } = {},
): NonNullable<LaneUsage["lastTurn"]> {
  const cacheRead = cache.cacheRead ?? null;
  const cacheWrite = "cacheWrite" in cache ? cache.cacheWrite ?? null : 0;
  const reasoning = cache.reasoning ?? null;
  const usage = {
    input,
    output,
    ...(cacheRead !== null ? { cacheRead } : {}),
    ...(cacheWrite !== null ? { cacheWrite } : {}),
  };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    hitRate: cacheHitRate(usage),
    cost: usageCost(zeroPrice, usage),
  };
}

function total(input: number, output: number): LaneUsage["total"] {
  if (input === 0 && output === 0) {
    return { input: 0, output: 0, cacheRead: null, cacheWrite: null, reasoning: null, hitRate: null, cost: null };
  }
  return {
    input,
    output,
    cacheRead: null,
    cacheWrite: 0,
    reasoning: null,
    hitRate: null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function priceOf(provider: ReturnType<typeof fauxProvider>, cost: Model["cost"]): Model {
  const model = provider.getModels()[0];
  if (!model) throw new Error("faux model missing");
  model.cost = cost;
  return model;
}

function scripted(usages: readonly Usage[], texts: readonly string[] = []) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      const index = state.callCount - 1;
      const usage = usages[index] ?? tokens(0, 0);
      return fauxAssistant(texts[index] ?? `reply-${state.callCount}`, { usage });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return { provider, models };
}

function runtime(
  storage: MemoryStorage | JsonlStorage,
  models: ReturnType<typeof createModels>,
  extra: { compaction?: { enabled: boolean; maxTokens: number }; tools?: HarnessTool[]; modelId?: string } = {},
) {
  return new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: extra.modelId ?? "faux-1" },
    tools: extra.tools,
    compaction: extra.compaction ?? { enabled: true, maxTokens: 50_000 },
  });
}

function assertRoundTrip<T>(value: T): T {
  assert.deepEqual(structuredClone(value), value);
  assert.deepEqual(JSON.parse(JSON.stringify(value)) as T, value);
  return value;
}

async function readUsage(lane: { usage(): Promise<LaneUsageView>; snapshot(): Promise<{ version: number }> }): Promise<LaneUsageView> {
  const snap = await lane.snapshot();
  const usage = assertRoundTrip(await lane.usage());
  assert.equal(usage.version, snap.version);
  return usage;
}

async function finishCompaction(lane: AgentLane): Promise<void> {
  // The copied tail keeps the source timestamp. A summary written in that same millisecond is not strictly later, so the position rule would keep the copy.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const admitted = await lane.accept({ kind: "compaction" });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const folded = await lane.drive(admitted.value.operationId);
  assert.equal(folded.ok && folded.value.kind === "settled" ? folded.value.result.status : "", "completed");
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for durable state");
}

test("a lane with no assistant projects empty usage and the assess threshold", async () => {
  const { models } = scripted([]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    const usage = await readUsage(lane);
    const model = models.getModel("faux", "faux-1");
    assert.ok(model);
    assert.equal(usage.lastTurn, null);
    assert.equal(usage.contextTokens, null);
    assert.deepEqual(usage.total, total(0, 0));
    assert.deepEqual(assertRoundTrip(await lane.laneStatus()), { notBefore: null, retryReason: null, compacting: false, turnStartedAt: null });
    assert.equal(usage.compactionThreshold, effectiveInputThreshold(model.contextWindow, 50_000));
    usage.total.input = 9;
    assert.deepEqual((await lane.usage()).total, total(0, 0));

    const disabled = runtime(new MemoryStorage(), models, { compaction: { enabled: false, maxTokens: 50_000 } });
    try {
      assert.equal((await readUsage(disabled.lane())).compactionThreshold, null);
    } finally {
      disabled.close();
    }

    const unknown = runtime(new MemoryStorage(), models, { modelId: "missing" });
    try {
      assert.equal((await readUsage(unknown.lane())).compactionThreshold, null);
    } finally {
      unknown.close();
    }
  } finally {
    harness.close();
  }
});

test("two turns keep the latest usage, a null cache, and the summed total", async () => {
  const first = tokens(11, 3);
  const second = tokens(17, 5);
  const { models } = scripted([first, second]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(17, 5));
    assert.deepEqual(usage.total, total(28, 8));
    assert.equal(usage.contextTokens, 22);
  } finally {
    harness.close();
  }
});

test("cacheRead on the latest assistant is part of contextTokens and lastTurn", async () => {
  const { models } = scripted([tokens(3, 4, { cacheRead: 10 })]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(3, 4, { cacheRead: 10 }));
    assert.equal(usage.contextTokens, 17);
    assert.equal(usage.total.input, 3);
    assert.equal(usage.total.output, 4);
    assert.equal(usage.total.cacheRead, 10);
    assert.equal(usage.total.cacheWrite, 0);
    assert.equal(usage.total.hitRate, cacheHitRate({ input: 3, cacheRead: 10, cacheWrite: 0 }));
    assert.equal(usage.total.cost?.cacheRead, null);
    assert.equal(usage.total.cost?.total, null);
    assert.equal(usage.total.cost?.input, 0);
    assert.equal(usage.total.cost?.output, 0);
  } finally {
    harness.close();
  }
});

test("an assistant without a reported cache leaves cacheRead null and stores cacheWrite as zero", async () => {
  const { models } = scripted([tokens(5, 6)]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(5, 6));
    assert.equal(usage.contextTokens, 11);
    assert.deepEqual(usage.total, total(5, 6));
  } finally {
    harness.close();
  }
});

test("a reported cache zero stays zero and still joins the summed cache", async () => {
  const { models } = scripted([
    tokens(1, 1, { cacheRead: 10 }),
    tokens(2, 2, { cacheRead: 0, cacheWrite: 4 }),
  ]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(2, 2, { cacheRead: 0, cacheWrite: 4 }));
    assert.equal(usage.contextTokens, 8);
    assert.equal(usage.total.input, 3);
    assert.equal(usage.total.output, 3);
    assert.equal(usage.total.cacheRead, 10);
    assert.equal(usage.total.cacheWrite, 4);
    assert.equal(usage.total.hitRate, cacheHitRate({ input: 3, cacheRead: 10, cacheWrite: 4 }));
    assert.equal(usage.total.cost?.cacheRead, null);
    assert.equal(usage.total.cost?.total, null);
  } finally {
    harness.close();
  }
});

test("two turns that omit cacheWrite store zero and still price the cache reads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-usage-reasoning-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const first = tokens(4, 2, { cacheRead: 6, reasoning: 7 });
  const second = tokens(3, 5, { cacheRead: 8, reasoning: 11 });
  const provider = fauxProvider({
    respond: (_context, _options, state) => fauxAssistant(`reply-${state.callCount}`, {
      usage: state.callCount === 1 ? first : second,
    }),
  });
  const model = priceOf(provider, { input: 2_000_000, output: 4_000_000, cacheRead: 500_000 });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new JsonlStorage(file), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    const rows = await harness.storage.read((view) => view.usageRows());
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.cacheWrite === 0 && (row.cacheRead ?? 0) > 0), true);
    assert.equal(rows[0]?.reasoning, first.reasoning);
    assert.equal(rows[1]?.reasoning, second.reasoning);
    assert.equal(usage.lastTurn?.cacheWrite, 0);
    assert.equal(usage.lastTurn?.reasoning, second.reasoning);
    assert.equal(usage.total.reasoning, (first.reasoning ?? 0) + (second.reasoning ?? 0));
    const cacheRead = (first.cacheRead ?? 0) + (second.cacheRead ?? 0);
    assert.equal(usage.total.cacheRead, cacheRead);
    assert.equal(usage.total.cacheWrite, 0);
    assert.equal(typeof usage.total.hitRate, "number");
    assert.equal(usage.total.hitRate, cacheHitRate({
      input: first.input + second.input,
      cacheRead,
      cacheWrite: 0,
    }));
    const one = usageCost(model, { ...first, cacheWrite: 0 });
    const two = usageCost(model, { ...second, cacheWrite: 0 });
    assert.ok(one && two && one.total !== null && two.total !== null);
    assert.equal(typeof usage.total.cost?.total, "number");
    assert.equal(usage.total.cost?.total, one.total + two.total);
    const reopened = runtime(new JsonlStorage(file), models);
    try {
      assert.deepEqual((await readUsage(reopened.lane())).lastTurn, usage.lastTurn);
    } finally {
      reopened.close();
    }
  } finally {
    harness.close();
  }
});

test("an unreported cacheRead nulls the cumulative cache and hit rate", async () => {
  const { models } = scripted([
    tokens(4, 1, { cacheRead: 500, cacheWrite: 0 }),
    tokens(3, 1, { cacheWrite: 0 }),
  ]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    assert.equal(usage.total.cacheRead, null);
    assert.equal(usage.total.hitRate, null);
    assert.equal(usage.total.cacheWrite, 0);
  } finally {
    harness.close();
  }
});

test("a reported cacheRead of zero still joins the cumulative cache", async () => {
  const { models } = scripted([
    tokens(4, 1, { cacheRead: 500, cacheWrite: 0 }),
    tokens(3, 1, { cacheRead: 0, cacheWrite: 0 }),
  ]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    assert.equal(usage.total.cacheRead, 500);
    assert.equal(usage.total.hitRate, cacheHitRate({ input: 7, cacheRead: 500, cacheWrite: 0 }));
  } finally {
    harness.close();
  }
});

test("a deferred turn stays in the total and does not replace lastTurn", async () => {
  const success = tokens(11, 3);
  const deferred = tokens(8, 2);
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant("ok", { usage: success })
      : fauxAssistant("later", { usage: deferred, stopReason: "deferred" }),
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    const second = await lane.prompt("two");
    assert.equal(second.status, "completed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(11, 3));
    assert.equal(usage.contextTokens, 14);
    assert.deepEqual(usage.total, total(19, 5));
  } finally {
    harness.close();
  }
});

test("an error turn stays in the total and does not replace lastTurn", async () => {
  const success = tokens(11, 3);
  const failed = tokens(100, 50);
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant("ok", { usage: success })
      : fauxAssistant("nope", { usage: failed, stopReason: "error", errorMessage: "model error" }),
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "failed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(11, 3));
    assert.equal(usage.contextTokens, 14);
    assert.deepEqual(usage.total, total(111, 53));
  } finally {
    harness.close();
  }
});

test("compaction clears context tokens until the next assistant and keeps summary usage in the total", async () => {
  const first = tokens(11, 3);
  const second = tokens(17, 5);
  const summary = tokens(7, 4);
  const next = tokens(8, 9);
  const { models } = scripted([first, second, summary, next], ["one", "two", validSummary("folded"), "three"]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const admitted = await lane.accept({ kind: "navigation", targetId: null, summarize: true });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const folded = await lane.drive(admitted.value.operationId);
    assert.equal(folded.ok && folded.value.kind === "settled" ? folded.value.result.status : "", "completed");
    const compacted = await readUsage(lane);
    assert.equal(compacted.contextTokens, null);
    assert.equal(compacted.lastTurn, null);
    assert.deepEqual(compacted.total, total(35, 12));

    assert.equal((await lane.prompt("three")).status, "completed");
    const continued = await readUsage(lane);
    assert.deepEqual(continued.lastTurn, turn(8, 9));
    assert.equal(continued.contextTokens, 17);
    assert.deepEqual(continued.total, total(43, 21));
  } finally {
    harness.close();
  }
});

test("a real compaction drops the copied assistant until the next turn", async () => {
  const first = tokens(400, 30);
  const summary = tokens(7, 4);
  const next = tokens(8, 9);
  const { models } = scripted([first, summary, next], ["ok", validSummary("folded"), "next"]);
  const harness = runtime(new MemoryStorage(), models, { compaction: { enabled: true, maxTokens: 200 } });
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("U".repeat(2_000))).status, "completed");
    const before = await readUsage(lane);
    assert.equal(before.contextTokens, 430);
    await finishCompaction(lane);
    const entries = await lane.entries();
    let summaryAt = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.payload.type === "compaction") {
        summaryAt = index;
        break;
      }
    }
    assert.ok(summaryAt >= 0);
    const kept = entries.slice(summaryAt + 1);
    assert.equal(kept.some((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant"), true);
    const compacted = await readUsage(lane);
    assert.notEqual(compacted.contextTokens, before.contextTokens);
    assert.equal(compacted.contextTokens, null);
    assert.equal(compacted.lastTurn, null);
    assert.deepEqual(compacted.total, total(407, 34));

    assert.equal((await lane.prompt("three")).status, "completed");
    const continued = await readUsage(lane);
    assert.deepEqual(continued.lastTurn, turn(8, 9));
    assert.equal(continued.contextTokens, 17);
    assert.deepEqual(continued.total, total(415, 43));
  } finally {
    harness.close();
  }
});

test("two compactions each skip only the copied tail just written", async () => {
  const first = tokens(400, 30);
  const summary = tokens(7, 4);
  const second = tokens(8, 9);
  const summaryAgain = tokens(5, 6);
  const third = tokens(3, 4);
  const { models } = scripted(
    [first, summary, second, summaryAgain, third],
    ["ok", validSummary("folded"), "next", validSummary("folded-again"), "after"],
  );
  const harness = runtime(new MemoryStorage(), models, { compaction: { enabled: false, maxTokens: 200 } });
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("U".repeat(2_000))).status, "completed");
    await finishCompaction(lane);
    let entries = await lane.entries();
    let summaryAt = entries.length - 1;
    while (summaryAt >= 0 && entries[summaryAt]?.payload.type !== "compaction") summaryAt -= 1;
    assert.ok(summaryAt >= 0);
    assert.equal(entries.slice(summaryAt + 1).some((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant"), true);
    const once = await readUsage(lane);
    assert.equal(once.contextTokens, null);
    assert.equal(once.lastTurn, null);

    assert.equal((await lane.prompt("U".repeat(2_000))).status, "completed");
    const between = await readUsage(lane);
    assert.deepEqual(between.lastTurn, turn(8, 9));
    assert.equal(between.contextTokens, 17);

    await finishCompaction(lane);
    entries = await lane.entries();
    summaryAt = entries.length - 1;
    while (summaryAt >= 0 && entries[summaryAt]?.payload.type !== "compaction") summaryAt -= 1;
    assert.ok(summaryAt >= 0);
    assert.equal(entries.slice(summaryAt + 1).some((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant"), true);
    const twice = await readUsage(lane);
    assert.equal(twice.contextTokens, null);
    assert.equal(twice.lastTurn, null);
    assert.deepEqual(twice.total, total(420, 49));

    assert.equal((await lane.prompt("three")).status, "completed");
    const continued = await readUsage(lane);
    assert.deepEqual(continued.lastTurn, turn(3, 4));
    assert.equal(continued.contextTokens, 7);
    assert.deepEqual(continued.total, total(423, 53));
  } finally {
    harness.close();
  }
});

test("an earlier unique entry directly after the summary does not count", async () => {
  const storage = new MemoryStorage();
  const odd = tokens(9, 8);
  await storage.commit([
    { type: "entry", id: "user", parentId: null, timestamp: 10, payload: { type: "message", message: { role: "user", content: "seed", timestamp: 10 } } },
    { type: "entry", id: "kept", parentId: "user", timestamp: 20, payload: { type: "message", message: assistantMessage("kept", tokens(2, 2), 20) } },
    { type: "entry", id: "summary", parentId: "kept", timestamp: 100, payload: { type: "compaction", summary: "folded" } },
    { type: "entry", id: "odd", parentId: "summary", timestamp: 40, payload: { type: "message", message: assistantMessage("not-a-copy", odd, 40) } },
    { type: "set", address: value("pi.branch.tip", "main"), value: "odd" },
  ]);
  const { models } = scripted([]);
  const harness = runtime(storage, models);
  try {
    const lane = harness.lane();
    const entries = await lane.entries();
    const oddEntry = entries.find((entry) => entry.id === "odd");
    assert.equal(oddEntry?.payload.type, "message");
    assert.equal(oddEntry?.timestamp, 40);
    const usage = await readUsage(lane);
    assert.equal(usage.lastTurn, null);
    assert.equal(usage.contextTokens, null);
  } finally {
    harness.close();
  }
});

test("an entry written at the summary timestamp still counts", async () => {
  const storage = new MemoryStorage();
  const stamped = 1_700_000_000_000;
  await storage.commit([
    { type: "entry", id: "summary", parentId: null, timestamp: stamped, payload: { type: "compaction", summary: "folded" } },
    { type: "entry", id: "fresh", parentId: "summary", timestamp: stamped, payload: { type: "message", message: assistantMessage("fresh", tokens(4, 5), stamped) } },
    {
      type: "usage",
      id: "fresh-usage",
      operationId: "op-fresh",
      input: 4,
      output: 5,
      totalTokens: 9,
      cacheRead: null,
      cacheWrite: 0,
      reasoning: null,
      model: { provider: "faux", modelId: "faux-1" },
    },
    { type: "set", address: value("pi.branch.tip", "main"), value: "fresh" },
  ]);
  const { models } = scripted([]);
  const harness = runtime(storage, models);
  try {
    const usage = await readUsage(harness.lane());
    assert.deepEqual(usage.lastTurn, turn(4, 5));
    assert.equal(usage.contextTokens, 9);
  } finally {
    harness.close();
  }
});

test("a fresh fork does not inherit the parent cache total", async () => {
  const { models } = scripted([tokens(10, 1, { cacheRead: 100 })]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const main = harness.lane();
    assert.equal((await main.prompt("one")).status, "completed");
    const forkAt = (await main.snapshot()).tipId;
    assert.equal((await main.fork("side", forkAt)).ok, true);
    const inherited = await readUsage(harness.lane("side"));
    assert.deepEqual(inherited.lastTurn, turn(10, 1, { cacheRead: 100 }));
    assert.deepEqual(inherited.total, total(0, 0));
    assert.equal(inherited.contextTokens, 111);
  } finally {
    harness.close();
  }
});

test("navigating back without a summary keeps abandoned rows in the cache sum", async () => {
  const { models } = scripted([
    tokens(11, 3, { cacheRead: 100 }),
    tokens(17, 5, { cacheRead: 40 }),
  ]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    const target = (await lane.snapshot()).tipId;
    assert.ok(target);
    assert.equal((await lane.prompt("two")).status, "completed");
    const admitted = await lane.accept({ kind: "navigation", targetId: target, summarize: false });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const moved = await lane.drive(admitted.value.operationId);
    assert.equal(moved.ok && moved.value.kind === "settled" ? moved.value.result.status : "", "completed");
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(11, 3, { cacheRead: 100 }));
    assert.equal(usage.contextTokens, 114);
    assert.equal(usage.total.input, 28);
    assert.equal(usage.total.output, 8);
    assert.equal(usage.total.cacheRead, 140);
    assert.equal(usage.total.cacheWrite, 0);
    assert.equal(usage.total.hitRate, cacheHitRate({ input: 28, cacheRead: 140, cacheWrite: 0 }));
    assert.equal(usage.total.cost?.total, null);
    assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), false);
  } finally {
    harness.close();
  }
});

test("a reopened harness projects the same usage from the same storage", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const firstUsage = tokens(4, 6);
  const secondUsage = tokens(8, 1);
  const { models } = scripted([firstUsage, secondUsage]);
  const first = runtime(new JsonlStorage(file), models);
  try {
    const lane = first.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const before = await readUsage(lane);
    const reopened = runtime(new JsonlStorage(file), models);
    try {
      assert.deepEqual(await readUsage(reopened.lane()), before);
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
  }
});

test("checkpointed tool output is tailed while running and absent after settle", async () => {
  const body = `head-${"x".repeat(5_000)}-tail`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("log", {})], { usage: tokens(1, 1) })
      : fauxAssistant("after", { usage: tokens(2, 2) }),
  }));
  const harness = runtime(new MemoryStorage(), models, {
    tools: [{
      name: "log",
      description: "log",
      parameters: { type: "object", additionalProperties: true },
      async execute(_args, context) {
        context.onUpdate?.(body, { checkpoint: true });
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      },
    }],
  });
  try {
    const lane = harness.lane();
    const driving = lane.prompt("go");
    await until(async () => (await lane.toolOutput()).tails.length === 1);
    const tails = assertRoundTrip(await lane.toolOutput());
    assert.equal(tails.version, (await lane.snapshot()).version);
    const tail = tails.tails[0];
    assert.ok(tail);
    assert.equal(tail.outputTail.length, 4_000);
    assert.equal(tail.outputTail, body.slice(-4_000));
    const running = (await lane.snapshot()).tools.find((tool) => tool.status === "running");
    assert.ok(running);
    assert.equal("outputTail" in running, false);
    release();
    const settled = await driving;
    assert.equal(settled.status, "completed");
    assert.deepEqual((await lane.toolOutput()).tails, []);
  } finally {
    release();
    harness.close();
  }
});

test("a reopened log still returns the checkpoint tail of a call left running", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const body = `kept-${"z".repeat(20)}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("log", {})], { usage: tokens(1, 1) })
      : fauxAssistant("after", { usage: tokens(2, 2) }),
  }));
  const harness = runtime(new JsonlStorage(file), models, {
    tools: [{
      name: "log",
      description: "log",
      parameters: { type: "object", additionalProperties: true },
      async execute(_args, context) {
        context.onUpdate?.(body, { checkpoint: true });
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      },
    }],
  });
  const driving = harness.lane().prompt("go");
  try {
    await until(async () => (await harness.lane().toolOutput()).tails.length === 1);
    harness.abandon();
    const reopened = runtime(new JsonlStorage(file), models);
    try {
      const lane = reopened.lane();
      const tails = assertRoundTrip(await lane.toolOutput());
      assert.equal(tails.tails.length, 1);
      assert.equal(tails.tails[0]?.outputTail, body);
      const operationId = (await lane.inspect()).operationId;
      assert.ok(operationId);
      const settled = await lane.drive(operationId);
      assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
      assert.deepEqual((await lane.toolOutput()).tails, []);
    } finally {
      reopened.close();
    }
  } finally {
    release();
    await driving.catch(() => undefined);
    harness.close();
  }
});

test("a checkpoint tail does not start on a low surrogate", async () => {
  const marker = "y".repeat(3_999);
  const body = `x${"😀"}${marker}`;
  assert.ok(body.slice(-4_000).charCodeAt(0) >= 0xDC00 && body.slice(-4_000).charCodeAt(0) <= 0xDFFF);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("log", {})], { usage: tokens(1, 1) })
      : fauxAssistant("after", { usage: tokens(2, 2) }),
  }));
  const harness = runtime(new MemoryStorage(), models, {
    tools: [{
      name: "log",
      description: "log",
      parameters: { type: "object", additionalProperties: true },
      async execute(_args, context) {
        context.onUpdate?.(body, { checkpoint: true });
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      },
    }],
  });
  try {
    const lane = harness.lane();
    const driving = lane.prompt("go");
    await until(async () => (await lane.toolOutput()).tails.length === 1);
    const tail = (await lane.toolOutput()).tails[0];
    assert.ok(tail);
    assert.equal(tail.outputTail, marker);
    assert.equal(tail.outputTail.length, 3_999);
    release();
    assert.equal((await driving).status, "completed");
  } finally {
    release();
    harness.close();
  }
});

test("a tool update without checkpoint does not project an output tail", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let updated = false;
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("log", {})])
      : fauxAssistant("after"),
  }));
  const harness = runtime(new MemoryStorage(), models, {
    tools: [{
      name: "log",
      description: "log",
      parameters: { type: "object", additionalProperties: true },
      async execute(_args, context) {
        context.onUpdate?.("partial");
        context.onUpdate?.("partial", { checkpoint: false });
        updated = true;
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      },
    }],
  });
  try {
    const lane = harness.lane();
    const driving = lane.prompt("go");
    await until(async () => updated && (await lane.snapshot()).tools.some((tool) => tool.status === "running"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const tails = assertRoundTrip(await lane.toolOutput());
    assert.deepEqual(tails.tails, []);
    const running = (await lane.snapshot()).tools.find((tool) => tool.status === "running");
    assert.ok(running);
    assert.equal("outputTail" in running, false);
    release();
    assert.equal((await driving).status, "completed");
  } finally {
    release();
    harness.close();
  }
});

test("a forked lane totals only its own operations and reads lastTurn from its branch", async () => {
  const parentA = tokens(10, 1);
  const parentB = tokens(20, 2);
  const child = tokens(30, 3);
  const { models } = scripted([parentA, parentB, child]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const main = harness.lane();
    assert.equal((await main.prompt("one")).status, "completed");
    const forkAt = (await main.snapshot()).tipId;
    assert.equal((await main.fork("side", forkAt)).ok, true);
    const side = harness.lane("side");
    const inherited = await readUsage(side);
    assert.deepEqual(inherited.lastTurn, turn(10, 1));
    assert.deepEqual(inherited.total, total(0, 0));
    assert.equal(inherited.contextTokens, 11);

    assert.equal((await main.prompt("two")).status, "completed");
    assert.equal((await side.prompt("three")).status, "completed");
    const mainUsage = await readUsage(main);
    const sideUsage = await readUsage(side);
    assert.deepEqual(mainUsage.lastTurn, turn(20, 2));
    assert.deepEqual(mainUsage.total, total(30, 3));
    assert.equal(mainUsage.contextTokens, 22);
    assert.deepEqual(sideUsage.lastTurn, turn(30, 3));
    assert.deepEqual(sideUsage.total, total(30, 3));
    assert.equal(sideUsage.contextTokens, 33);
  } finally {
    harness.close();
  }
});

test("a fresh lane with a hit price sums cache reads and prices the rows", async () => {
  const first = tokens(4, 2, { cacheRead: 6, cacheWrite: 1 });
  const second = tokens(3, 5, { cacheRead: 8, cacheWrite: 2 });
  const provider = fauxProvider({
    respond: (_context, _options, state) => fauxAssistant(`reply-${state.callCount}`, {
      usage: state.callCount === 1 ? first : second,
    }),
  });
  const model = priceOf(provider, { input: 2_000_000, output: 4_000_000, cacheRead: 500_000, cacheWrite: 1_000_000 });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    const one = usageCost(model, first);
    const two = usageCost(model, second);
    assert.ok(one && two && one.total !== null && two.total !== null && one.cacheRead !== null && two.cacheRead !== null);
    const cacheRead = (first.cacheRead ?? 0) + (second.cacheRead ?? 0);
    const cacheWrite = (first.cacheWrite ?? 0) + (second.cacheWrite ?? 0);
    assert.equal(usage.total.cacheRead, cacheRead);
    assert.equal(usage.total.cacheWrite, cacheWrite);
    assert.equal(typeof usage.total.hitRate, "number");
    assert.equal(usage.total.hitRate, cacheHitRate({
      input: first.input + second.input,
      cacheRead,
      cacheWrite,
    }));
    assert.equal(typeof usage.total.cost?.total, "number");
    assert.equal(usage.total.cost?.total, one.total + two.total);
    assert.equal(usage.total.cost?.input, one.input + two.input);
    assert.equal(usage.total.cost?.output, one.output + two.output);
    assert.equal(usage.total.cost?.cacheRead, one.cacheRead + two.cacheRead);
    assert.equal(usage.total.cost?.cacheWrite, one.cacheWrite + two.cacheWrite);
    assert.equal(usage.lastTurn?.hitRate, cacheHitRate(second));
    assert.deepEqual(usage.lastTurn?.cost, two);
    const rows = await harness.storage.read((view) => view.usageRows());
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.cacheRead !== undefined && row.model?.modelId === "faux-1"), true);
  } finally {
    harness.close();
  }
});

test("cumulative cost sums each row at that row's own prices", async () => {
  const first = tokens(10, 4, { cacheRead: 2, cacheWrite: 1 });
  const second = tokens(8, 3, { cacheRead: 5, cacheWrite: 0 });
  let call = 0;
  const respond = () => {
    call += 1;
    return fauxAssistant(call === 1 ? "one" : "two", { usage: call === 1 ? first : second });
  };
  const alpha = fauxProvider({ id: "alpha", modelId: "alpha-1", respond });
  const beta = fauxProvider({ id: "beta", modelId: "beta-1", respond });
  const alphaModel = priceOf(alpha, { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 200_000 });
  const betaModel = priceOf(beta, { input: 3_000_000, output: 5_000_000, cacheRead: 400_000, cacheWrite: 600_000 });
  const models = createModels();
  models.setProvider(alpha);
  models.setProvider(beta);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "alpha", modelId: "alpha-1" },
    compaction: { enabled: false, maxTokens: 50_000 },
  });
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.configure({ provider: "beta", modelId: "beta-1" })).ok, true);
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    const left = usageCost(alphaModel, first);
    const right = usageCost(betaModel, second);
    assert.ok(left && right && left.total !== null && right.total !== null);
    assert.ok(left.cacheRead !== null && right.cacheRead !== null);
    assert.deepEqual(usage.lastTurn?.cost, right);
    assert.equal(usage.lastTurn?.hitRate, cacheHitRate(second));
    assert.equal(usage.total.cost?.input, left.input + right.input);
    assert.equal(usage.total.cost?.output, left.output + right.output);
    assert.equal(usage.total.cost?.cacheRead, left.cacheRead + right.cacheRead);
    assert.equal(usage.total.cost?.cacheWrite, left.cacheWrite + right.cacheWrite);
    assert.equal(usage.total.cost?.total, left.total + right.total);
    const rows = await harness.storage.read((view) => view.usageRows());
    assert.deepEqual(rows.map((row) => row.model), [
      { provider: "alpha", modelId: "alpha-1" },
      { provider: "beta", modelId: "beta-1" },
    ]);
  } finally {
    harness.close();
  }
});

test("a cache hit without a hit price nulls that charge and the cumulative total", async () => {
  const pricedUsage = tokens(5, 1, { cacheRead: 2, cacheWrite: 0 });
  const missed = tokens(4, 2, { cacheRead: 9, cacheWrite: 3 });
  let call = 0;
  const respond = () => {
    call += 1;
    return fauxAssistant(call === 1 ? "one" : "two", { usage: call === 1 ? pricedUsage : missed });
  };
  const priced = fauxProvider({ id: "priced", modelId: "priced-1", respond });
  const bare = fauxProvider({ id: "bare", modelId: "bare-1", respond });
  const pricedModel = priceOf(priced, { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 100_000 });
  const bareModel = priceOf(bare, { input: 3_000_000, output: 4_000_000, cacheWrite: 500_000 });
  const models = createModels();
  models.setProvider(priced);
  models.setProvider(bare);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "priced", modelId: "priced-1" },
    compaction: { enabled: false, maxTokens: 50_000 },
  });
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    assert.equal((await lane.configure({ provider: "bare", modelId: "bare-1" })).ok, true);
    assert.equal((await lane.prompt("two")).status, "completed");
    const usage = await readUsage(lane);
    const left = usageCost(pricedModel, pricedUsage);
    const right = usageCost(bareModel, missed);
    assert.ok(left && right);
    assert.equal(right.cacheRead, null);
    assert.equal(right.total, null);
    assert.equal(typeof right.input, "number");
    assert.equal(typeof right.output, "number");
    assert.deepEqual(usage.lastTurn?.cost, right);
    assert.equal(usage.lastTurn?.hitRate, cacheHitRate(missed));
    assert.equal(usage.total.cost?.input, left.input + right.input);
    assert.equal(usage.total.cost?.output, left.output + right.output);
    assert.equal(usage.total.cost?.cacheWrite, left.cacheWrite + right.cacheWrite);
    assert.equal(usage.total.cost?.cacheRead, null);
    assert.equal(usage.total.cost?.total, null);
  } finally {
    harness.close();
  }
});

test("an old usage row without a model nulls the cumulative cost", async () => {
  const provider = fauxProvider();
  priceOf(provider, { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 100_000 });
  const models = createModels();
  models.setProvider(provider);
  const storage = new MemoryStorage();
  await storage.commit([
    { type: "usage", id: "old", operationId: "op-old", input: 10, output: 4, totalTokens: 14 },
    { type: "set", address: value("pi.result", "op-old"), value: { lane: "main" } },
    {
      type: "usage",
      id: "fresh",
      operationId: "op-fresh",
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 5,
      cacheWrite: 0,
      model: { provider: "faux", modelId: "faux-1" },
    },
    { type: "set", address: value("pi.result", "op-fresh"), value: { lane: "main" } },
  ]);
  const harness = runtime(storage, models);
  try {
    const usage = await readUsage(harness.lane());
    assert.equal(usage.total.input, 11);
    assert.equal(usage.total.output, 5);
    assert.equal(usage.total.cacheRead, null);
    assert.equal(usage.total.cacheWrite, null);
    assert.equal(usage.total.hitRate, null);
    assert.equal(usage.total.cost, null);
  } finally {
    harness.close();
  }
});

test("laneStatus reports the retry error and its deadline", async () => {
  const provider = fauxProvider({
    respond: () => fauxAssistant("later", { stopReason: "error", retryable: true, errorMessage: "rate limited" }),
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    maxAttempts: 3,
    retry: { baseDelayMs: 400, maxDelayMs: 1_000 },
    compaction: { enabled: false, maxTokens: 50_000 },
  });
  try {
    const lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const before = Date.now();
    const outcome = await lane.drive(admitted.value.operationId);
    const after = Date.now();
    assert.equal(outcome.ok && outcome.value.kind === "waiting", true);
    if (!outcome.ok || outcome.value.kind !== "waiting") return;
    const status = assertRoundTrip(await lane.laneStatus());
    assert.equal(status.retryReason, "rate limited");
    assert.equal(status.compacting, false);
    assert.equal(status.notBefore, outcome.value.notBefore);
    assert.ok(status.notBefore !== null && status.notBefore >= before + 400 && status.notBefore <= after + 400);
  } finally {
    harness.close();
  }
});

test("laneStatus reports compaction while the summary stream is open", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fauxProvider({
    respond: async (_context, _options, state) => {
      if (state.callCount === 2) await gate;
      return fauxAssistant(state.callCount === 1 ? "ok" : validSummary("folded"), { usage: tokens(state.callCount, 1) });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models, { compaction: { enabled: false, maxTokens: 50_000 } });
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("one")).status, "completed");
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const driving = lane.drive(admitted.value.operationId);
    await until(async () => (await lane.laneStatus()).compacting);
    const status = assertRoundTrip(await lane.laneStatus());
    assert.equal(status.compacting, true);
    assert.equal(status.notBefore, null);
    assert.equal(status.retryReason, null);
    release();
    const folded = await driving;
    assert.equal(folded.ok && folded.value.kind === "settled" ? folded.value.result.status : "", "completed");
    assert.equal((await lane.laneStatus()).compacting, false);
  } finally {
    release();
    harness.close();
  }
});

test("an approval wait leaves retryReason and notBefore null", async () => {
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("work", { path: "a" }, "call-1")])
      : fauxAssistant("after"),
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [{
      name: "work",
      description: "work",
      parameters: { type: "object", additionalProperties: true },
      execute: async () => ({ content: [{ type: "text", text: "work" }] }),
    }],
    requiresApproval: () => true,
    compaction: { enabled: false, maxTokens: 50_000 },
  });
  try {
    const lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind, "waiting");
    assert.equal((await lane.pendingApprovals()).items.length, 1);
    const status = assertRoundTrip(await lane.laneStatus());
    assert.equal(status.retryReason, null);
    assert.equal(status.notBefore, null);
    assert.equal(status.compacting, false);
    assert.equal(status.turnStartedAt, admitted.value.startedAt);
  } finally {
    harness.close();
  }
});

test("an idle lane has no turn start, and a finished turn clears it", async () => {
  const { models } = scripted([tokens(1, 1)]);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    assert.equal((await lane.laneStatus()).turnStartedAt, null);
    assert.equal((await lane.prompt("one")).status, "completed");
    const idle = assertRoundTrip(await lane.laneStatus());
    assert.equal(idle.turnStartedAt, null);
    assert.equal(idle.notBefore, null);
    assert.equal(idle.retryReason, null);
    assert.equal(idle.compacting, false);
  } finally {
    harness.close();
  }
});

test("turnStartedAt is the persisted run start and survives reopening the same log", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-turn-start-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fauxProvider({
    respond: async () => {
      await gate;
      return fauxAssistant("ok", { usage: tokens(1, 1) });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new JsonlStorage(file), models);
  const driving = (async () => {
    const lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const started = assertRoundTrip(await lane.laneStatus()).turnStartedAt;
    assert.equal(typeof started, "number");
    assert.equal(started, admitted.value.startedAt);
    const outcome = lane.drive(admitted.value.operationId);
    await until(async () => (await lane.inspect()).phase === "assistant_effect_pending");
    assert.equal((await lane.laneStatus()).turnStartedAt, started);
    harness.abandon();
    const reopened = runtime(new JsonlStorage(file), models);
    try {
      const again = assertRoundTrip(await reopened.lane().laneStatus());
      assert.equal(again.turnStartedAt, started);
      assert.equal((await reopened.lane().inspect()).operationId, admitted.value.operationId);
    } finally {
      reopened.close();
    }
    release();
    await outcome;
  })();
  try {
    await driving;
  } finally {
    release();
    await driving.catch(() => undefined);
    harness.close();
  }
});

test("a turn started from a queued follow-up uses that operation's startedAt", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fauxProvider({
    respond: async () => {
      await gate;
      return fauxAssistant("ok", { usage: tokens(2, 2) });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models);
  try {
    const lane = harness.lane();
    const queued = await lane.followUp("from-queue");
    assert.equal(queued.ok, true);
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const driving = lane.drive(admitted.value.operationId);
    await until(async () => (await lane.inspect()).phase === "assistant_effect_pending");
    const texts = (await lane.entries()).flatMap((entry) => entry.payload.type === "message" && entry.payload.message.role === "user"
      ? [typeof entry.payload.message.content === "string" ? entry.payload.message.content : ""]
      : []);
    assert.equal(texts.includes("from-queue"), true);
    const status = assertRoundTrip(await lane.laneStatus());
    assert.equal(typeof status.turnStartedAt, "number");
    assert.equal(status.turnStartedAt, admitted.value.startedAt);
    release();
    const settled = await driving;
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
    assert.equal((await lane.laneStatus()).turnStartedAt, null);
  } finally {
    release();
    harness.close();
  }
});

test("turnStartedAt stays put across a tool call and the following model call", async () => {
  let lane: AgentLane | undefined;
  const seen: Array<number | null> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fauxProvider({
    respond: async (_context, _options, state) => {
      seen.push((await lane?.laneStatus())?.turnStartedAt ?? null);
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("work", {})], { usage: tokens(3, 1) });
      await gate;
      return fauxAssistant("after", { usage: tokens(4, 1) });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models, {
    tools: [{
      name: "work",
      description: "work",
      parameters: { type: "object", additionalProperties: true },
      execute: async () => {
        seen.push((await lane?.laneStatus())?.turnStartedAt ?? null);
        return { content: [{ type: "text", text: "done" }] };
      },
    }],
  });
  try {
    lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const driving = lane.drive(admitted.value.operationId);
    await until(async () => seen.length >= 3);
    assert.equal(seen.every((value) => value === admitted.value.startedAt), true);
    const duringSecond = assertRoundTrip(await lane.laneStatus());
    assert.equal(duringSecond.turnStartedAt, admitted.value.startedAt);
    assert.equal(duringSecond.compacting, false);
    release();
    const settled = await driving;
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
    assert.equal((await lane.laneStatus()).turnStartedAt, null);
  } finally {
    release();
    harness.close();
  }
});

test("a retry wait and the retried model call keep the same turnStartedAt", async () => {
  let lane: AgentLane | undefined;
  const seen: Array<number | null> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fauxProvider({
    respond: async (_context, _options, state) => {
      seen.push((await lane?.laneStatus())?.turnStartedAt ?? null);
      if (state.callCount === 1) {
        return fauxAssistant("later", { usage: tokens(1, 1), stopReason: "error", retryable: true, errorMessage: "rate limited" });
      }
      await gate;
      return fauxAssistant("ok", { usage: tokens(2, 1) });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    maxAttempts: 3,
    retry: { baseDelayMs: 50, maxDelayMs: 50 },
    compaction: { enabled: false, maxTokens: 50_000 },
  });
  try {
    lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const waiting = await lane.drive(admitted.value.operationId);
    assert.equal(waiting.ok && waiting.value.kind === "waiting", true);
    const during = assertRoundTrip(await lane.laneStatus());
    assert.equal(during.retryReason, "rate limited");
    assert.equal(during.turnStartedAt, admitted.value.startedAt);
    assert.equal(seen[0], admitted.value.startedAt);
    const continued = lane.drive(admitted.value.operationId, { waitForRetry: true });
    await until(async () => seen.length >= 2);
    assert.equal(seen[1], admitted.value.startedAt);
    assert.equal((await lane.laneStatus()).turnStartedAt, admitted.value.startedAt);
    release();
    const settled = await continued;
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
    assert.equal((await lane.laneStatus()).turnStartedAt, null);
  } finally {
    release();
    harness.close();
  }
});

test("an approval wait keeps the turn start taken before the tool call", async () => {
  let lane: AgentLane | undefined;
  let before: number | null = null;
  const provider = fauxProvider({
    respond: async (_context, _options, state) => {
      if (state.callCount === 1) {
        before = (await lane?.laneStatus())?.turnStartedAt ?? null;
        return fauxAssistant([fauxToolCall("work", {}, "call-1")]);
      }
      return fauxAssistant("after");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [{
      name: "work",
      description: "work",
      parameters: { type: "object", additionalProperties: true },
      execute: async () => ({ content: [{ type: "text", text: "work" }] }),
    }],
    requiresApproval: () => true,
    compaction: { enabled: false, maxTokens: 50_000 },
  });
  try {
    lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind, "waiting");
    assert.equal((await lane.pendingApprovals()).items.length, 1);
    const status = assertRoundTrip(await lane.laneStatus());
    assert.equal(before, admitted.value.startedAt);
    assert.equal(status.turnStartedAt, before);
    assert.equal(status.retryReason, null);
    assert.equal(status.notBefore, null);
  } finally {
    harness.close();
  }
});

test("auto-compaction stays inside the same turn start", async () => {
  let lane: AgentLane | undefined;
  const seen: Array<number | null> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fauxProvider({
    respond: async (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant("short", { usage: tokens(1, 1) });
      const status = await lane?.laneStatus();
      seen.push(status?.turnStartedAt ?? null);
      if (state.callCount === 2) {
        assert.equal(status?.compacting, true);
        return fauxAssistant(validSummary("folded"), { usage: tokens(7, 4) });
      }
      await gate;
      return fauxAssistant("answer", { usage: tokens(2, 1) });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = runtime(new MemoryStorage(), models, { compaction: { enabled: true, maxTokens: 20 } });
  try {
    lane = harness.lane();
    assert.equal((await lane.prompt("Y".repeat(200))).status, "completed");
    assert.equal((await lane.laneStatus()).turnStartedAt, null);
    const admitted = await lane.accept({ kind: "prompt", text: "CURRENT_QUESTION" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const driving = lane.drive(admitted.value.operationId);
    await until(async () => seen.length >= 2);
    assert.equal(seen.every((value) => value === admitted.value.startedAt), true);
    assert.equal((await lane.laneStatus()).turnStartedAt, admitted.value.startedAt);
    release();
    const settled = await driving;
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
    assert.equal((await lane.laneStatus()).turnStartedAt, null);
  } finally {
    release();
    harness.close();
  }
});
