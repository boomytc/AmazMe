import assert from "node:assert/strict";
import test from "node:test";
import { AgentHarness, type HarnessTool, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";

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

test("a parallel checkpoint failure does not release the drive while a sibling tool is active", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let siblingStarted = false;
  let settled = false;
  const models = createModels();
  models.setProvider(fauxProvider({ respond: (_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("failed", {}), fauxToolCall("sibling", {})]) : fauxAssistant("done") }));
  const runtime = new AgentHarness(new CheckpointFaultStorage(), {
    models, model: { provider: "faux", modelId: "faux-1" }, tools: [
      { name: "failed", description: "failed", parameters: { type: "object" }, execute: async (_args, context) => {
        context.onUpdate?.("partial", { checkpoint: true }); return { content: [] };
      } },
      { name: "sibling", description: "sibling", parameters: { type: "object" }, execute: async () => {
        siblingStarted = true; await blocked; return { content: [] };
      } },
    ],
  });
  const lane = runtime.lane();
  const admission = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admission.ok);
  const pending = lane.drive(admission.value.operationId).then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(siblingStarted, true);
    assert.equal(settled, false);
  } finally {
    release();
  }
  assert.match(String(await pending), /checkpoint failed/);
  const recovered = await lane.drive(admission.value.operationId);
  assert.ok(recovered.ok && recovered.value.kind === "settled");
  runtime.close();
});

test("a cancelled persisted safe tool is not replayed by a reopened harness", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started = () => {};
  const armed = new Promise<void>((resolve) => { started = resolve; });
  let executions = 0;
  const storage = new MemoryStorage();
  const models = createModels();
  const provider = fauxProvider({ respond: () => fauxAssistant([fauxToolCall("safe", {})]) });
  models.setProvider(provider);
  const options = {
    models, model: { provider: "faux", modelId: "faux-1" }, tools: [{
      name: "safe", description: "safe", parameters: { type: "object" as const }, replay: "safe" as const,
      execute: async (_args: unknown, context: Parameters<HarnessTool["execute"]>[1]) => {
        executions++; context.onUpdate?.("checkpoint", { checkpoint: true }); started(); await blocked; return { content: [] };
      },
    }],
  };
  const first = new AgentHarness(storage, options);
  const lane = first.lane();
  const admission = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admission.ok);
  const pending = lane.drive(admission.value.operationId);
  await armed;
  await storage.whenIdle();
  first.abandon();
  await lane.requestAbort(admission.value.operationId);
  release();
  await pending;
  const reopened = new AgentHarness(storage, options);
  try {
    const result = await reopened.lane().drive(admission.value.operationId);
    assert.ok(result.ok && result.value.kind === "settled");
    assert.equal(result.value.result.status, "aborted");
    assert.equal(executions, 1);
    assert.equal(provider.state.callCount, 1);
    assert.equal(await storage.read((view) => view.values().some((item) =>
      item.key.includes("pi.pending.tool_output") || item.key.includes("pi.op.tool_args"))), false);
  } finally {
    first.close();
    reopened.close();
  }
});
