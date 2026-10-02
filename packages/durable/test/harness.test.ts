import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, type HarnessTool, type HarnessMessage, value } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  messageText,
  type Model,
  type Provider,
} from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";

function harnessText(message: HarnessMessage): string {
  return message.role === "custom" ? message.content : messageText(message);
}

function scripted(messages: ReturnType<typeof fauxAssistant>[]) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => messages[Math.min(state.callCount - 1, messages.length - 1)] ?? fauxAssistant("empty"),
  });
  const models = createModels();
  models.setProvider(provider);
  return { provider, models };
}

function harness(storage: MemoryStorage, models: ReturnType<typeof createModels>, tools: HarnessTool[] = [], extra: { maxTokens?: number } = {}) {
  return new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools,
    systemPrompt: "sys",
    compaction: { enabled: extra.maxTokens !== undefined, maxTokens: extra.maxTokens ?? 80_000 },
    maxAttempts: 2,
  });
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for durable state");
}

function tool(name: string, execute: HarnessTool["execute"], replay: "safe" | "never" = "never"): HarnessTool {
  return {
    name,
    description: name,
    replay,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute,
  };
}

test("accept records the user entry and does not call the model", async () => {
  const { provider, models } = scripted([fauxAssistant("hi")]);
  const lane = harness(new MemoryStorage(), models).lane();
  const admitted = await lane.accept({ kind: "prompt", text: "hello" });
  assert.equal(admitted.ok, true);
  assert.equal(provider.state.callCount, 0);
  const entries = await lane.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.payload.type, "message");
});

test("a prompt runs the model, then the tool, then the model again", async () => {
  const { provider, models } = scripted([
    fauxAssistant([fauxToolCall("echo", { value: 1 })]),
    fauxAssistant("finished"),
  ]);
  let runs = 0;
  const lane = harness(new MemoryStorage(), models, [
    tool("echo", async () => {
      runs += 1;
      return { content: [{ type: "text", text: "echoed" }] };
    }),
  ]).lane();
  const result = await lane.prompt("go");
  assert.equal(result.status, "completed");
  assert.equal(provider.state.callCount, 2);
  assert.equal(runs, 1);
  const texts = (await lane.entries()).map((entry) => (entry.payload.type === "message" ? harnessText(entry.payload.message) : entry.payload.summary));
  assert.deepEqual(texts, ["go", "", "echoed", "finished"]);
});

test("parallel tool results materialize in source order", async () => {
  const finished: string[] = [];
  const { models } = scripted([
    fauxAssistant([fauxToolCall("slow", {}, "call_slow"), fauxToolCall("fast", {}, "call_fast")]),
    fauxAssistant("done"),
  ]);
  const make = (name: string, delay: number): HarnessTool =>
    tool(name, async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      finished.push(name);
      return { content: [{ type: "text", text: name }] };
    }, "safe");
  const lane = harness(new MemoryStorage(), models, [make("slow", 30), make("fast", 5)]).lane();
  await lane.prompt("go");
  assert.deepEqual(finished, ["fast", "slow"]);
  const results = (await lane.entries()).filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
  assert.deepEqual(
    results.map((entry) => (entry.payload.type === "message" ? harnessText(entry.payload.message) : "")),
    ["slow", "fast"],
  );
});

test("steer is placed before the next assistant request and follow-up waits until the run would stop", async () => {
  const seen: string[][] = [];
  const provider = fauxProvider({
    respond: (context, _options, state) => {
      seen.push(context.messages.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : "")));
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("mark", {})]);
      return fauxAssistant(state.callCount === 2 ? "after-steer" : "after-follow");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const lane = harness(new MemoryStorage(), models, [
    tool("mark", async () => {
      await lane.steer("steer-msg");
      await lane.followUp("follow-msg");
      return { content: [{ type: "text", text: "marked" }] };
    }),
  ]).lane();
  const result = await lane.prompt("prompt");
  assert.equal(result.status, "completed");
  assert.equal(provider.state.callCount, 3);
  assert.deepEqual(seen[0], ["prompt"]);
  assert.equal(seen[1]?.includes("steer-msg"), true);
  assert.equal(seen[1]?.includes("follow-msg"), false);
  assert.equal(seen[2]?.includes("follow-msg"), true);
});

