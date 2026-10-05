import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { AgentHarness, value, type AgentLane, type ApprovalRequest, type HarnessTool, type Write } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";

function workTool(name: string, runs: { n: number }): HarnessTool {
  return {
    name,
    description: name,
    parameters: { type: "object", additionalProperties: true },
    execute: async () => {
      runs.n += 1;
      return { content: [{ type: "text", text: name }] };
    },
  };
}

function openLane(
  storage: MemoryStorage,
  runs: { n: number },
  requiresApproval?: (call: ApprovalRequest) => boolean | Promise<boolean>,
  respond = (_context: unknown, _options: unknown, state: { callCount: number }) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("work", { path: "a" }, "call-1")])
    : fauxAssistant("after"),
) {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [workTool("work", runs)],
    ...(requiresApproval ? { requiresApproval } : {}),
  });
  return { provider, harness, lane: harness.lane() };
}

async function toolResult(lane: AgentLane) {
  for (const entry of await lane.entries()) {
    if (entry.payload.type !== "message") continue;
    const message = entry.payload.message;
    if (message.role === "toolResult") return message;
  }
  return undefined;
}

test("without requiresApproval a tool call runs and the model continues", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.equal(provider.state.callCount, 2);
    assert.equal(runs.n, 1);
    const pending = await lane.pendingApprovals();
    assert.deepEqual(pending.items, []);
    const snap = await lane.snapshot();
    assert.equal(pending.version, snap.version);
  } finally {
    harness.close();
  }
});

test("a predicate that returns false does not park the call", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, () => false);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.equal(provider.state.callCount, 2);
    assert.equal(runs.n, 1);
    assert.deepEqual((await lane.pendingApprovals()).items, []);
  } finally {
    harness.close();
  }
});

test("a tool call that requires approval waits without another model request", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, async (call) => call.name === "work");
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind, "waiting");
    assert.equal(provider.state.callCount, 1);
    assert.equal(runs.n, 0);
    const state = await harness.storage.read((view) => view.get<{
      phase: string;
      calls: Array<{ toolCallId: string; name: string; status: string; approval?: { arguments: unknown; requestedAt: number; decision?: string } }>;
    }>(value("pi.op.state", admitted.value.operationId)));
    assert.equal(state?.phase, "tools");
    assert.equal(state?.calls[0]?.status, "planned");
    assert.equal(state?.calls[0]?.toolCallId, "call-1");
    assert.equal(state?.calls[0]?.name, "work");
    assert.deepEqual(state?.calls[0]?.approval?.arguments, { path: "a" });
    assert.equal(state?.calls[0]?.approval?.decision, undefined);
    assert.equal(typeof state?.calls[0]?.approval?.requestedAt, "number");
    const info = await lane.inspect();
    assert.equal(info.phase, "tools");
  } finally {
    harness.close();
  }
});

test("pendingApprovals is plain data and matches snapshot version", async () => {
  const runs = { n: 0 };
  const { harness, lane } = openLane(new MemoryStorage(), runs, async () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    const pending = await lane.pendingApprovals();
    const snap = await lane.snapshot();
    assert.equal(pending.version, snap.version);
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0]?.toolCallId, "call-1");
    assert.equal(pending.items[0]?.name, "work");
    assert.deepEqual(pending.items[0]?.arguments, { path: "a" });
    assert.equal(typeof pending.items[0]?.requestedAt, "number");
    assert.deepEqual(structuredClone(pending), pending);
    assert.deepEqual(JSON.parse(JSON.stringify(pending)), pending);
    const args = pending.items[0]?.arguments as { path: string };
    args.path = "mutated";
    assert.deepEqual((await lane.pendingApprovals()).items[0]?.arguments, { path: "a" });
    assert.deepEqual(snap.tools, [{ toolCallId: "call-1", name: "work", status: "planned" }]);
  } finally {
    harness.close();
  }
});

