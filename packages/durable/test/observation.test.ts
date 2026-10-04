import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  messageText,
  type AssistantContent,
  type AssistantEventStream,
  type Model,
  type Provider,
} from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";
import { AgentHarness, type HarnessTool, type LaneSnapshot, type Storage, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";

const model: Model = {
  id: "g",
  name: "g",
  provider: "gated",
  api: "faux",
  input: ["text"],
  contextWindow: 10_000,
  maxTokens: 100,
  cost: { input: 0, output: 0 },
};

/** Each model call hands its stream to the test, which pushes events itself. */
function gatedModels() {
  const streams: AssistantEventStream[] = [];
  const provider: Provider = {
    id: "gated",
    name: "gated",
    auth: { apiKey: { env: "GATED", ambient: "x" } },
    getModels: () => [model],
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    streamSimple() {
      const stream = createAssistantEventStream();
      streams.push(stream);
      return stream;
    },
  };
  const models = createModels();
  models.setProvider(provider);
  return { models, streams };
}

function partial(content: AssistantContent[]) {
  return { ...baseAssistant(model, content, "stop"), stopReason: "pending" as const };
}

function runtime(storage: Storage, models: ReturnType<typeof createModels>, tools: HarnessTool[] = []) {
  return new AgentHarness(storage, { models, model: { provider: "gated", modelId: "g" }, tools });
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for durable state");
}

function pendingText(snapshot: LaneSnapshot): string | undefined {
  const block = snapshot.pendingResponse?.content[0];
  return block?.type === "text" ? block.text : undefined;
}

function texts(snapshot: LaneSnapshot): string[] {
  return snapshot.entries.map((entry) => entry.payload.type === "message" && entry.payload.message.role !== "custom"
    ? messageText(entry.payload.message)
    : "");
}

test("snapshot projects the persisted reply prefix from one view and settles without repeating it", async () => {
  const storage = new MemoryStorage();
  const { models, streams } = gatedModels();
  const harness = runtime(storage, models);
  try {
    const lane = harness.lane();
    const empty = await lane.snapshot();
    assert.deepEqual(empty, {
      version: 0, lane: "main", tipId: null, phase: null, operationId: null, lastOperationId: null,
      status: null, entries: [], pendingResponse: null, tools: [],
    });
    assert.equal(await storage.read((view) => view.values().length), 0, "a query does not initialize the lane");

    const admitted = await lane.accept({ kind: "prompt", text: "hi" });
    assert.ok(admitted.ok);
    const operationId = admitted.value.operationId;
    const accepted = await lane.snapshot();
    assert.equal(accepted.phase, "starting");
    assert.equal(accepted.operationId, operationId);
    assert.deepEqual(texts(accepted), ["hi"]);
    assert.equal(accepted.pendingResponse, null);

    const driving = lane.drive(operationId);
    await until(async () => streams.length === 1 && (await lane.snapshot()).phase === "assistant_effect_pending");
    const reserved = await lane.snapshot();
    assert.equal(reserved.pendingResponse?.operationId, operationId);
    assert.deepEqual(reserved.pendingResponse?.content, []);
    assert.equal(reserved.pendingResponse?.stopReason, null);
    assert.equal(reserved.pendingResponse?.errorMessage, null);

    const stream = streams[0]!;
    stream.push({ type: "start", partial: partial([]) });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Hel", partial: partial([{ type: "text", text: "Hel" }]) });
    await until(async () => pendingText(await lane.snapshot()) === "Hel");
    const first = await lane.snapshot();
    assert.ok(first.version > reserved.version);
    assert.deepEqual(await lane.snapshot(), first, "the same version projects the same snapshot");
    assert.equal(await storage.read((view) => view.version()), first.version, "reads do not write");

    stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial: partial([{ type: "text", text: "Hello" }]) });
    await until(async () => pendingText(await lane.snapshot()) === "Hello");
    const second = await lane.snapshot();
    assert.ok(second.version > first.version);
    assert.equal(second.status, "open");
    assert.deepEqual(texts(second), ["hi"], "the unsettled reply is not an entry");

    stream.push({ type: "done", reason: "stop", message: baseAssistant(model, [{ type: "text", text: "Hello" }], "stop") });
    const outcome = await driving;
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    const settled = await lane.snapshot();
    assert.equal(settled.pendingResponse, null);
    assert.equal(settled.phase, null);
    assert.equal(settled.operationId, null);
    assert.equal(settled.lastOperationId, operationId);
    assert.deepEqual(texts(settled), ["hi", "Hello"]);
    assert.equal(settled.tipId, settled.entries.at(-1)?.id);
    assert.equal(settled.entries.at(-1)?.id, reserved.pendingResponse?.responseEntryId);
    assert.ok(settled.version > second.version);
    assert.equal(streams.length, 1, "queries never call the model");
  } finally {
    harness.close();
  }
});

class StopFrameStorage extends MemoryStorage {
  onStop?: () => void;
  protected override persist(writes: readonly Write[]): void {
    if (writes.some((write) => write.type === "append" && (write.item as { type?: string }).type === "stop")) this.onStop?.();
  }
}

