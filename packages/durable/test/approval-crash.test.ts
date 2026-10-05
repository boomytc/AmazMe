import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { AgentHarness, value, type AgentLane, type HarnessTool, type Write } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";

const INTERRUPTED_TOOL_EFFECT =
  "interrupted before settlement; the tool may already have executed and the result is unknown";

type CrashPoint = "after-allow" | "after-effect" | "after-deny";

/**
 * Approval commit and tool-result commit have no production pause.
 * The targeted record is appended, then the next commit that would arm the effect or store its result is refused.
 */
class CrashJsonl extends JsonlStorage {
  crashed = false;
  private armed = false;

  constructor(file: string, private readonly point: CrashPoint) {
    super(file);
  }

  protected override persist(writes: readonly Write[]): void {
    const hit = this.armed && (
      (this.point === "after-allow" && hasEffectPending(writes))
      || (this.point !== "after-allow" && hasToolResult(writes))
    );
    if (hit) {
      this.crashed = true;
      throw new Error("crash before the next commit");
    }
    super.persist(writes);
    if (this.point === "after-allow" && hasPlannedDecision(writes, "allow")) this.armed = true;
    if (this.point === "after-effect" && hasEffectPending(writes)) this.armed = true;
    if (this.point === "after-deny" && hasPlannedDecision(writes, "deny")) this.armed = true;
  }
}

interface PersistedCall {
  status?: string;
  replay?: string;
  approval?: { decision?: string };
}

function hasPlannedDecision(writes: readonly Write[], decision: "allow" | "deny"): boolean {
  return writes.some((write) => {
    if (write.type !== "set" || write.address.namespace !== "pi.op.state") return false;
    return callsOf(write.value)?.some((call) => call.status === "planned" && call.approval?.decision === decision) === true;
  });
}

function hasEffectPending(writes: readonly Write[]): boolean {
  return writes.some((write) => {
    if (write.type !== "set" || write.address.namespace !== "pi.op.state") return false;
    return callsOf(write.value)?.some((call) => call.status === "effect_pending") === true;
  });
}

function hasToolResult(writes: readonly Write[]): boolean {
  return writes.some((write) => {
    if (write.type === "entry") return write.payload.type === "message" && write.payload.message.role === "toolResult";
    if (write.type !== "set") return false;
    const value = write.value;
    if (typeof value !== "object" || value === null || !("message" in value)) return false;
    const message = value.message;
    return typeof message === "object" && message !== null && "role" in message && message.role === "toolResult";
  });
}

function callsOf(value: unknown): PersistedCall[] | undefined {
  if (typeof value !== "object" || value === null || !("phase" in value) || !("calls" in value)) return undefined;
  if (value.phase !== "tools" || !Array.isArray(value.calls)) return undefined;
  return value.calls as PersistedCall[];
}

function logWrites(file: string): Write[][] {
  const batches: Write[][] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as { writes?: Write[] };
    batches.push(record.writes ?? []);
  }
  return batches;
}

function lastCall(file: string): PersistedCall | undefined {
  let call: PersistedCall | undefined;
  for (const writes of logWrites(file)) {
    for (const write of writes) {
      if (write.type !== "set" || write.address.namespace !== "pi.op.state") continue;
      const next = callsOf(write.value)?.[0];
      if (next) call = next;
    }
  }
  return call;
}

function logHasCallStatus(file: string, status: string): boolean {
  for (const writes of logWrites(file)) {
    for (const write of writes) {
      if (write.type !== "set" || write.address.namespace !== "pi.op.state") continue;
      if (callsOf(write.value)?.some((call) => call.status === status)) return true;
    }
  }
  return false;
}

function logHasToolResult(file: string): boolean {
  return logWrites(file).some((writes) => hasToolResult(writes));
}

function logHasNamespace(file: string, namespace: string): boolean {
  return logWrites(file).some((writes) => writes.some((write) =>
    write.type !== "entry" && write.type !== "usage" && write.address.namespace === namespace));
}

function workTool(runs: { n: number }): HarnessTool {
  return {
    name: "work",
    description: "work",
    parameters: { type: "object", additionalProperties: true },
    replay: "never",
    execute: async () => {
      runs.n += 1;
      return { content: [{ type: "text", text: "executed-once" }] };
    },
  };
}