test("a crashed assistant stream is settled from frames and is not sent again", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const model: Model = {
    id: "g",
    name: "g",
    provider: "gated",
    api: "faux",
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0 },
  };
  const provider: Provider = {
    id: "gated",
    name: "gated",
    auth: { env: "GATED", ambient: "x" },
    getModels: () => [model],
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    streamSimple(active, _context, options) {
      calls += 1;
      const stream = createAssistantEventStream();
      const message = baseAssistant(active, [{ type: "text", text: "partial-answer" }], "stop");
      void (async () => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "partial-answer", partial: { ...message, stopReason: "pending" } });
        await gate;
        if (options?.signal?.aborted) {
          const aborted = baseAssistant(active, [{ type: "text", text: "partial-answer" }], "aborted");
          stream.push({ type: "error", error: aborted });
          return;
        }
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    },
  };
  const models = createModels();
  models.setProvider(provider);
  const storage = new MemoryStorage();
  const first = new AgentHarness(storage, { models, model: { provider: "gated", modelId: "g" }, tools: [] });
  const admitted = await first.lane().accept({ kind: "prompt", text: "hi" });
  assert.equal(admitted.ok, true);
  const driving = first.lane().drive(admitted.value.operationId);
  await waitFor(async () => (await storage.read((view) => view.lists().some((item) => item.items.length > 0))));
  first.abandon();
  const second = new AgentHarness(storage, { models, model: { provider: "gated", modelId: "g" }, tools: [] });
  const recovered = await second.lane().drive(admitted.value.operationId);
  release();
  await driving;
  assert.equal(recovered.ok, true);
  assert.equal(recovered.ok && recovered.value.kind === "settled" ? recovered.value.result.status : "", "aborted");
  assert.equal(calls, 1);
  const assistant = (await second.lane().entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant");
  assert.ok(assistant && assistant.payload.type === "message" && assistant.payload.message.role === "assistant");
  assert.equal(assistant.payload.message.stopReason, "aborted");
  assert.equal(harnessText(assistant.payload.message), "partial-answer");
  const operationLeft = await storage.read((view) => view.values().some((item) => item.key.includes("pi.op.state")));
  assert.equal(operationLeft, false);
  const resultLeft = await storage.read((view) => view.values().some((item) => item.key.includes("pi.result")));
  assert.equal(resultLeft, true);
});

test("a crashed stream keeps text from frames, drops the tool call, and does not execute it", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let runs = 0;
  const model: Model = {
    id: "g",
    name: "g",
    provider: "gated",
    api: "faux",
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0 },
  };
  const provider: Provider = {
    id: "gated",
    name: "gated",
    auth: { env: "GATED", ambient: "x" },
    getModels: () => [model],
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    streamSimple(active, _context, options) {
      calls += 1;
      const stream = createAssistantEventStream();
      const tool = { type: "toolCall" as const, id: "call_wipe", name: "wipe", arguments: { path: "secret" } };
      const message = baseAssistant(active, [tool, { type: "text", text: "after-tool" }], "toolUse");
      void (async () => {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [{ ...tool, arguments: {} }], stopReason: "pending" } });
        stream.push({ type: "text_delta", contentIndex: 1, delta: "after-tool", partial: { ...message, stopReason: "pending" } });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: { ...message, stopReason: "pending" } });
        await gate;
        if (options?.signal?.aborted) {
          stream.push({ type: "error", error: { ...message, stopReason: "aborted", errorMessage: "aborted" } });
          return;
        }
        stream.push({ type: "done", reason: "toolUse", message });
      })();
      return stream;
    },
  };
  const models = createModels();
  models.setProvider(provider);
  const storage = new MemoryStorage();
  const first = new AgentHarness(storage, {
    models,
    model: { provider: "gated", modelId: "g" },
    tools: [tool("wipe", async () => {
      runs += 1;
      return { content: [{ type: "text", text: "wiped" }] };
    })],
  });
  const admitted = await first.lane().accept({ kind: "prompt", text: "hi" });
  assert.equal(admitted.ok, true);
  const driving = first.lane().drive(admitted.value.operationId);
  await waitFor(async () => storage.read((view) => view.lists().some((list) => list.items.length >= 2)));
  first.abandon();
  const second = new AgentHarness(storage, {
    models,
    model: { provider: "gated", modelId: "g" },
    tools: [tool("wipe", async () => {
      runs += 1;
      return { content: [{ type: "text", text: "wiped" }] };
    })],
  });
  const recovered = await second.lane().drive(admitted.value.operationId);
  release();
  await driving;
  assert.equal(recovered.ok, true);
  assert.equal(recovered.ok && recovered.value.kind === "settled" ? recovered.value.result.status : "", "aborted");
  assert.equal(calls, 1);
  assert.equal(runs, 0);
  const assistant = (await second.lane().entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant");
  assert.ok(assistant && assistant.payload.type === "message" && assistant.payload.message.role === "assistant");
  assert.equal(assistant.payload.message.stopReason, "aborted");
  assert.equal(assistant.payload.message.content.some((block) => block.type === "toolCall"), false);
  assert.equal(harnessText(assistant.payload.message), "after-tool");
});