test("reopening the JSONL keeps the approval waiting, then allow runs the tool once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-approval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const runs = { n: 0 };
  const seen = { n: 0 };
  const gate = async (call: { name: string }) => call.name === "work";
  const respond = () => {
    seen.n += 1;
    return seen.n === 1 ? fauxAssistant([fauxToolCall("work", { path: "a" }, "call-1")]) : fauxAssistant("after");
  };
  const firstStorage = new JsonlStorage(file);
  const first = openLane(firstStorage, runs, gate, respond);
  const admitted = await first.lane.accept({ kind: "prompt", text: "go" });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const operationId = admitted.value.operationId;
  const waiting = await first.lane.drive(operationId);
  assert.equal(waiting.ok && waiting.value.kind, "waiting");
  assert.equal(first.provider.state.callCount, 1);
  const parked = await first.lane.pendingApprovals();
  const ids = (await first.lane.entries()).map((entry) => entry.id);
  await first.harness.close();
  await firstStorage.close();

  const secondStorage = new JsonlStorage(file);
  const second = openLane(secondStorage, runs, undefined, respond);
  try {
    const again = await second.lane.drive(operationId);
    assert.equal(again.ok && again.value.kind, "waiting");
    assert.equal(second.provider.state.callCount, 0);
    assert.equal(runs.n, 0);
    const pending = await second.lane.pendingApprovals();
    assert.deepEqual(pending.items, parked.items);
    assert.deepEqual((await second.lane.entries()).map((entry) => entry.id), ids);
    await second.lane.approve("call-1", "allow");
    assert.equal(runs.n, 1);
    assert.equal(second.provider.state.callCount, 1);
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
    const result = await toolResult(second.lane);
    assert.ok(result);
    assert.equal(result.isError, false);
    assert.equal(messageText(result), "work");
    const after = (await second.lane.entries()).map((entry) => entry.id);
    for (const id of ids) assert.equal(after.filter((item) => item === id).length, 1);
    const settled = await second.lane.drive(operationId);
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
    assert.equal(runs.n, 1);
    assert.equal(second.provider.state.callCount, 1);
  } finally {
    second.harness.close();
    await secondStorage.close();
  }
});

test("deny records an error result with the reason and the model continues", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, async () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    await lane.approve("call-1", "deny", "not now");
    assert.equal(runs.n, 0);
    assert.equal(provider.state.callCount, 2);
    const result = await toolResult(lane);
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(messageText(result), "not now");
    assert.ok(JSON.stringify(provider.state.contexts[1]).includes("not now"));
    assert.deepEqual((await lane.pendingApprovals()).items, []);
  } finally {
    harness.close();
  }
});

test("deny without a reason uses the default error message", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    await lane.approve("call-1", "deny", "   ");
    assert.equal(runs.n, 0);
    assert.equal(provider.state.callCount, 2);
    const result = await toolResult(lane);
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(messageText(result), "Tool call denied");
  } finally {
    harness.close();
  }
});

test("approving the same tool call twice runs it once", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    await lane.approve("call-1", "allow");
    await lane.approve("call-1", "deny", "too late");
    assert.equal(runs.n, 1);
    assert.equal(provider.state.callCount, 2);
    const results = (await lane.entries()).filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.equal(results.length, 1);
  } finally {
    harness.close();
  }
});

test("approve rejects an unknown tool call id", async () => {
  const runs = { n: 0 };
  const { harness, lane } = openLane(new MemoryStorage(), runs, () => true);
  try {
    await assert.rejects(lane.approve("missing", "allow"), /unknown tool call: missing/);
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    await assert.rejects(lane.approve("other", "deny"), /unknown tool call: other/);
    assert.equal((await lane.pendingApprovals()).items.length, 1);
    assert.equal(runs.n, 0);
  } finally {
    harness.close();
  }
});

test("abort while waiting records the cancelled tool result and clears pending approvals", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const waiting = await lane.drive(admitted.value.operationId);
    assert.equal(waiting.ok && waiting.value.kind, "waiting");
    const aborted = await lane.requestAbort(admitted.value.operationId);
    assert.equal(aborted.ok, true);
    const settled = await lane.drive(admitted.value.operationId);
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "aborted");
    assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.error : "", "cancelled");
    assert.deepEqual((await lane.pendingApprovals()).items, []);
    const result = await toolResult(lane);
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(messageText(result), "cancelled");
    assert.equal(runs.n, 0);
    assert.equal(provider.state.callCount, 1);
    await lane.approve("call-1", "allow");
    assert.equal(runs.n, 0);
    assert.equal(provider.state.callCount, 1);
  } finally {
    harness.close();
  }
});

