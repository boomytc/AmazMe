import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/testing";
import { compactionReserve } from "@amazme/durable";
import { openJsonlRuntime } from "@amazme/runtime-service/jsonl";

test("openJsonlRuntime enables compaction at contextWindow minus the reserve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-jsonl-compact-"));
  const file = join(dir, "lane.jsonl");
  const models = createModels();
  models.setProvider(fauxProvider());
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const resources = await openJsonlRuntime(file, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "host",
    workspace: "workspace",
  });
  try {
    const usage = await resources.harness.lane().usage();
    assert.equal(usage.compactionThreshold, model.contextWindow - compactionReserve(model.contextWindow));
  } finally {
    await resources.closeStorage();
    await resources.release();
    rmSync(dir, { recursive: true, force: true });
  }
});