function openHarness(storage: JsonlStorage, runs: { n: number }, seen: { n: number }) {
  const provider = fauxProvider({
    respond: () => {
      seen.n += 1;
      return seen.n === 1
        ? fauxAssistant([fauxToolCall("work", { path: "a" }, "call-1")])
        : fauxAssistant("after");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const harness = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [workTool(runs)],
    requiresApproval: () => true,
  });
  return { provider, harness, lane: harness.lane() };
}

async function park(lane: AgentLane): Promise<string> {
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) throw new Error("prompt was not admitted");
  const waiting = await lane.drive(admitted.value.operationId);
  assert.equal(waiting.ok && waiting.value.kind, "waiting");
  assert.deepEqual((await lane.pendingApprovals()).items.map((item) => item.toolCallId), ["call-1"]);
  return admitted.value.operationId;
}

async function branchToolResult(lane: AgentLane) {
  for (const entry of await lane.entries()) {
    if (entry.payload.type !== "message" || entry.payload.message.role !== "toolResult") continue;
    return entry.payload.message;
  }
  throw new Error("missing tool result");
}

function modelSaw(provider: ReturnType<typeof fauxProvider>, text: string, isError: boolean): boolean {
  const messages = provider.state.contexts.at(-1)?.messages ?? [];
  return messages.some((message) => message.role === "toolResult" && message.isError === isError && messageText(message) === text);
}

async function assertTurnFinished(harness: AgentHarness, lane: AgentLane, operationId: string): Promise<void> {
  const settled = await lane.drive(operationId);
  assert.equal(settled.ok && settled.value.kind === "settled" ? settled.value.result.status : "", "completed");
  assert.equal(harness.idle(), true);
  const info = await lane.inspect();
  assert.equal(info.phase, null);
  assert.equal(info.operationId, null);
  const assistants = (await lane.entries()).flatMap((entry) => {
    if (entry.payload.type !== "message" || entry.payload.message.role !== "assistant") return [];
    return [messageText(entry.payload.message)];
  });
  assert.equal(assistants.at(-1), "after");
}

test("reopen after allow is committed and before execute runs the tool once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-approval-allow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const runs = { n: 0 };
  const seen = { n: 0 };
  const firstStorage = new CrashJsonl(file, "after-allow");
  const first = openHarness(firstStorage, runs, seen);
  const operationId = await park(first.lane);
  await assert.rejects(first.lane.approve("call-1", "allow"), /crash before the next commit/);
  assert.equal(firstStorage.crashed, true);
  assert.equal(runs.n, 0);
  assert.equal(first.provider.state.callCount, 1);
  assert.equal(seen.n, 1);
  first.harness.abandon();
  await firstStorage.whenIdle();
  await firstStorage.close();

  const onDisk = lastCall(file);
  assert.equal(onDisk?.status, "planned");
  assert.equal(onDisk?.approval?.decision, "allow");
  assert.equal(logHasCallStatus(file, "effect_pending"), false);
  assert.equal(logHasNamespace(file, "pi.op.tool_args"), false);
  assert.equal(logHasToolResult(file), false);
  assert.equal(readFileSync(file, "utf8").includes("executed-once"), false);

  const secondStorage = new JsonlStorage(file);
  const second = openHarness(secondStorage, runs, seen);
  try {
    const reloaded = await secondStorage.read((view) => view.get<{
      calls: Array<{ status: string; approval?: { decision?: string } }>;
    }>(value("pi.op.state", operationId)));
    assert.equal(reloaded?.calls[0]?.status, "planned");
    assert.equal(reloaded?.calls[0]?.approval?.decision, "allow");
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
    await assertTurnFinished(second.harness, second.lane, operationId);
    assert.equal(runs.n, 1);
    assert.equal(seen.n, 2);
    assert.equal(first.provider.state.callCount, 1);
    assert.equal(second.provider.state.callCount, 1);
    const result = await branchToolResult(second.lane);
    assert.equal(result.isError, false);
    assert.equal(messageText(result), "executed-once");
    assert.equal(modelSaw(second.provider, "executed-once", false), true);
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
  } finally {
    await second.harness.close();
    await secondStorage.close();
  }
});

