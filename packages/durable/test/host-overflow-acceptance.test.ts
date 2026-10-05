import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/testing";
import { AgentHarness } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";

/**
 * Harness options that omit `compaction`. The harness then stores `{ enabled: false, maxTokens: 80_000 }`.
 * Overflow on that path fails in place. It does not summarize.
 * The host path enables compaction inside `openJsonlRuntime`; that path is covered separately.
 */
function hostOptions(models: ReturnType<typeof createModels>) {
  return {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "host",
    workspace: "workspace",
  };
}

async function reopen(file: string, operationId: string): Promise<void> {
  const provider = fauxProvider({
    respond: () => fauxAssistant("should not run"),
  });
  const models = createModels();
  models.setProvider(provider);
  const storage = new JsonlStorage(file);
  const runtime = new AgentHarness(storage, hostOptions(models));
  try {
    const lane = runtime.lane();
    assert.equal((await lane.usage()).compactionThreshold, null);
    const outcome = await lane.drive(operationId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.value.kind, "settled");
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "failed");
    assert.match(
      outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error ?? "" : "",
      /compaction is disabled/,
    );
    assert.equal(provider.state.callCount, 0);
    assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), false);
    assert.equal((await lane.inspect()).operationId, null);
  } finally {
    await runtime.close();
    await storage.close();
  }
}

test("a jsonl lane that omits compaction fails overflow once and does not compact on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-host-overflow-"));
  const file = join(dir, "lane.jsonl");
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      if (state.callCount === 1) {
        return fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" });
      }
      return fauxAssistant("continued");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const storage = new JsonlStorage(file);
  const runtime = new AgentHarness(storage, hostOptions(models));
  try {
    const lane = runtime.lane();
    assert.equal((await lane.usage()).compactionThreshold, null);
    const failed = await lane.prompt("hello");
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /compaction is disabled/);
    assert.equal(provider.state.callCount, 1);
    assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), false);
    assert.equal((await lane.inspect()).phase, null);

    const continued = await lane.prompt("next");
    assert.equal(continued.status, "completed");
    assert.equal(provider.state.callCount, 2);
    assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), false);
    await runtime.close();
    await storage.close();
    await reopen(file, failed.operationId);
  } finally {
    await runtime.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
