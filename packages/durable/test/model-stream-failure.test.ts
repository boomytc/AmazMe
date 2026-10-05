import assert from "node:assert/strict";
import test from "node:test";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/testing";
import { AgentHarness, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

class EffectFailureStorage extends MemoryStorage {
  fail?: (writes: readonly Write[]) => boolean;
  protected override persist(writes: readonly Write[]): void {
    if (!this.fail?.(writes)) return;
    this.fail = undefined;
    throw new Error("effect storage failure");
  }
}

for (const effect of ["frame", "assistant", "summary"] as const) {
  test(`${effect} persistence failure recovers on the same harness without another model call`, async () => {
    const storage = new EffectFailureStorage();
    const provider = fauxProvider({ respond: () => fauxAssistant("received content across several frames") });
    const models = createModels();
    models.setProvider(provider);
    const runtime = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" } });
    try {
      const lane = runtime.lane();
      if (effect === "summary") await lane.prompt("seed goal");
      const admitted = await lane.accept(effect === "summary" ? { kind: "compaction" } : { kind: "prompt", text: "go" });
      assert.ok(admitted.ok);
      storage.fail = writes => writes.some(write => effect === "frame" ? write.type === "append"
        : write.type === "entry" && (effect === "summary" ? write.payload.type === "compaction"
          : write.payload.type === "message" && write.payload.message.role === "assistant"));
      await assert.rejects(lane.drive(admitted.value.operationId), /effect storage failure/);
      const calls = provider.state.callCount;
      assert.equal(runtime.live.size, 0);
      const outcome = await lane.drive(admitted.value.operationId);
      assert.ok(outcome.ok && outcome.value.kind === "settled");
      assert.equal(outcome.value.result.status, "aborted");
      assert.equal(provider.state.callCount, calls);
      assert.equal((await lane.inspect()).phase, null);
      if (effect === "frame") {
        const recovered = (await lane.entries()).at(-1);
        assert.ok(recovered?.payload.type === "message" && recovered.payload.message.role === "assistant");
        // The failed first delta is absent; later accepted deltas drained before drive rejected.
        assert.equal(messageText(recovered.payload.message), "received content across several frames".slice(8));
      }
    } finally {
      runtime.close();
    }
  });
}
