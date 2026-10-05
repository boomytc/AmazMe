import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, type FauxResponder } from "@amazme/ai/testing";
import { AgentHarness, compactionReserve, type Entry } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { validSummary } from "./valid-summary.ts";

/**
 * Same compaction `openJsonlRuntime` passes when the caller omits it:
 * enabled, and `maxTokens` is the current model's `contextWindow` minus `compactionReserve`.
 */
function hostOptions(models: ReturnType<typeof createModels>) {
  const model = models.getModel("faux", "faux-1");
  if (!model) throw new Error("faux model missing");
  const maxTokens = model.contextWindow - compactionReserve(model.contextWindow);
  return {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "host",
    workspace: "workspace",
    compaction: { enabled: true as const, maxTokens },
  };
}

function overflow() {
  return fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" });
}

/** Longer than the keep-recent budget, so an earlier turn can be summarized. */
const oldTurn = "O".repeat(40_000);

function openLane(file: string, respond: FauxResponder) {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  const storage = new JsonlStorage(file);
  const runtime = new AgentHarness(storage, hostOptions(models));
  return { provider, storage, runtime };
}

async function closeLane(runtime: AgentHarness, storage: JsonlStorage): Promise<void> {
  await runtime.close();
  await storage.close();
}

function directory(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "amazme-host-compact-"));
  return { dir, file: join(dir, "lane.jsonl") };
}

test("reserve scales with the window and the host trigger is the window minus that reserve", () => {
  assert.equal(compactionReserve(200), 64);
  assert.equal(compactionReserve(128_000), 8_192);
  assert.equal(compactionReserve(200_000), 8_192);
});

test("overflow compacts once and the retry succeeds", async () => {
  const { dir, file } = directory();
  const lane = openLane(file, (_context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant("kept");
    if (state.callCount === 2) return overflow();
    if (state.callCount === 3) return fauxAssistant(validSummary("folded the old goal"));
    return fauxAssistant("continued");
  });
  try {
    const session = lane.runtime.lane();
    const model = lane.runtime.options.models.getModel("faux", "faux-1");
    assert.ok(model);
    assert.equal(
      (await session.usage()).compactionThreshold,
      model.contextWindow - compactionReserve(model.contextWindow),
    );
    assert.equal((await session.prompt(oldTurn)).status, "completed");
    const result = await session.prompt("CURRENT");
    assert.equal(result.status, "completed");
    assert.equal(lane.provider.state.callCount, 4);
    assert.equal((await session.entries()).filter((entry) => entry.payload.type === "compaction").length, 1);
    const continued = JSON.stringify(lane.provider.state.contexts[3]);
    assert.match(continued, /CURRENT/);
    assert.match(continued, /folded the old goal/);
    assert.equal(continued.includes(oldTurn), false);
  } finally {
    await closeLane(lane.runtime, lane.storage);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second overflow after compaction fails with context overflow repeated and does not call the model again", async () => {
  const { dir, file } = directory();
  const lane = openLane(file, (_context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant("kept");
    if (state.callCount === 3) return fauxAssistant(validSummary("folded the old goal"));
    return overflow();
  });
  try {
    const session = lane.runtime.lane();
    assert.equal((await session.prompt(oldTurn)).status, "completed");
    const result = await session.prompt("CURRENT");
    assert.equal(result.status, "failed");
    assert.equal(result.error, "context overflow repeated");
    assert.equal(lane.provider.state.callCount, 4);
    assert.equal((await session.entries()).filter((entry) => entry.payload.type === "compaction").length, 1);
  } finally {
    await closeLane(lane.runtime, lane.storage);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overflow with nothing to compact fails and the next prompt still runs", async () => {
  const { dir, file } = directory();
  const lane = openLane(file, (_context, _options, state) => {
    if (state.callCount === 1) return overflow();
    return fauxAssistant("continued");
  });
  try {
    const session = lane.runtime.lane();
    const failed = await session.prompt("hello");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "context overflow; nothing to compact");
    assert.equal(lane.provider.state.callCount, 1);
    assert.equal((await session.entries()).some((entry) => entry.payload.type === "compaction"), false);
    const next = await session.prompt("next");
    assert.equal(next.status, "completed");
    assert.equal(lane.provider.state.callCount, 2);
    assert.equal((await session.entries()).some((entry) => entry.payload.type === "compaction"), false);
  } finally {
    await closeLane(lane.runtime, lane.storage);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed overflow recovery does not resend the model or compaction request when the jsonl lane is reopened", async () => {
  const { dir, file } = directory();
  const lane = openLane(file, (_context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant("kept");
    if (state.callCount === 3) return fauxAssistant(validSummary("folded the old goal"));
    return overflow();
  });
  let operationId = "";
  let compactions: Entry[] = [];
  try {
    const session = lane.runtime.lane();
    assert.equal((await session.prompt(oldTurn)).status, "completed");
    const failed = await session.prompt("CURRENT");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "context overflow repeated");
    assert.equal(lane.provider.state.callCount, 4);
    operationId = failed.operationId;
    compactions = (await session.entries()).filter((entry) => entry.payload.type === "compaction");
    assert.equal(compactions.length, 1);
    await closeLane(lane.runtime, lane.storage);

    const reopened = openLane(file, () => fauxAssistant("should not run"));
    try {
      const again = reopened.runtime.lane();
      const outcome = await again.drive(operationId);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.ok && outcome.value.kind, "settled");
      assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "failed");
      assert.equal(
        outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error : "",
        "context overflow repeated",
      );
      assert.equal(reopened.provider.state.callCount, 0);
      const stored = (await again.entries()).filter((entry) => entry.payload.type === "compaction");
      assert.equal(stored.length, compactions.length);
      assert.equal(stored[0]?.id, compactions[0]?.id);
      assert.equal((await again.inspect()).operationId, null);
    } finally {
      await closeLane(reopened.runtime, reopened.storage);
    }
  } finally {
    await closeLane(lane.runtime, lane.storage);
    rmSync(dir, { recursive: true, force: true });
  }
});
