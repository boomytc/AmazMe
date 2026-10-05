import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentHarness, type HarnessTool, type OperationRequest, type Write, value } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { validSummary } from "./valid-summary.ts";

type Fault = "before" | "after" | "torn";
type Message = ReturnType<typeof fauxAssistant>;

class FaultStorage extends JsonlStorage {
  fault?: { timing: Fault; matches: (writes: Write[]) => boolean };
  injected = false;

  constructor(readonly logFile: string) {
    super(logFile);
  }

  protected override persist(writes: Write[]): void {
    if (!this.fault || this.injected || !this.fault.matches(writes)) {
      super.persist(writes);
      return;
    }
    this.injected = true;
    if (this.fault.timing === "after") super.persist(writes);
    if (this.fault.timing === "torn") {
      const line = JSON.stringify({ writes });
      appendFileSync(this.logFile, line.slice(0, Math.floor(line.length / 2)));
    }
    throw new Error("injected settlement crash");
  }
}

function answer(text: string, options: Parameters<typeof fauxAssistant>[1] = {}): Message {
  return fauxAssistant(text, {
    usage: { input: 3, output: 2, totalTokens: 5, cost: { input: 0, output: 0, total: 0 } },
    ...options,
  });
}

function fixture(t: TestContext, messages: Message[], compactAt?: number) {
  const dir = mkdtempSync(join(tmpdir(), "amazme-settlement-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const storage = new FaultStorage(file);
  let runs = 0;
  let onResponse: (() => Promise<void>) | undefined;
  const provider = fauxProvider({ respond: async (_context, _options, state) => {
    await onResponse?.();
    return messages[state.callCount - 1] ?? answer("finished");
  } });
  const models = createModels();
  models.setProvider(provider);
  const work: HarnessTool = {
    name: "work", description: "work", parameters: { type: "object" }, replay: "never",
    async execute() {
      runs += 1;
      return { content: [{ type: "text", text: "worked" }] };
    },
  };
  const options = {
    models, model: { provider: "faux", modelId: "faux-1" }, tools: [work], systemPrompt: "sys", maxAttempts: 2,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
    compaction: { enabled: compactAt !== undefined, maxTokens: compactAt ?? 80_000 },
  };
  const first = new AgentHarness(storage, options);
  return {
    file, storage, provider, first, runs: () => runs,
    onResponse(callback: () => Promise<void>) { onResponse = callback; },
    reopen(crashing = false) { return new AgentHarness(crashing ? new FaultStorage(file) : new JsonlStorage(file), options); },
  };
}

function matchesAssistant(text: string): (writes: Write[]) => boolean {
  return (writes) => writes.some((write) => write.type === "entry" && write.payload.type === "message"
    && write.payload.message.role === "assistant" && messageText(write.payload.message) === text);
}

async function assertSettled(runtime: AgentHarness, operationId: string, status: string, file: string) {
  const result = await runtime.lane().drive(operationId, { waitForRetry: true });
  assert.ok(result.ok && result.value.kind === "settled");
  assert.equal(result.value.result.status, status);
  assert.equal(result.value.result.tipId, (await runtime.lane().inspect()).tipId);
  assert.equal((await runtime.lane().inspect()).operationId, null);
  assert.equal((await runtime.lane().inspect()).phase, null);
  await runtime.storage.read((view) => {
    assert.equal(view.get(value("pi.op.meta", operationId)), undefined);
    assert.equal(view.get(value("pi.op.state", operationId)), undefined);
    const rows = view.usageRows();
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    assert.equal(view.lists().length, 0);
  });
  assert.deepEqual(await runtime.lane().drive(operationId), result);
  const foreign = await runtime.lane("other").drive(operationId);
  assert.equal(foreign.ok, false);
  const restarted = new AgentHarness(new JsonlStorage(file), runtime.options);
  assert.deepEqual(await restarted.lane().drive(operationId), result);
  restarted.close();
  return result.value.result;
}

const cases: Array<{ name: string; messages: Message[]; phase: string | null; status: string; calls: number; runs?: number; cancel?: boolean }> = [
  { name: "answer", messages: [answer("answer")], phase: "checkpoint", status: "completed", calls: 1 },
  { name: "tools", messages: [{ ...answer("tools"), content: [{ type: "text", text: "tools" }, fauxToolCall("work", {})], stopReason: "toolUse" }], phase: "tools", status: "completed", calls: 2, runs: 1 },
  { name: "length", messages: [{ ...answer("length"), content: [{ type: "text", text: "length" }, fauxToolCall("work", {})], stopReason: "length" }], phase: "tools", status: "completed", calls: 2 },
  { name: "retry", messages: [answer("retry", { stopReason: "error", retryable: true, errorMessage: "retry" })], phase: "retry_wait", status: "completed", calls: 2 },
  { name: "retry exhausted", messages: [answer("first retry", { stopReason: "error", retryable: true }), answer("retry exhausted", { stopReason: "error", retryable: true, errorMessage: "still failing" })], phase: null, status: "failed", calls: 2 },
  { name: "overflow", messages: [answer("overflow", { stopReason: "error", overflow: true })], phase: null, status: "failed", calls: 1 },
  { name: "error", messages: [answer("error", { stopReason: "error", errorMessage: "failed" })], phase: null, status: "failed", calls: 1 },
  { name: "aborted", messages: [answer("aborted", { stopReason: "aborted" })], phase: null, status: "aborted", calls: 1 },
  { name: "cancelled", messages: [answer("cancelled")], phase: null, status: "aborted", calls: 1, cancel: true },
];

for (const scenario of cases) {
  for (const timing of ["before", "after", "torn"] as const) {
    test(`${scenario.name}: ${timing} settlement interruption survives JSONL reopen`, async (t) => {
      const f = fixture(t, scenario.messages);
      const admission = await f.first.lane().accept({ kind: "prompt", text: "go" });
      assert.ok(admission.ok);
      const operationId = admission.value.operationId;
      if (scenario.cancel) f.onResponse(async () => { await f.first.lane().requestAbort(operationId); });
      f.storage.fault = { timing, matches: matchesAssistant(scenario.name) };
      await assert.rejects(f.first.lane().drive(operationId, { waitForRetry: true }), /injected settlement crash/);
      assert.equal(f.storage.injected, true);
      f.first.abandon();
      const callsAtCrash = f.provider.state.callCount;
      const reopened = f.reopen();
      const persisted = timing === "after";
      const snapshot = await reopened.lane().inspect();
      assert.equal(snapshot.phase, timing === "after" ? scenario.phase : "assistant_effect_pending");
      const saved = (await reopened.lane().entries()).filter((entry) => entry.payload.type === "message"
        && entry.payload.message.role === "assistant" && messageText(entry.payload.message) === scenario.name);
      assert.equal(saved.length, persisted ? 1 : 0);
      assert.equal(await reopened.storage.read((view) => view.usageRows().length), callsAtCrash - (persisted ? 0 : 1));
      if (timing === "after" && scenario.phase === null) {
        const terminal = await reopened.storage.read((view) => view.get<{ status: string; tipId: string }>(value("pi.result", operationId)));
        assert.equal(terminal?.status, scenario.status);
        assert.equal(terminal?.tipId, snapshot.tipId);
      }
      await assertSettled(reopened, operationId, persisted ? scenario.status : "aborted", f.file);
      assert.equal(f.provider.state.callCount, persisted ? scenario.calls : callsAtCrash);
      assert.equal(f.runs(), persisted ? (scenario.runs ?? 0) : 0);
      const usage = await reopened.storage.read((view) => view.usageRows());
      assert.equal(usage.length, f.provider.state.callCount);
      assert.equal(usage.reduce((total, row) => total + row.totalTokens, 0), persisted ? scenario.calls * 5 : (callsAtCrash - 1) * 5);
      reopened.close();
    });
  }
}

for (const boundary of ["finish", "navigation", "resume"] as const) {
  for (const timing of ["before", "after", "torn"] as const) {
    test(`summary ${boundary}: ${timing} interruption preserves its settlement`, async (t) => {
      const f = fixture(t, [answer("seed"), answer(validSummary("summary")), answer("continued")], boundary === "resume" ? 30 : undefined);
      await f.first.lane().prompt("seed");
      const seedTip = (await f.first.lane().inspect()).tipId;
      const target = (await f.first.lane().entries())[0]?.id ?? null;
      const request: OperationRequest = boundary === "finish" ? { kind: "compaction" }
        : boundary === "navigation" ? { kind: "navigation", targetId: target, summarize: true }
          : { kind: "prompt", text: "long input ".repeat(80) };
      const admission = await f.first.lane().accept(request);
      assert.ok(admission.ok);
      const admittedTip = (await f.first.lane().inspect()).tipId;
      let responseEntryId: string | undefined;
      f.onResponse(async () => {
        responseEntryId = await f.first.storage.read(view => view.get<{ responseEntryId: string }>(value("pi.op.state", admission.value.operationId))?.responseEntryId);
      });
      f.storage.fault = { timing, matches: (writes) => writes.some((write) => write.type === "entry" && write.payload.type === "compaction") };
      await assert.rejects(f.first.lane().drive(admission.value.operationId), /injected settlement crash/);
      f.first.abandon();
      const reopened = f.reopen();
      const persisted = timing === "after";
      assert.equal((await reopened.lane().inspect()).phase, timing === "after" ? (boundary === "resume" ? "assistant_ready" : null) : "summary_effect_pending");
      const summaries = (await reopened.lane().entries()).filter((entry) => entry.payload.type === "compaction");
      assert.equal(summaries.length, persisted ? 1 : 0);
      if (persisted) {
        assert.equal(summaries[0]?.id, responseEntryId);
        assert.equal(summaries[0]?.parentId, boundary === "navigation" ? target : boundary === "resume" ? seedTip : admittedTip);
        if (boundary === "resume") {
          const chain = await reopened.lane().entries();
          const tip = chain[chain.length - 1];
          assert.equal(tip?.parentId, summaries[0]?.id);
          assert.equal(tip?.payload.type, "message");
          if (tip?.payload.type === "message" && tip.payload.message.role !== "custom") {
            assert.match(messageText(tip.payload.message), /long input/);
          }
          assert.equal(await reopened.storage.read((view) => view.usageRows().length), 2);
        }
      }
      await assertSettled(reopened, admission.value.operationId, persisted ? "completed" : "aborted", f.file);
      assert.equal(f.provider.state.callCount, persisted && boundary === "resume" ? 3 : 2);
      const usage = await reopened.storage.read((view) => view.usageRows());
      assert.equal(usage.length, f.provider.state.callCount);
      assert.equal(usage.reduce((total, row) => total + row.totalTokens, 0), persisted ? f.provider.state.callCount * 5 : 5);
      reopened.close();
    });
  }
}

for (const kind of ["assistant", "summary"] as const) {
  for (const timing of ["before", "after", "torn"] as const) {
    test(`${kind} recovery can crash again with ${timing} settlement without duplicates or resending`, async (t) => {
      const f = fixture(t, [answer("seed"), answer(validSummary("answer"))]);
      if (kind === "summary") await f.first.lane().prompt("seed");
      const admission = await f.first.lane().accept(kind === "summary" ? { kind: "compaction" } : { kind: "prompt", text: "go" });
      assert.ok(admission.ok);
      f.storage.fault = { timing: "before", matches: (writes) => writes.some((write) => write.type === "entry" && (kind === "assistant"
        ? write.payload.type === "message" && write.payload.message.role === "assistant" : write.payload.type === "compaction")) };
      await assert.rejects(f.first.lane().drive(admission.value.operationId), /injected settlement crash/);
      f.first.abandon();
      const calls = f.provider.state.callCount;
      const second = f.reopen(true);
      assert.ok(second.storage instanceof FaultStorage);
      second.storage.fault = { timing, matches: (writes) => writes.some((write) => write.type === "entry"
        && write.payload.type === "message" && write.payload.message.role === "assistant" && write.payload.message.stopReason === "aborted") };
      await assert.rejects(second.lane().drive(admission.value.operationId), /injected settlement crash/);
      second.abandon();
      const third = f.reopen();
      await assertSettled(third, admission.value.operationId, "aborted", f.file);
      assert.equal(f.provider.state.callCount, calls);
      assert.equal(await third.storage.read((view) => view.usageRows().length), calls);
      third.close();
    });
  }
}

test("resume compaction with a copied tail can crash again during recovery without resending", async (t) => {
  const f = fixture(t, [answer("seed"), answer(validSummary("summary")), answer("continued")], 30);
  await f.first.lane().prompt("seed");
  const admission = await f.first.lane().accept({ kind: "prompt", text: "long input ".repeat(80) });
  assert.ok(admission.ok);
  f.storage.fault = {
    timing: "before",
    matches: (writes) => writes.some((write) => write.type === "entry" && write.payload.type === "compaction"),
  };
  await assert.rejects(f.first.lane().drive(admission.value.operationId), /injected settlement crash/);
  f.first.abandon();
  const calls = f.provider.state.callCount;
  assert.equal(calls, 2);
  const second = f.reopen(true);
  assert.ok(second.storage instanceof FaultStorage);
  second.storage.fault = {
    timing: "before",
    matches: (writes) => writes.some((write) => write.type === "entry"
      && write.payload.type === "message" && write.payload.message.role === "assistant" && write.payload.message.stopReason === "aborted"),
  };
  await assert.rejects(second.lane().drive(admission.value.operationId), /injected settlement crash/);
  second.abandon();
  const third = f.reopen();
  await assertSettled(third, admission.value.operationId, "aborted", f.file);
  assert.equal(f.provider.state.callCount, calls);
  const entries = await third.lane().entries();
  assert.equal(entries.some((entry) => entry.payload.type === "compaction"), false);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  const usage = await third.storage.read((view) => view.usageRows());
  assert.equal(usage.length, calls);
  assert.equal(new Set(usage.map((row) => row.id)).size, usage.length);
  third.close();
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`summary ${stopReason} settles without retaining a live effect`, async (t) => {
    const f = fixture(t, [answer("seed"), answer("failed summary", { stopReason })]);
    await f.first.lane().prompt("seed");
    const admission = await f.first.lane().accept({ kind: "compaction" });
    assert.ok(admission.ok);
    await assertSettled(f.first, admission.value.operationId, stopReason === "error" ? "failed" : "aborted", f.file);
    assert.equal(f.first.live.size, 0);
    assert.equal((await f.first.lane().entries()).some((entry) => entry.payload.type === "compaction"), false);
    assert.equal(await f.first.storage.read((view) => view.usageRows().length), 2);
    assert.equal(f.provider.state.callCount, 2);
    f.first.close();
  });
}

for (const timing of ["before", "after", "torn"] as const) {
  test(`navigation: ${timing} interruption keeps tip and terminal result together`, async (t) => {
    const f = fixture(t, [answer("seed")]);
    await f.first.lane().prompt("seed");
    const oldTip = (await f.first.lane().inspect()).tipId;
    const admission = await f.first.lane().accept({ kind: "navigation", targetId: null });
    assert.ok(admission.ok);
    f.storage.fault = { timing, matches: (writes) => writes.some((write) => write.type === "set" && write.address.namespace === "pi.branch.tip") };
    await assert.rejects(f.first.lane().drive(admission.value.operationId), /injected settlement crash/);
    f.first.abandon();
    const reopened = f.reopen();
    assert.equal((await reopened.lane().inspect()).tipId, timing === "after" ? null : oldTip);
    assert.equal((await reopened.lane().inspect()).phase, timing === "after" ? null : "navigation_ready");
    const result = await assertSettled(reopened, admission.value.operationId, "completed", f.file);
    assert.equal(result.tipId, null);
    assert.equal(f.provider.state.callCount, 1);
    reopened.close();
  });
}

for (const kind of ["assistant", "summary"] as const) {
  for (const collision of ["entry", "usage"] as const) {
    test(`${kind} pending response with an occupied ${collision} id is rejected without writes`, async (t) => {
      const f = fixture(t, [answer("seed"), answer(validSummary("answer"))]);
      if (kind === "summary") await f.first.lane().prompt("seed");
      const admission = await f.first.lane().accept(kind === "summary" ? { kind: "compaction" } : { kind: "prompt", text: "go" });
      assert.ok(admission.ok);
      const id = admission.value.operationId;
      f.storage.fault = { timing: "before", matches: writes => writes.some(write => write.type === "entry"
        && (kind === "summary" ? write.payload.type === "compaction" : write.payload.type === "message" && write.payload.message.role === "assistant")) };
      await assert.rejects(f.first.lane().drive(id), /injected settlement crash/);
      f.first.abandon();
      const reopened = f.reopen();
      const state = await reopened.storage.read(view => view.get<{ responseEntryId: string; usageId: string }>(value("pi.op.state", id)));
      assert.ok(state);
      const tipId = (await reopened.lane().inspect()).tipId;
      await reopened.storage.commit([collision === "entry"
        ? { type: "entry", id: state.responseEntryId, parentId: tipId, timestamp: 1, payload: { type: "compaction", summary: "collision" } }
        : { type: "usage", id: state.usageId, operationId: id, input: 1, output: 1, totalTokens: 2 }]);
      const before = readFileSync(f.file, "utf8");
      const calls = f.provider.state.callCount;
      await assert.rejects(reopened.lane().drive(id), /inconsistent pending response/);
      assert.equal(readFileSync(f.file, "utf8"), before);
      assert.equal(f.provider.state.callCount, calls);
      reopened.close();
    });
  }
}
