import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { AgentHarness, type ApprovalRequest, type HarnessTool } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { installHostRetries, scheduleHostRetry, type HostRetryWait, type RetryClock } from "../src/contracts.ts";

function workTool(runs: { n: number }): HarnessTool {
  return {
    name: "work",
    description: "work",
    parameters: { type: "object", additionalProperties: true },
    execute: async () => {
      runs.n += 1;
      return { content: [{ type: "text", text: "work" }] };
    },
  };
}

function recordingClock(now: number): RetryClock & { delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    now: () => now,
    schedule(delayMs) {
      delays.push(delayMs);
      return () => undefined;
    },
  };
}

function cancellableClock(): RetryClock & { live: () => number; fire: () => void } {
  const runs = new Set<() => void>();
  return {
    live: () => runs.size,
    now: () => 0,
    schedule(_delayMs, run) {
      runs.add(run);
      return () => {
        runs.delete(run);
      };
    },
    fire() {
      for (const run of [...runs]) run();
    },
  };
}

test("scheduling the same operation twice keeps the later timer", async () => {
  const lane = { pendingApprovals: () => Promise.resolve({ items: [] as unknown[] }) };
  const clock = cancellableClock();
  const fired: string[] = [];
  const first: HostRetryWait = { operationId: "op", reason: "retry", notBefore: 1_000 };
  const second: HostRetryWait = { operationId: "op", reason: "retry", notBefore: 2_000 };
  assert.equal(await scheduleHostRetry(lane, first, clock, () => fired.push("first")), true);
  assert.equal(await scheduleHostRetry(lane, second, clock, () => fired.push("second")), true);
  assert.equal(clock.live(), 1);
  const other: HostRetryWait = { operationId: "other", reason: "retry", notBefore: 1_000 };
  assert.equal(await scheduleHostRetry(lane, other, clock, () => fired.push("other")), true);
  const elsewhere = { pendingApprovals: () => Promise.resolve({ items: [] as unknown[] }) };
  assert.equal(await scheduleHostRetry(elsewhere, first, clock, () => fired.push("elsewhere")), true);
  assert.equal(clock.live(), 3);
  clock.fire();
  assert.deepEqual(fired, ["second", "other", "elsewhere"]);
});

test("an approval block cancels the timer already armed for that operation", async () => {
  const items: unknown[] = [];
  const lane = { pendingApprovals: () => Promise.resolve({ items }) };
  const clock = cancellableClock();
  const waiting: HostRetryWait = { operationId: "op", reason: "retry", notBefore: 1_000 };
  assert.equal(await scheduleHostRetry(lane, waiting, clock, () => undefined), true);
  assert.equal(clock.live(), 1);
  items.push({ toolCallId: "call-1" });
  assert.equal(await scheduleHostRetry(lane, waiting, clock, () => undefined), false);
  assert.equal(clock.live(), 0);
});

test("pending approvals block a due retry, and clearing them arms it again", async () => {
  const items: unknown[] = [{ toolCallId: "call-1" }];
  const lane = {
    pendingApprovals: () => Promise.resolve({ items }),
  };
  const waiting: HostRetryWait = { operationId: "op", reason: "retry", notBefore: 1_000 };
  const clock = recordingClock(5_000);
  const armed = await scheduleHostRetry(lane, waiting, clock, () => undefined);
  assert.equal(armed, false);
  assert.deepEqual(clock.delays, []);

  items.splice(0, items.length);
  const resumed = await scheduleHostRetry(lane, waiting, clock, () => undefined);
  assert.equal(resumed, true);
  assert.deepEqual(clock.delays, [0]);
});

test("a parked tool does not arm a host retry, and the next model retry does", async () => {
  const runs = { n: 0 };
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("work", { path: "a" }, "call-1")]);
      if (state.callCount === 2) return fauxAssistant("later", { stopReason: "error", retryable: true, errorMessage: "later" });
      return fauxAssistant("after");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [workTool(runs)],
    requiresApproval: (_call: ApprovalRequest) => true,
  });
  const clock = recordingClock(Date.now());
  installHostRetries(harness, clock);
  const lane = harness.lane();
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const parked = await lane.drive(admitted.value.operationId);
    assert.equal(parked.ok && parked.value.kind === "waiting" ? parked.value.reason : "", "approval");
    assert.equal((await lane.pendingApprovals()).items.length, 1);
    assert.equal(runs.n, 0);
    assert.deepEqual(clock.delays, []);

    await lane.approve("call-1", "allow");
    assert.equal((await lane.pendingApprovals()).items.length, 0);
    assert.equal(runs.n, 1);
    assert.equal(clock.delays.length, 1);
    assert.ok((clock.delays[0] ?? 0) > 0);
  } finally {
    harness.close();
  }
});
