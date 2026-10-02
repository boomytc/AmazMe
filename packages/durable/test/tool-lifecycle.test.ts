import assert from "node:assert/strict";
import test from "node:test";
import { AgentHarness, type HarnessTool, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { createModels, fauxAssistant, fauxProvider, fauxToolCall, messageText } from "@amazme/ai";

class CheckpointFaultStorage extends MemoryStorage {
  protected override persist(writes: Write[]): void {
    if (writes.some((write) => write.type === "set" && write.address.namespace === "pi.pending.tool_output")) {
      throw new Error("checkpoint failed");
    }
    super.persist(writes);
  }
}

function harness(storage: MemoryStorage, execute: HarnessTool["execute"]) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("work", {})]);
      return fauxAssistant("after");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const tool: HarnessTool = {
    name: "work",
    description: "work",
    parameters: { type: "object", additionalProperties: true },
    replay: "never",
    execute,
  };
  const lane = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    systemPrompt: "sys",
  }).lane();
  return { lane, provider };
}

test("a failed checkpoint write is awaited and is not settled as success", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const storage = new CheckpointFaultStorage();
    let runs = 0;
    const { lane, provider } = harness(storage, async (_args, context) => {
      runs += 1;
      context.onUpdate?.("partial", { checkpoint: true });
      return { content: [{ type: "text", text: "done" }] };
    });
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /checkpoint failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    const settled = await storage.read((view) => view.entries().some((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult"));
    assert.equal(settled, false);
    const checkpoint = await storage.read((view) => view.values().some((item) => item.key.includes("pi.pending.tool_output")));
    assert.equal(checkpoint, false);
    const recovered = await lane.drive(admitted.value.operationId);
    assert.equal(recovered.ok, true);
    if (!recovered.ok || recovered.value.kind !== "settled") assert.fail("expected settlement");
    assert.equal(recovered.value.result.status, "completed");
    assert.equal(runs, 1);
    assert.equal(provider.state.callCount, 2);
    const text = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    if (!text || text.payload.type !== "message" || text.payload.message.role !== "toolResult") assert.fail("missing tool result");
    assert.equal(messageText(text.payload.message), "interrupted before settlement");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a checkpoint accepted during the call is durable, and a late update cannot rewrite it", async () => {
  const storage = new MemoryStorage();
  let saved: ((partial: string, options?: { checkpoint?: boolean }) => void) | undefined;
  const { lane } = harness(storage, async (_args, context) => {
    saved = context.onUpdate;
    context.onUpdate?.("kept", { checkpoint: true });
    return { content: [{ type: "text", text: "done" }] };
  });
  const result = await lane.prompt("go");
  assert.equal(result.status, "completed");
  const text = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
  if (!text || text.payload.type !== "message" || text.payload.message.role !== "toolResult") assert.fail("missing tool result");
  assert.equal(messageText(text.payload.message), "done");
  saved?.("late", { checkpoint: true });
  await storage.whenIdle();
  const late = await storage.read((view) => view.values().some((item) => item.value === "late"));
  assert.equal(late, false);
});
