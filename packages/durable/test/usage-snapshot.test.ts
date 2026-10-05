import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, type Usage } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";
import { AgentHarness, effectiveInputThreshold, type HarnessTool, type LaneUsage } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";

function tokens(input: number, output: number): Usage {
  return { input, output, totalTokens: input + output, cost: { input: 0, output: 0, total: 0 } };
}

function turn(input: number, output: number): NonNullable<LaneUsage["lastTurn"]> {
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
    const snap = await harness.lane().snapshot();
    const usage = snap.usage;
    const model = models.getModel("faux", "faux-1");
    assert.ok(model);
    assert.equal(usage.lastTurn, null);
    assert.equal(usage.contextTokens, null);
    assert.deepEqual(usage.total, { input: 0, output: 0 });
    assert.equal(usage.compactionThreshold, effectiveInputThreshold(model.contextWindow, 50_000));
    assert.equal(Object.hasOwn(snap, "usage"), false);
    assert.equal(JSON.stringify(snap).includes("\"usage\""), false);
    usage.total.input = 9;
    assert.deepEqual((await harness.lane().snapshot()).usage.total, { input: 0, output: 0 });

    const disabled = runtime(new MemoryStorage(), models, { compaction: { enabled: false, maxTokens: 50_000 } });
    try {
      assert.equal((await disabled.lane().snapshot()).usage.compactionThreshold, null);
    } finally {
      disabled.close();
    }

    const unknown = runtime(new MemoryStorage(), models, { modelId: "missing" });
    try {
      assert.equal((await unknown.lane().snapshot()).usage.compactionThreshold, null);
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
    const usage = (await lane.snapshot()).usage;
    assert.deepEqual(usage.lastTurn, turn(17, 5));
    assert.deepEqual(usage.total, { input: 28, output: 8 });
    assert.equal(usage.contextTokens, 22);
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
    const usage = (await lane.snapshot()).usage;
    assert.deepEqual(usage.lastTurn, turn(11, 3));
    assert.equal(usage.contextTokens, 14);
    assert.deepEqual(usage.total, { input: 111, output: 53 });
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
    const compacted = (await lane.snapshot()).usage;
    assert.equal(compacted.contextTokens, null);
    assert.equal(compacted.lastTurn, null);
    assert.deepEqual(compacted.total, { input: 35, output: 12 });

    assert.equal((await lane.prompt("three")).status, "completed");
    const continued = (await lane.snapshot()).usage;
    assert.deepEqual(continued.lastTurn, turn(8, 9));
    assert.equal(continued.contextTokens, 17);
    assert.deepEqual(continued.total, { input: 43, output: 21 });
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
    const before = (await lane.snapshot()).usage;
    const reopened = runtime(new JsonlStorage(file), models);
    try {
      assert.deepEqual((await reopened.lane().snapshot()).usage, before);
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
    await until(async () => (await lane.snapshot()).tools.some((tool) => tool.outputTail !== undefined));
    const running = (await lane.snapshot()).tools.find((tool) => tool.status === "running");
    assert.ok(running);
    assert.equal(running.outputTail?.length, 4_000);
    assert.equal(running.outputTail, body.slice(-4_000));
    assert.equal(Object.hasOwn(running, "outputTail"), false);
    assert.equal(JSON.stringify(running).includes("outputTail"), false);
    release();
    const settled = await driving;
    assert.equal(settled.status, "completed");
    assert.deepEqual((await lane.snapshot()).tools, []);
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
    const running = (await lane.snapshot()).tools.find((tool) => tool.status === "running");
    assert.ok(running);
    assert.equal(running.outputTail, undefined);
    assert.equal(Object.hasOwn(running, "outputTail"), false);
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
    const inherited = (await side.snapshot()).usage;
    assert.deepEqual(inherited.lastTurn, turn(10, 1));
    assert.deepEqual(inherited.total, { input: 0, output: 0 });
    assert.equal(inherited.contextTokens, 11);

    assert.equal((await main.prompt("two")).status, "completed");
    assert.equal((await side.prompt("three")).status, "completed");
    const mainUsage = (await main.snapshot()).usage;
    const sideUsage = (await side.snapshot()).usage;
    assert.deepEqual(mainUsage.lastTurn, turn(20, 2));
    assert.deepEqual(mainUsage.total, { input: 30, output: 3 });
    assert.equal(mainUsage.contextTokens, 22);
    assert.deepEqual(sideUsage.lastTurn, turn(30, 3));
    assert.deepEqual(sideUsage.total, { input: 30, output: 3 });
    assert.equal(sideUsage.contextTokens, 33);
  } finally {
    harness.close();
  }
});