test("an interrupted unsafe tool is not repeated and keeps its checkpoint", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const { provider, models } = scripted([fauxAssistant([fauxToolCall("wipe", {})]), fauxAssistant("after")]);
  const storage = new MemoryStorage();
  const work = tool("wipe", async (_args, context) => {
    runs += 1;
    context.onUpdate?.("deleted 1", { checkpoint: true });
    await gate;
    return { content: [{ type: "text", text: "wiped" }] };
  }, "never");
  const first = harness(storage, models, [work]);
  const admitted = await first.lane().accept({ kind: "prompt", text: "clean" });
  assert.equal(admitted.ok, true);
  const driving = first.lane().drive(admitted.value.operationId);
  await waitFor(async () =>
    storage.read((view) => view.values().some((item) => item.key.includes("pi.pending.tool_output") && item.value === "deleted 1")),
  );
  first.abandon();
  const second = harness(storage, models, [work]);
  const recovered = await second.lane().drive(admitted.value.operationId);
  release();
  await driving;
  assert.equal(runs, 1);
  assert.equal(provider.state.callCount, 2);
  assert.equal(recovered.ok && recovered.value.kind === "settled" ? recovered.value.result.status : "", "completed");
  const toolEntry = (await second.lane().entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
  assert.ok(toolEntry && toolEntry.payload.type === "message");
  assert.match(harnessText(toolEntry.payload.message), /deleted 1/);
});

test("an interrupted safe tool runs again with the stored arguments", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const { models } = scripted([fauxAssistant([fauxToolCall("look", {})]), fauxAssistant("after")]);
  const storage = new MemoryStorage();
  const work = tool("look", async () => {
    runs += 1;
    if (runs === 1) {
      await gate;
      return { content: [{ type: "text", text: "first" }] };
    }
    return { content: [{ type: "text", text: "reread" }] };
  }, "safe");
  const first = harness(storage, models, [work]);
  const admitted = await first.lane().accept({ kind: "prompt", text: "look" });
  assert.equal(admitted.ok, true);
  const driving = first.lane().drive(admitted.value.operationId);
  await waitFor(async () => (await first.lane().inspect()).phase === "tools");
  first.abandon();
  const recovered = await harness(storage, models, [work]).lane().drive(admitted.value.operationId);
  release();
  await driving;
  assert.equal(runs, 2);
  assert.equal(recovered.ok && recovered.value.kind === "settled" ? recovered.value.result.status : "", "completed");
  const toolEntry = (await harness(storage, models, [work]).lane().entries()).find(
    (entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult",
  );
  assert.equal(toolEntry && toolEntry.payload.type === "message" ? harnessText(toolEntry.payload.message) : "", "reread");
});

test("overflow compacts once and a second overflow fails the run", async () => {
  const seen: string[] = [];
  const provider = fauxProvider({
    respond: (context, options, state) => {
      seen.push(context.messages.map((message) => harnessText(message)).join("|"));
      if (state.callCount === 1) return fauxAssistant("older answer");
      if (state.callCount === 2) return fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" });
      if (state.callCount === 3) {
        assert.equal(context.tools?.length ?? 0, 0);
        assert.equal(options.thinkingLevel, "off");
        assert.ok((options.maxTokens ?? 0) > 0);
        return fauxAssistant("folded summary");
      }
      return fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" });
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const storage = new MemoryStorage();
  const lane = harness(storage, models, [], { maxTokens: 100_000 }).lane();
  assert.equal((await lane.prompt("O".repeat(36_000))).status, "completed");
  const result = await lane.prompt("CURRENT_INPUT");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /repeated/);
  assert.equal(provider.state.callCount, 4);
  assert.match(seen[3] ?? "", /CURRENT_INPUT/);
  assert.match(seen[3] ?? "", /folded summary/);
  assert.equal((seen[3] ?? "").includes("O".repeat(36_000)), false);
  assert.equal(await storage.read((view) => view.usageRows().length), provider.state.callCount);
  assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), true);
});