test("a mixed turn runs the ungated call and waits on the gated one", async () => {
  const freeRuns = { n: 0 };
  const gatedRuns = { n: 0 };
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([
        fauxToolCall("free", { n: 1 }, "free-1"),
        fauxToolCall("gated", { n: 2 }, "gated-1"),
      ])
      : fauxAssistant("after"),
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [workTool("free", freeRuns), workTool("gated", gatedRuns)],
    requiresApproval: (call) => call.name === "gated",
  });
  const lane = harness.lane();
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const waiting = await lane.drive(admitted.value.operationId);
    assert.equal(waiting.ok && waiting.value.kind, "waiting");
    assert.equal(provider.state.callCount, 1);
    assert.equal(freeRuns.n, 1);
    assert.equal(gatedRuns.n, 0);
    const pending = await lane.pendingApprovals();
    assert.deepEqual(pending.items.map((item) => item.toolCallId), ["gated-1"]);
    assert.deepEqual(pending.items[0]?.arguments, { n: 2 });
    const free = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(free?.payload.type === "message" && free.payload.message.role === "toolResult");
    assert.equal(messageText(free.payload.message), "free");
    await lane.approve("gated-1", "allow");
    assert.equal(freeRuns.n, 1);
    assert.equal(gatedRuns.n, 1);
    assert.equal(provider.state.callCount, 2);
    assert.deepEqual((await lane.pendingApprovals()).items, []);
  } finally {
    harness.close();
  }
});

class AllowCommitFault extends MemoryStorage {
  failed = false;

  protected override persist(writes: readonly Write[]): void {
    const arming = writes.some((write) => {
      if (write.type !== "set" || write.address.namespace !== "pi.op.state") return false;
      const state = write.value as { calls?: Array<{ status?: string; approval?: { decision?: string } }> };
      return state.calls?.some((call) => call.status === "effect_pending" && call.approval?.decision === "allow") === true;
    });
    if (!this.failed && arming) {
      this.failed = true;
      throw new Error("effect commit failed");
    }
  }
}

test("a crash after an allow decision still runs the tool once", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new AllowCommitFault(), runs, () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    await assert.rejects(lane.approve("call-1", "allow"), /effect commit failed/);
    assert.equal(runs.n, 0);
    assert.equal(provider.state.callCount, 1);
    const recovered = await lane.drive(admitted.value.operationId);
    assert.equal(recovered.ok && recovered.value.kind === "settled" ? recovered.value.result.status : "", "completed");
    assert.equal(runs.n, 1);
    assert.equal(provider.state.callCount, 2);
    await lane.approve("call-1", "allow");
    assert.equal(runs.n, 1);
  } finally {
    harness.close();
  }
});

class DenyResultFault extends MemoryStorage {
  failed = false;

  protected override persist(writes: readonly Write[]): void {
    const result = writes.some((write) => write.type === "set" && write.address.namespace === "pi.pending.entry");
    if (!this.failed && result) {
      this.failed = true;
      throw new Error("deny result failed");
    }
  }
}

test("a crash after a deny decision still records the error once", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new DenyResultFault(), runs, () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await lane.drive(admitted.value.operationId);
    await assert.rejects(lane.approve("call-1", "deny", "not now"), /deny result failed/);
    assert.equal(runs.n, 0);
    const recovered = await lane.drive(admitted.value.operationId);
    assert.equal(recovered.ok && recovered.value.kind === "settled" ? recovered.value.result.status : "", "completed");
    assert.equal(runs.n, 0);
    assert.equal(provider.state.callCount, 2);
    const results = (await lane.entries()).filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.equal(results.length, 1);
    const result = results[0];
    assert.ok(result?.payload.type === "message" && result.payload.message.role === "toolResult");
    assert.equal(result.payload.message.isError, true);
    assert.equal(messageText(result.payload.message), "not now");
  } finally {
    harness.close();
  }
});