test("reopen after execute and before the result commit does not run the tool again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-approval-effect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const runs = { n: 0 };
  const seen = { n: 0 };
  const firstStorage = new CrashJsonl(file, "after-effect");
  const first = openHarness(firstStorage, runs, seen);
  const operationId = await park(first.lane);
  await assert.rejects(first.lane.approve("call-1", "allow"), /crash before the next commit/);
  assert.equal(firstStorage.crashed, true);
  assert.equal(runs.n, 1);
  assert.equal(first.provider.state.callCount, 1);
  first.harness.abandon();
  await firstStorage.whenIdle();
  await firstStorage.close();

  const onDisk = lastCall(file);
  assert.equal(onDisk?.status, "effect_pending");
  assert.equal(onDisk?.replay, "never");
  assert.equal(onDisk?.approval?.decision, "allow");
  assert.equal(logHasNamespace(file, "pi.op.tool_args"), true);
  assert.equal(logHasToolResult(file), false);
  assert.equal(readFileSync(file, "utf8").includes("executed-once"), false);

  const secondStorage = new JsonlStorage(file);
  const second = openHarness(secondStorage, runs, seen);
  try {
    const reloaded = await secondStorage.read((view) => view.get<{
      calls: Array<{ status: string; approval?: { decision?: string } }>;
    }>(value("pi.op.state", operationId)));
    assert.equal(reloaded?.calls[0]?.status, "effect_pending");
    assert.equal(reloaded?.calls[0]?.approval?.decision, "allow");
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
    await assertTurnFinished(second.harness, second.lane, operationId);
    assert.equal(runs.n, 1);
    assert.equal(seen.n, 2);
    assert.equal(second.provider.state.callCount, 1);
    const result = await branchToolResult(second.lane);
    assert.equal(result.isError, true);
    assert.equal(messageText(result), INTERRUPTED_TOOL_EFFECT);
    assert.equal(modelSaw(second.provider, INTERRUPTED_TOOL_EFFECT, true), true);
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
  } finally {
    await second.harness.close();
    await secondStorage.close();
  }
});

test("reopen after deny is committed does not run the tool and the model receives the denial", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-approval-deny-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const runs = { n: 0 };
  const seen = { n: 0 };
  const firstStorage = new CrashJsonl(file, "after-deny");
  const first = openHarness(firstStorage, runs, seen);
  const operationId = await park(first.lane);
  await assert.rejects(first.lane.approve("call-1", "deny", "not now"), /crash before the next commit/);
  assert.equal(firstStorage.crashed, true);
  assert.equal(runs.n, 0);
  assert.equal(first.provider.state.callCount, 1);
  assert.equal(seen.n, 1);
  first.harness.abandon();
  await firstStorage.whenIdle();
  await firstStorage.close();

  const onDisk = lastCall(file);
  assert.equal(onDisk?.status, "planned");
  assert.equal(onDisk?.approval?.decision, "deny");
  assert.equal(logHasToolResult(file), false);
  assert.equal(readFileSync(file, "utf8").includes("executed-once"), false);

  const secondStorage = new JsonlStorage(file);
  const second = openHarness(secondStorage, runs, seen);
  try {
    const reloaded = await secondStorage.read((view) => view.get<{
      calls: Array<{ status: string; approval?: { decision?: string; reason?: string } }>;
    }>(value("pi.op.state", operationId)));
    assert.equal(reloaded?.calls[0]?.status, "planned");
    assert.equal(reloaded?.calls[0]?.approval?.decision, "deny");
    assert.equal(reloaded?.calls[0]?.approval?.reason, "not now");
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
    await assertTurnFinished(second.harness, second.lane, operationId);
    assert.equal(runs.n, 0);
    assert.equal(seen.n, 2);
    assert.equal(first.provider.state.callCount, 1);
    assert.equal(second.provider.state.callCount, 1);
    const result = await branchToolResult(second.lane);
    assert.equal(result.isError, true);
    assert.equal(messageText(result), "not now");
    assert.equal(modelSaw(second.provider, "not now", true), true);
    assert.deepEqual((await second.lane.pendingApprovals()).items, []);
  } finally {
    await second.harness.close();
    await secondStorage.close();
  }
});