test("threshold compaction keeps the current input and summarizes older context", async () => {
  const seen: string[] = [];
  const provider = fauxProvider({
    respond: (context, options, state) => {
      seen.push(context.messages.map((message) => harnessText(message)).join("|"));
      if (state.callCount === 2) {
        assert.equal(options.thinkingLevel, "off");
        assert.equal(context.tools?.length ?? 0, 0);
        assert.ok((options.maxTokens ?? 0) > 0);
        return fauxAssistant("folded");
      }
      return fauxAssistant(state.callCount === 1 ? "short" : "answer");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const lane = harness(new MemoryStorage(), models, [], { maxTokens: 20 }).lane();
  assert.equal((await lane.prompt("Y".repeat(200))).status, "completed");
  const result = await lane.prompt("CURRENT_QUESTION");
  assert.equal(result.status, "completed");
  assert.equal(provider.state.callCount, 3);
  assert.equal(seen[1]?.includes("Y".repeat(200)), true);
  assert.equal(seen[2]?.includes("CURRENT_QUESTION"), true);
  assert.equal(seen[2]?.includes("Y".repeat(200)), false);
  assert.match(seen[2] ?? "", /folded/);
});

test("unsummarized navigation moves the tip without a model call", async () => {
  const { provider, models } = scripted([fauxAssistant("one")]);
  const lane = harness(new MemoryStorage(), models).lane();
  await lane.prompt("hello");
  const userEntry = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
  assert.ok(userEntry);
  const calls = provider.state.callCount;
  const admitted = await lane.accept({ kind: "navigation", targetId: userEntry.id });
  assert.equal(admitted.ok, true);
  const moved = await lane.drive(admitted.value.operationId);
  assert.equal(moved.ok && moved.value.kind === "settled" ? moved.value.result.status : "", "completed");
  assert.equal(provider.state.callCount, calls);
  const tip = await lane.entries();
  assert.equal(tip[tip.length - 1]?.id, userEntry.id);
  const missing = await lane.accept({ kind: "navigation", targetId: "missing" });
  assert.equal(missing.ok, false);
});

test("jsonl storage reloads a settled session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-session-"));
  const file = join(dir, "lane.jsonl");
  const { models } = scripted([fauxAssistant("persisted")]);
  const first = harness(new JsonlStorage(file), models).lane();
  await first.prompt("save");
  const reloaded = harness(new JsonlStorage(file), models).lane();
  const texts = (await reloaded.entries()).map((entry) => (entry.payload.type === "message" ? harnessText(entry.payload.message) : ""));
  assert.deepEqual(texts, ["save", "persisted"]);
  const info = await reloaded.inspect();
  assert.equal(info.phase, null);
  assert.ok(info.lastOperationId);
});

test("a second drive joins the in-flight operation instead of sending again", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const provider = fauxProvider({
    respond: async () => {
      entered += 1;
      await gate;
      return fauxAssistant("once");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = harness(new MemoryStorage(), models);
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "hi" });
  assert.equal(admitted.ok, true);
  const first = lane.drive(admitted.value.operationId);
  const second = lane.drive(admitted.value.operationId);
  await waitFor(async () => entered === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(entered, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ok && left.value.kind === "settled" ? left.value.result.status : "", "completed");
  assert.equal(right.ok && right.value.kind === "settled" ? right.value.result.status : "", "completed");
  assert.equal(entered, 1);
});

test("aborting one lane does not abort another lane", async () => {
  const gates: Array<{ signal: AbortSignal; release: () => void }> = [];
  const provider = fauxProvider({
    respond: (_context, options) =>
      new Promise((resolve) => {
        const signal = options.signal ?? new AbortController().signal;
        const finish = () => resolve(fauxAssistant(signal.aborted ? "aborted" : "done", { stopReason: signal.aborted ? "aborted" : "stop" }));
        signal.addEventListener("abort", finish, { once: true });
        gates.push({ signal, release: finish });
      }),
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = harness(new MemoryStorage(), models);
  const laneA = runtime.lane("a");
  const laneB = runtime.lane("b");
  const admittedA = await laneA.accept({ kind: "prompt", text: "a" });
  assert.equal(admittedA.ok, true);
  const drivingA = laneA.drive(admittedA.value.operationId);
  await waitFor(async () => gates.length === 1);
  const admittedB = await laneB.accept({ kind: "prompt", text: "b" });
  assert.equal(admittedB.ok, true);
  const drivingB = laneB.drive(admittedB.value.operationId);
  await waitFor(async () => gates.length === 2);
  await laneA.requestAbort(admittedA.value.operationId);
  await waitFor(async () => gates[0]?.signal.aborted === true);
  assert.equal(gates[1]?.signal.aborted, false);
  gates[1]?.release();
  const settledA = await drivingA;
  const settledB = await drivingB;
  assert.equal(settledA.ok && settledA.value.kind === "settled" ? settledA.value.result.status : "", "aborted");
  assert.equal(settledB.ok && settledB.value.kind === "settled" ? settledB.value.result.status : "", "completed");
});

test("a torn jsonl tail is cut off before the next write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-torn-"));
  const file = join(dir, "lane.jsonl");
  const storage = new JsonlStorage(file);
  await storage.commit([{ type: "set", address: value("keep"), value: 1 }]);
  appendFileSync(file, "{\"writes\":[");
  const reopened = new JsonlStorage(file);
  assert.equal(await reopened.read((view) => view.get(value("keep"))), 1);
  await reopened.commit([{ type: "set", address: value("keep"), value: 2 }]);
  const again = new JsonlStorage(file);
  assert.equal(await again.read((view) => view.get(value("keep"))), 2);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length > 0) JSON.parse(line);
  }
});