function openSequential(
  gate: (name: string) => boolean,
  asked: string[],
  hooked: string[],
  firstRuns: { n: number },
  secondRuns: { n: number },
) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([
        fauxToolCall("first", { n: 1 }, "first-1"),
        fauxToolCall("second", { n: 2 }, "second-1"),
      ])
      : fauxAssistant("after"),
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    toolExecution: "sequential",
    tools: [workTool("first", firstRuns), workTool("second", secondRuns)],
    hooks: [{
      beforeToolCall: (input) => {
        hooked.push(input.toolName);
        return undefined;
      },
    }],
    requiresApproval: (call) => {
      asked.push(call.name);
      return gate(call.name);
    },
  });
  return { provider, harness, lane: harness.lane() };
}

test("sequential execution leaves the later call untouched until the parked call is allowed", async () => {
  const asked: string[] = [];
  const hooked: string[] = [];
  const firstRuns = { n: 0 };
  const secondRuns = { n: 0 };
  const ungated = openSequential((name) => name === "first", asked, hooked, firstRuns, secondRuns);
  try {
    const admitted = await ungated.lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const waiting = await ungated.lane.drive(admitted.value.operationId);
    assert.equal(waiting.ok && waiting.value.kind, "waiting");
    assert.equal(ungated.provider.state.callCount, 1);
    assert.deepEqual(asked, ["first"]);
    assert.deepEqual(hooked, []);
    assert.equal(firstRuns.n, 0);
    assert.equal(secondRuns.n, 0);
    const parked = await ungated.harness.storage.read((view) => view.get<{
      calls: Array<{ name: string; status: string; approval?: { decision?: string } }>;
    }>(value("pi.op.state", admitted.value.operationId)));
    assert.equal(parked?.calls[0]?.name, "first");
    assert.equal(parked?.calls[0]?.approval?.decision, undefined);
    assert.equal(parked?.calls[1]?.name, "second");
    assert.equal(parked?.calls[1]?.status, "planned");
    assert.equal(parked?.calls[1]?.approval, undefined);
    await ungated.lane.approve("first-1", "allow");
    assert.equal(firstRuns.n, 1);
    assert.equal(secondRuns.n, 1);
    assert.equal(ungated.provider.state.callCount, 2);
    assert.deepEqual(asked, ["first", "second"]);
    assert.deepEqual(hooked, ["first", "second"]);
    assert.deepEqual((await ungated.lane.pendingApprovals()).items, []);
  } finally {
    ungated.harness.close();
  }

  const gatedAsked: string[] = [];
  const gatedHooked: string[] = [];
  const gatedFirst = { n: 0 };
  const gatedSecond = { n: 0 };
  const gated = openSequential(() => true, gatedAsked, gatedHooked, gatedFirst, gatedSecond);
  try {
    const admitted = await gated.lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const waiting = await gated.lane.drive(admitted.value.operationId);
    assert.equal(waiting.ok && waiting.value.kind, "waiting");
    assert.deepEqual(gatedAsked, ["first"]);
    assert.deepEqual(gatedHooked, []);
    assert.equal(gatedSecond.n, 0);
    await gated.lane.approve("first-1", "allow");
    assert.equal(gatedFirst.n, 1);
    assert.equal(gatedSecond.n, 0);
    assert.equal(gated.provider.state.callCount, 1);
    assert.deepEqual(gatedAsked, ["first", "second"]);
    assert.deepEqual(gatedHooked, ["first"]);
    const pending = await gated.lane.pendingApprovals();
    assert.deepEqual(pending.items.map((item) => item.toolCallId), ["second-1"]);
    const still = await gated.lane.drive(admitted.value.operationId);
    assert.equal(still.ok && still.value.kind, "waiting");
    assert.equal(gatedSecond.n, 0);
    assert.equal(gated.provider.state.callCount, 1);
    await gated.lane.approve("second-1", "allow");
    assert.equal(gatedSecond.n, 1);
    assert.equal(gated.provider.state.callCount, 2);
    assert.deepEqual(gatedHooked, ["first", "second"]);
    assert.deepEqual((await gated.lane.pendingApprovals()).items, []);
  } finally {
    gated.harness.close();
  }
});

