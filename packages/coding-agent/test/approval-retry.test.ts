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
    },
  };
}

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
