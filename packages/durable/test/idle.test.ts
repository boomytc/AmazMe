import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";
import { AgentHarness, type StorageView } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

class HoldRead extends MemoryStorage {
  entered?: () => void;
  gate?: Promise<void>;

  override read<T>(fn: (view: StorageView) => T): Promise<T> {
    const entered = this.entered;
    const gate = this.gate;
    this.entered = undefined;
    this.gate = undefined;
    return super.run(async (view) => {
      entered?.();
      if (gate) await gate;
      return fn(view);
    });
  }
}

function harness(storage: MemoryStorage = new MemoryStorage()): AgentHarness {
  const models = createModels();
  models.setProvider(fauxProvider());
  return new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" } });
}

test("idle follows admitted storage work and a drive, and a settled retry wait is idle", async () => {
  const storage = new HoldRead();
  const runtime = harness(storage);
  assert.equal(runtime.idle(), true);
  const seen: boolean[] = [];
  let threw = false;
  const stop = runtime.watchIdle(() => {
    if (!threw) {
      threw = true;
      throw new Error("listener failed");
    }
    seen.push(runtime.idle());
  });

  let entered = false;
  let releaseRead!: () => void;
  storage.entered = () => { entered = true; };
  storage.gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const reading = runtime.lane().snapshot();
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.idle(), false);
  releaseRead();
  await reading;
  assert.equal(runtime.idle(), true);

  let releaseDrive!: (value: Awaited<ReturnType<AgentHarness["claimDrive"]>>) => void;
  const drive = runtime.claimDrive("main", "op", () => new Promise((resolve) => { releaseDrive = resolve; }));
  assert.equal(runtime.idle(), false);
  releaseDrive({ ok: true, value: { kind: "waiting", operationId: "op", reason: "retry", notBefore: 1 } });
  assert.equal((await drive).ok, true);
  assert.equal(runtime.idle(), true, "a persisted retry wait has no running drive");
  assert.deepEqual(seen, [true, false, true]);
  let releaseNext!: () => void;
  const next = runtime.claimDrive("main", "held", () => new Promise((resolve) => {
    releaseNext = () => resolve({ ok: true, value: { kind: "waiting", operationId: "held", reason: "retry", notBefore: 1 } });
  }));
  assert.equal(runtime.idle(), false, "the settled drive left the map, so the next one is tracked");
  assert.equal(seen.at(-1), false);
  releaseNext();
  await next;
  assert.equal(runtime.idle(), true);
  stop();
  const after = seen.length;
  await runtime.claimDrive("main", "next", async () => ({ ok: true, value: { kind: "waiting", operationId: "next", reason: "retry", notBefore: 1 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, after, "an unsubscribed listener receives nothing");
  assert.equal(runtime.idle(), true);

  await assert.rejects(
    runtime.claimDrive("main", "boom", () => {
      throw new Error("start failed");
    }),
    (error: unknown) => error instanceof Error && error.message === "start failed",
  );
  assert.equal(runtime.idle(), true, "a start that throws is not left in the drive map");
  const recovered = await runtime.claimDrive("main", "boom", async () => ({
    ok: true,
    value: { kind: "waiting", operationId: "boom", reason: "retry", notBefore: 1 },
  }));
  assert.equal(recovered.ok, true, "the failed start does not block the same lane and operation");
});