test("a drive on another lane does not join or block the lane that owns the operation", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let hold = false;
  const provider = fauxProvider({
    respond: async () => {
      entered += 1;
      if (hold) await gate;
      return fauxAssistant("once");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = harness(new MemoryStorage(), models);
  const owner = runtime.lane("owner");
  const other = runtime.lane("other");
  const admitted = await owner.accept({ kind: "prompt", text: "hi" });
  assert.equal(admitted.ok, true);
  const wrongFirst = other.drive(admitted.value.operationId);
  const right = owner.drive(admitted.value.operationId);
  const [foreign, owned] = await Promise.all([wrongFirst, right]);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok ? "" : foreign.error.code, "operation_mismatch");
  assert.equal(owned.ok && owned.value.kind === "settled" ? owned.value.result.status : "", "completed");
  assert.equal(entered, 1);

  hold = true;
  const second = await owner.accept({ kind: "prompt", text: "again" });
  assert.equal(second.ok, true);
  const ownedDrive = owner.drive(second.value.operationId);
  await waitFor(async () => entered === 2);
  let foreignResult: Awaited<ReturnType<typeof other.drive>> | undefined;
  void other.drive(second.value.operationId).then((result) => {
    foreignResult = result;
  });
  await waitFor(async () => foreignResult !== undefined);
  assert.equal(foreignResult && !foreignResult.ok ? foreignResult.error.code : "", "operation_mismatch");
  release();
  const ownedResult = await ownedDrive;
  assert.equal(ownedResult.ok && ownedResult.value.kind === "settled" ? ownedResult.value.result.status : "", "completed");
  assert.equal(entered, 2);
});

test("settled results remain lane-owned after later operations and reopening storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-result-owner-"));
  const file = join(dir, "lane.jsonl");
  const { provider, models } = scripted([fauxAssistant("answer")]);
  const runtime = harness(new JsonlStorage(file), models);
  const owner = runtime.lane("owner");
  const other = runtime.lane("other");
  const results = [await owner.prompt("hi")];

  for (const request of [{ kind: "compaction" }, { kind: "navigation", targetId: null }] as const) {
    const admission = await owner.accept(request);
    assert.equal(admission.ok, true);
    const outcome = await owner.drive(admission.value.operationId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value.kind, "settled");
    if (outcome.value.kind === "settled") results.push(outcome.value.result);
  }

  for (const result of results) {
    assert.equal(result.lane, "owner");
    const foreign = await other.drive(result.operationId);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok ? "" : foreign.error.code, "operation_mismatch");
    assert.deepEqual(await owner.drive(result.operationId), { ok: true, value: { kind: "settled", result } });
  }
  runtime.close();

  const reloaded = harness(new JsonlStorage(file), models);
  const callsBeforeRead = provider.state.callCount;
  for (const result of results) {
    const foreign = await reloaded.lane("other").drive(result.operationId);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok ? "" : foreign.error.code, "operation_mismatch");
    assert.deepEqual(await reloaded.lane("owner").drive(result.operationId), { ok: true, value: { kind: "settled", result } });
  }
  assert.equal(provider.state.callCount, callsBeforeRead);
  reloaded.close();
});

test("results without persisted lane ownership are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-unowned-result-"));
  const file = join(dir, "lane.jsonl");
  const { models } = scripted([fauxAssistant("answer")]);
  await new JsonlStorage(file).commit([{
    type: "set",
    address: value("pi.result", "invalid-result"),
    value: {
      operationId: "invalid-result",
      kind: "run",
      status: "completed",
      fromTipId: null,
      tipId: null,
      startedAt: 1,
      endedAt: 2,
    },
  }]);
  const runtime = harness(new JsonlStorage(file), models);
  for (const name of ["main", "owner", "other"]) {
    const outcome = await runtime.lane(name).drive("invalid-result");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? "" : outcome.error.code, "operation_mismatch");
  }
  runtime.close();
});