test("a throwing approval predicate fails the operation and leaves the lane free", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, () => {
    throw new Error("predicate boom");
  });
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.value.kind !== "settled") return;
    assert.equal(outcome.value.result.status, "failed");
    assert.equal(outcome.value.result.error, "predicate boom");
    assert.equal(provider.state.callCount, 1);
    assert.equal(runs.n, 0);
    assert.deepEqual((await lane.pendingApprovals()).items, []);
    const info = await lane.inspect();
    assert.equal(info.phase, null);
    assert.equal(info.operationId, null);
    assert.equal((await lane.entries()).some((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult"), false);
    const next = await lane.accept({ kind: "prompt", text: "again" });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    const continued = await lane.drive(next.value.operationId);
    assert.equal(continued.ok && continued.value.kind === "settled" ? continued.value.result.status : "", "completed");
    assert.equal(provider.state.callCount, 2);
    assert.equal(runs.n, 0);
  } finally {
    harness.close();
  }
});

class PersistCount extends MemoryStorage {
  writes = 0;

  protected override persist(writes: readonly Write[]): void {
    this.writes += writes.length;
  }
}

test("repeated drive while approval is waiting does not persist or call the model", async () => {
  const runs = { n: 0 };
  const storage = new PersistCount();
  const { provider, harness, lane } = openLane(storage, runs, () => true);
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const operationId = admitted.value.operationId;
    const parked = await lane.drive(operationId);
    assert.equal(parked.ok && parked.value.kind, "waiting");
    const pending = await lane.pendingApprovals();
    const requestedAt = pending.items[0]?.requestedAt;
    assert.equal(typeof requestedAt, "number");
    assert.equal(parked.ok && parked.value.kind === "waiting" ? parked.value.notBefore : undefined, requestedAt);
    assert.equal(parked.ok && parked.value.kind === "waiting" ? parked.value.reason : "", "approval");
    const version = (await lane.snapshot()).version;
    const storedVersion = await storage.read((view) => view.version());
    const laneEntries = (await lane.entries()).length;
    const storedEntries = await storage.read((view) => view.entries().length);
    const writes = storage.writes;
    assert.equal(version, storedVersion);
    const again = [await lane.drive(operationId), await lane.drive(operationId), await lane.drive(operationId)];
    assert.deepEqual(again[0], parked);
    assert.deepEqual(again[1], parked);
    assert.deepEqual(again[2], parked);
    assert.equal(provider.state.callCount, 1);
    assert.equal(runs.n, 0);
    assert.equal((await lane.snapshot()).version, version);
    assert.equal(await storage.read((view) => view.version()), storedVersion);
    assert.equal((await lane.entries()).length, laneEntries);
    assert.equal(await storage.read((view) => view.entries().length), storedEntries);
    assert.equal(storage.writes, writes);
    assert.equal((await lane.pendingApprovals()).items[0]?.requestedAt, requestedAt);
  } finally {
    harness.close();
  }
});

test("allowForSession runs the next call of that tool without parking it", async () => {
  const runs = { n: 0 };
  const { provider, harness, lane } = openLane(new MemoryStorage(), runs, () => true, (_context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("work", { path: "a" }, "call-1")]);
    if (state.callCount === 2) return fauxAssistant([fauxToolCall("work", { path: "b" }, "call-2")]);
    return fauxAssistant("after");
  });
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const parked = await lane.drive(admitted.value.operationId);
    assert.equal(parked.ok && parked.value.kind === "waiting" ? parked.value.reason : "", "approval");
    lane.allowForSession("work");
    await lane.approve("call-1", "allow");
    assert.equal(runs.n, 2);
    assert.equal(provider.state.callCount, 3);
    assert.deepEqual((await lane.pendingApprovals()).items, []);
  } finally {
    harness.close();
  }
});
