import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, type Usage } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";
import { AgentHarness, type AgentLane, effectiveInputThreshold, type HarnessTool, type LaneUsage, type LaneUsageView } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";

function tokens(input: number, output: number, cache: { cacheRead?: number; cacheWrite?: number } = {}): Usage {
  return { input, output, totalTokens: input + output, cost: { input: 0, output: 0, total: 0 }, ...cache };
}

function turn(input: number, output: number): NonNullable<LaneUsage["lastTurn"]> {
  return { input, output, cacheRead: null, cacheWrite: null };
}

function total(input: number, output: number): LaneUsage["total"] {
  return { input, output, cacheRead: null, cacheWrite: null };
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
    assert.deepEqual(usage.lastTurn, { input: 3, output: 4, cacheRead: 10, cacheWrite: null });
    assert.equal(usage.contextTokens, 17);
    assert.deepEqual(usage.total, total(3, 4));
  } finally {
    harness.close();
  }
});

test("an assistant without cache leaves the cache counts null", async () => {
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

test("a reported cache zero stays on lastTurn while the row total leaves cache null", async () => {
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
    assert.deepEqual(usage.lastTurn, { input: 2, output: 2, cacheRead: 0, cacheWrite: 4 });
    assert.equal(usage.contextTokens, 8);
    assert.deepEqual(usage.total, total(3, 3));
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
  const { models } = scripted([first, second, summary, next], ["one", "two", "folded", "three"]);
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
  const { models } = scripted([first, summary, next], ["ok", "folded", "next"]);
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
    ["ok", "folded", "next", "folded-again", "after"],
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

test("a new assistant identical to the copied tail still counts", async () => {
  const same = tokens(400, 30);
  const summary = tokens(7, 4);
  const { models } = scripted([same, summary, same], ["ok", "folded", "ok"]);
  const harness = runtime(new MemoryStorage(), models, { compaction: { enabled: true, maxTokens: 200 } });
  try {
    const lane = harness.lane();
    assert.equal((await lane.prompt("U".repeat(2_000))).status, "completed");
    await finishCompaction(lane);
    const compacted = await readUsage(lane);
    assert.equal(compacted.contextTokens, null);
    assert.equal(compacted.lastTurn, null);

    assert.equal((await lane.prompt("three")).status, "completed");
    const entries = await lane.entries();
    const assistants = entries.filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant");
    const copied = assistants[0];
    const created = assistants[assistants.length - 1];
    assert.ok(copied && created);
    assert.equal(copied.payload.type, "message");
    assert.equal(created.payload.type, "message");
    if (copied.payload.type !== "message" || created.payload.type !== "message") return;
    assert.equal(copied.payload.message.role, "assistant");
    assert.equal(created.payload.message.role, "assistant");
    if (copied.payload.message.role !== "assistant" || created.payload.message.role !== "assistant") return;
    assert.deepEqual(created.payload.message.content, copied.payload.message.content);
    assert.equal(created.payload.message.usage.input, copied.payload.message.usage.input);
    assert.equal(created.payload.message.usage.output, copied.payload.message.usage.output);
    const summaryEntry = entries.find((entry) => entry.payload.type === "compaction");
    assert.ok(summaryEntry);
    assert.ok(created.timestamp >= summaryEntry.timestamp);
    const usage = await readUsage(lane);
    assert.deepEqual(usage.lastTurn, turn(400, 30));
    assert.equal(usage.contextTokens, 430);
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
    assert.deepEqual(inherited.lastTurn, { input: 10, output: 1, cacheRead: 100, cacheWrite: null });
    assert.deepEqual(inherited.total, total(0, 0));
    assert.equal(inherited.contextTokens, 111);
  } finally {
    harness.close();
  }
});

test("navigating back without a summary keeps abandoned rows and leaves cache null", async () => {
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
    assert.deepEqual(usage.lastTurn, { input: 11, output: 3, cacheRead: 100, cacheWrite: null });
    assert.equal(usage.contextTokens, 114);
    assert.deepEqual(usage.total, total(28, 8));
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