test("an observed stop frame stays an unsettled prefix and tool calls appear only after their arguments end", async () => {
  const storage = new StopFrameStorage();
  const { models, streams } = gatedModels();
  let runs = 0;
  const wipe: HarnessTool = {
    name: "wipe", description: "wipe", parameters: { type: "object" }, replay: "never",
    async execute() { runs += 1; return { content: [{ type: "text", text: "wiped" }] }; },
  };
  const first = runtime(storage, models, [wipe]);
  storage.onStop = () => first.abandon();
  const lane = first.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const driving = lane.drive(admitted.value.operationId);
  await until(async () => streams.length === 1);
  const stream = streams[0]!;
  const call = { type: "toolCall" as const, id: "call_wipe", name: "wipe", arguments: { path: "secret" } };
  stream.push({ type: "text_delta", contentIndex: 0, delta: "plan", partial: partial([{ type: "text", text: "plan" }]) });
  stream.push({ type: "toolcall_start", contentIndex: 1, partial: partial([{ type: "text", text: "plan" }, { ...call, arguments: {} }]) });
  stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{\"path\":", partial: partial([{ type: "text", text: "plan" }, { ...call, arguments: {} }]) });
  await until(async () => pendingText(await lane.snapshot()) === "plan");
  assert.deepEqual((await lane.snapshot()).pendingResponse?.content.map((block) => block.type), ["text"]);

  stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: partial([{ type: "text", text: "plan" }, call]) });
  await until(async () => ((await lane.snapshot()).pendingResponse?.content.length ?? 0) === 2);
  stream.push({ type: "done", reason: "toolUse", message: baseAssistant(model, [{ type: "text", text: "plan" }, call], "toolUse") });
  await driving;

  const observed = await lane.snapshot();
  assert.equal(observed.phase, "assistant_effect_pending");
  assert.equal(observed.pendingResponse?.stopReason, "toolUse");
  assert.deepEqual(observed.pendingResponse?.content, [{ type: "text", text: "plan" }, call]);
  assert.deepEqual(texts(observed), ["go"]);
  assert.equal(runs, 0);

  const second = runtime(storage, models, [wipe]);
  try {
    const before = await second.lane().snapshot();
    assert.deepEqual(before, observed, "a new harness reads without recovering");
    const recovered = await second.lane().drive(admitted.value.operationId);
    assert.ok(recovered.ok && recovered.value.kind === "settled");
    assert.equal(recovered.value.result.status, "aborted");
    const after = await second.lane().snapshot();
    assert.equal(after.pendingResponse, null);
    assert.deepEqual(texts(after), ["go", "plan"]);
    const assistant = after.entries.at(-1);
    assert.ok(assistant?.payload.type === "message" && assistant.payload.message.role === "assistant");
    assert.equal(assistant.payload.message.stopReason, "aborted");
    assert.equal(assistant.payload.message.content.some((block) => block.type === "toolCall"), false);
    assert.equal(runs, 0);
    assert.equal(streams.length, 1);
  } finally {
    second.close();
    first.close();
  }
});

test("JSONL reopen restores the same version, snapshot and result without driving", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-observe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lane.jsonl");
  const original = gatedModels();
  const first = runtime(new JsonlStorage(file), original.models);
  const admitted = await first.lane().accept({ kind: "prompt", text: "hi" });
  assert.ok(admitted.ok);
  const operationId = admitted.value.operationId;
  const driving = first.lane().drive(operationId);
  await until(async () => original.streams.length === 1);
  original.streams[0]!.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: partial([{ type: "text", text: "partial" }]) });
  await until(async () => pendingText(await first.lane().snapshot()) === "partial");
  first.abandon();
  const crashed = await first.lane().snapshot();
  original.streams[0]!.push({ type: "done", reason: "stop", message: baseAssistant(model, [{ type: "text", text: "partial" }], "stop") });
  await driving;
  first.close();

  const reopened = gatedModels();
  const second = runtime(new JsonlStorage(file), reopened.models);
  try {
    assert.deepEqual(await second.lane().snapshot(), crashed);
    assert.deepEqual(await second.lane().result(operationId), { ok: true, value: null });
    assert.equal(reopened.streams.length, 0);
    const recovered = await second.lane().drive(operationId);
    assert.ok(recovered.ok && recovered.value.kind === "settled");
    const settled = await second.lane().snapshot();
    const result = await second.lane().result(operationId);
    assert.deepEqual(result, { ok: true, value: recovered.value.result });
    assert.equal(reopened.streams.length, 0, "recovery does not resend the model request");

    const third = runtime(new JsonlStorage(file), reopened.models);
    try {
      assert.deepEqual(await third.lane().snapshot(), settled);
      assert.deepEqual(await third.lane().result(operationId), result);
      assert.deepEqual(texts(settled), ["hi", "partial"]);
    } finally {
      third.close();
    }
  } finally {
    second.close();
  }
});

