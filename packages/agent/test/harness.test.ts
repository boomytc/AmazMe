import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, type AgentTool, JsonlStorage, MemoryStorage } from "@amazme/agent";
import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  fauxAssistant,
  fauxProvider,
  fauxToolCall,
  messageText,
  type Model,
  type Provider,
} from "@amazme/ai";

function scripted(messages: ReturnType<typeof fauxAssistant>[]) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => messages[Math.min(state.callCount - 1, messages.length - 1)] ?? fauxAssistant("empty"),
  });
  const models = createModels();
  models.setProvider(provider);
  return { provider, models };
}

function harness(storage: MemoryStorage, models: ReturnType<typeof createModels>, tools: AgentTool[] = [], extra: { maxTokens?: number } = {}) {
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

function tool(name: string, execute: AgentTool["execute"], replay: "safe" | "never" = "never"): AgentTool {
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
  const texts = (await lane.entries()).map((entry) => (entry.payload.type === "message" ? messageText(entry.payload.message) : entry.payload.summary));
  assert.deepEqual(texts, ["go", "", "echoed", "finished"]);
});

test("parallel tool results materialize in source order", async () => {
  const finished: string[] = [];
  const { models } = scripted([
    fauxAssistant([fauxToolCall("slow", {}, "call_slow"), fauxToolCall("fast", {}, "call_fast")]),
    fauxAssistant("done"),
  ]);
  const make = (name: string, delay: number): AgentTool =>
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
    results.map((entry) => (entry.payload.type === "message" ? messageText(entry.payload.message) : "")),
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
    streamSimple(active, _context, options) {
      calls += 1;
      const stream = createAssistantEventStream();
      const message = baseAssistant(active, [{ type: "text", text: "partial-answer" }], "stop");
      void (async () => {
        stream.push({ type: "text_delta", delta: "partial-answer", partial: { ...message, stopReason: "pending" } });
        await gate;
        if (options.signal.aborted) {
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
  assert.equal(messageText(assistant.payload.message), "partial-answer");
  const operationLeft = await storage.read((view) => view.values().some((item) => item.key.includes("pi.op.state")));
  assert.equal(operationLeft, false);
  const resultLeft = await storage.read((view) => view.values().some((item) => item.key.includes("pi.result")));
  assert.equal(resultLeft, true);
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
  assert.match(messageText(toolEntry.payload.message), /deleted 1/);
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
  assert.equal(toolEntry && toolEntry.payload.type === "message" ? messageText(toolEntry.payload.message) : "", "reread");
});

test("overflow compacts once and a second overflow fails the run", async () => {
  const { provider, models } = scripted([
    fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" }),
    fauxAssistant("summary"),
    fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" }),
  ]);
  const lane = harness(new MemoryStorage(), models, [], { maxTokens: 100_000 }).lane();
  const result = await lane.prompt("too much");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /repeated/);
  assert.equal(provider.state.callCount, 3);
  assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), true);
});

test("threshold compaction replaces older context before the answer", async () => {
  const seen: string[] = [];
  const provider = fauxProvider({
    respond: (context, _options, state) => {
      seen.push(context.messages.map((message) => messageText(message)).join("|"));
      return fauxAssistant(state.callCount === 1 ? "short" : "answer");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const lane = harness(new MemoryStorage(), models, [], { maxTokens: 20 }).lane();
  const result = await lane.prompt("x".repeat(200));
  assert.equal(result.status, "completed");
  assert.equal(provider.state.callCount, 2);
  assert.equal(seen[1]?.includes("x".repeat(200)), false);
  assert.match(seen[1] ?? "", /short/);
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
  const texts = (await reloaded.entries()).map((entry) => (entry.payload.type === "message" ? messageText(entry.payload.message) : ""));
  assert.deepEqual(texts, ["save", "persisted"]);
  const info = await reloaded.inspect();
  assert.equal(info.phase, null);
  assert.ok(info.lastOperationId);
});