test("result is null before settlement, the settled result after, and refuses another lane", async () => {
  const storage = new MemoryStorage();
  const models = createModels();
  models.setProvider(fauxProvider());
  const harness = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" } });
  try {
    const a = harness.lane("a");
    const b = harness.lane("b");
    const admitted = await a.accept({ kind: "prompt", text: "hi" });
    assert.ok(admitted.ok);
    const operationId = admitted.value.operationId;
    const version = await storage.read((view) => view.version());
    assert.deepEqual(await a.result(operationId), { ok: true, value: null });
    assert.deepEqual(await a.result("unknown"), { ok: true, value: null });
    const pending = await b.result(operationId);
    assert.equal(!pending.ok && pending.error.code, "operation_mismatch");
    assert.equal(await storage.read((view) => view.version()), version);
    assert.equal((await a.inspect()).phase, "starting", "result does not drive");

    const outcome = await a.drive(operationId);
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    assert.deepEqual(await a.result(operationId), { ok: true, value: outcome.value.result });
    assert.equal(outcome.value.result.status, "completed");
    const settled = await b.result(operationId);
    assert.equal(!settled.ok && settled.error.code, "operation_mismatch");
  } finally {
    harness.close();
  }
});

test("returned snapshots and results are detached from storage", async () => {
  const storage = new MemoryStorage();
  const { models, streams } = gatedModels();
  const harness = runtime(storage, models);
  try {
    const lane = harness.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "hi" });
    assert.ok(admitted.ok);
    const driving = lane.drive(admitted.value.operationId);
    await until(async () => streams.length === 1);
    const call = { type: "toolCall" as const, id: "call_x", name: "x", arguments: { nested: { value: 1 } } };
    streams[0]!.push({ type: "text_delta", contentIndex: 0, delta: "text", partial: partial([{ type: "text", text: "text" }]) });
    streams[0]!.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: partial([{ type: "text", text: "text" }, call]) });
    await until(async () => ((await lane.snapshot()).pendingResponse?.content.length ?? 0) === 2);

    const snapshot = await lane.snapshot();
    const expected = structuredClone(snapshot);
    const entry = snapshot.entries[0]!;
    assert.ok(entry.payload.type === "message" && entry.payload.message.role === "user");
    entry.payload.message.content = "mutated";
    entry.parentId = "mutated";
    snapshot.entries.push(entry);
    const text = snapshot.pendingResponse!.content[0]!;
    assert.ok(text.type === "text");
    text.text = "mutated";
    const tool = snapshot.pendingResponse!.content[1]!;
    assert.ok(tool.type === "toolCall");
    (tool.arguments as { nested: { value: number } }).nested.value = 2;
    assert.deepEqual(await lane.snapshot(), expected);

    streams[0]!.push({ type: "done", reason: "stop", message: baseAssistant(model, [{ type: "text", text: "text" }], "stop") });
    await driving;
    const result = await lane.result(admitted.value.operationId);
    assert.ok(result.ok && result.value);
    const settled = structuredClone(result.value);
    result.value.status = "failed";
    result.value.tipId = "mutated";
    assert.deepEqual(await lane.result(admitted.value.operationId), { ok: true, value: settled });
  } finally {
    harness.close();
  }
});

test("snapshot reports the open tool batch and history pages the ancestor chain", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("hold", {})])
      : fauxAssistant("after"),
  }));
  const harness = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [{
      name: "hold",
      description: "hold",
      parameters: { type: "object" },
      async execute() {
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      },
    }],
  });
  try {
    const lane = harness.lane();
    const first = await lane.accept({ kind: "prompt", text: "one" });
    assert.ok(first.ok);
    const driving = lane.drive(first.value.operationId);
    await until(async () => (await lane.snapshot()).tools.some((tool) => tool.status === "running"));
    const running = await lane.snapshot();
    assert.equal(running.phase, "tools");
    assert.deepEqual(running.tools.map((tool) => ({ name: tool.name, status: tool.status })), [{ name: "hold", status: "running" }]);
    release();
    const settled = await driving;
    assert.ok(settled.ok && settled.value.kind === "settled");
    assert.deepEqual((await lane.snapshot()).tools, []);

    const second = await lane.accept({ kind: "prompt", text: "two" });
    assert.ok(second.ok);
    const again = await lane.drive(second.value.operationId);
    assert.ok(again.ok);
    const chain = await lane.snapshot();
    const newest = await lane.history(null, 1);
    assert.ok(newest.ok);
    assert.equal(newest.value.entries.length, 1);
    assert.equal(newest.value.entries[0]?.id, chain.entries.at(-1)?.id);
    assert.equal(newest.value.older, chain.entries.length - 1);
    const rest = await lane.history(newest.value.entries[0]!.id, 100);
    assert.ok(rest.ok);
    assert.equal(rest.value.older, 0);
    assert.deepEqual(rest.value.entries.map((entry) => entry.id), chain.entries.slice(0, -1).map((entry) => entry.id));
    const missing = await lane.history("missing", 1);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "unknown_target");
  } finally {
    harness.close();
  }
});
