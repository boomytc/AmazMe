import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, createProvider, messageText, type Model } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { completionsProvider } from "@amazme/ai/providers/completions";
import {
  AgentHarness,
  effectiveInputThreshold,
  keepRecentBudget,
  outputReserve,
  summaryOutputLimit,
  type Entry,
  type HarnessTool,
  type Storage,
} from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";

const secret = "SU1HU0VDUkVUREFUQQ==";

function textOf(entry: Entry): string {
  if (entry.payload.type === "compaction") return entry.payload.summary;
  const message = entry.payload.message;
  return message.role === "custom" ? message.content : messageText(message);
}

function sse(text: string, finish = "stop"): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ finish_reason: finish }] })}`,
    "",
    `data: ${JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolSse(): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "call_keep", function: { name: "work", arguments: "{}" } },
    ] } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}`,
    "",
    `data: ${JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function overflow(): Response {
  return new Response(JSON.stringify({
    error: { type: "invalid_request_error", code: "context_length_exceeded", message: "maximum context length exceeded" },
  }), { status: 400, headers: { "content-type": "application/json" } });
}

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
  return {
    id: "compact",
    name: "compact",
    provider: "wire",
    api: "openai-completions",
    input: ["text", "image"],
    contextWindow: 8000,
    maxTokens: 1000,
    cost: { input: 0, output: 0 },
    ...overrides,
  };
}

function wire(options: {
  model?: Model<"openai-completions">;
  responses: Array<() => Response>;
  tools?: HarnessTool[];
  compaction: { enabled: boolean; maxTokens: number };
  maxTokens?: number;
  systemPrompt?: string;
  storage?: Storage;
}) {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const active = options.model ?? model();
  const models = createModels({ env: { OPENAI_API_KEY: "sk-test" } });
  models.setProvider(createProvider({
    id: "wire",
    baseUrl: "https://example.test/v1",
    auth: { env: "OPENAI_API_KEY" },
    models: [active],
    api: openaiCompletionsApi({
      fetch: async (_input, init) => {
        const response = options.responses[calls];
        calls += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (!response) throw new Error(`unexpected request ${calls}`);
        return response();
      },
    }),
  }));
  const runtime = new AgentHarness(options.storage ?? new MemoryStorage(), {
    models,
    model: { provider: "wire", modelId: active.id },
    tools: options.tools,
    systemPrompt: options.systemPrompt ?? "",
    compaction: options.compaction,
    maxAttempts: 2,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  });
  return { runtime, bodies, calls: () => calls };
}

function outputFields(body: Record<string, unknown>): string[] {
  return ["max_completion_tokens", "max_tokens"].filter((key) => Object.hasOwn(body, key));
}

function workTool(execute: HarnessTool["execute"]): HarnessTool {
  return {
    name: "work",
    description: "work",
    parameters: { type: "object", additionalProperties: true },
    execute,
  };
}

test("reserve, keep, and summary caps scale with the window", () => {
  assert.equal(outputReserve(200), 32);
  assert.equal(outputReserve(128_000), 4_096);
  assert.equal(effectiveInputThreshold(200, 10_000), 136);
  assert.equal(keepRecentBudget(200, 136), 64);
  assert.equal(keepRecentBudget(128_000, 80_000), 8_192);
  assert.equal(summaryOutputLimit(50, 200), 32);
});

test("a small window still sends a short prompt when automatic compaction is off", async () => {
  const session = wire({
    model: model({ contextWindow: 200, maxTokens: 50, input: ["text"] }),
    responses: [() => sse("ok")],
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const result = await session.runtime.lane().prompt("hi");
    assert.equal(result.status, "completed");
    assert.equal(session.calls(), 1);
    assert.deepEqual(outputFields(session.bodies[0] ?? {}), ["max_completion_tokens"]);
    assert.equal(session.bodies[0]?.max_completion_tokens, 50);
  } finally {
    session.runtime.close();
  }
});

test("server overflow compacts through chat completions and continues with the current input", async () => {
  const old = "O".repeat(5_000);
  let steered = false;
  const session = wire({
    responses: [
      () => sse("kept the file"),
      () => toolSse(),
      () => overflow(),
      () => sse("folded the old goal"),
      () => sse("continued"),
    ],
    tools: [workTool(async () => {
      if (!steered) {
        steered = true;
        await session.runtime.lane().steer("CURRENT_INPUT");
      }
      return { content: [{ type: "text", text: "worked" }] };
    })],
    compaction: { enabled: true, maxTokens: 7_000 },
    maxTokens: 64,
    systemPrompt: "lane rules",
  });
  try {
    const lane = session.runtime.lane();
    const queued = await lane.steer({
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: secret }],
      timestamp: 1,
    });
    assert.equal(queued.ok, true);
    assert.equal((await lane.prompt(old)).status, "completed");
    const result = await lane.prompt("use the tool");
    assert.equal(result.status, "completed");
    assert.equal(session.calls(), 5);
    for (const body of session.bodies) assert.deepEqual(outputFields(body), ["max_completion_tokens"]);
    assert.equal(session.bodies[0]?.max_completion_tokens, 64);
    assert.equal(session.bodies[1]?.max_completion_tokens, 64);
    assert.equal(session.bodies[2]?.max_completion_tokens, 64);
    const summary = JSON.stringify(session.bodies[3]);
    assert.equal(session.bodies[3]?.max_completion_tokens, 250);
    assert.equal(Object.hasOwn(session.bodies[3] ?? {}, "tools"), false);
    assert.equal(Object.hasOwn(session.bodies[3] ?? {}, "reasoning_effort"), false);
    assert.match(summary, /\[Image attachment\]/);
    assert.match(summary, /\[System\]/);
    assert.match(summary, /lane rules/);
    assert.match(summary, /OOOO/);
    assert.equal(summary.includes(secret), false);
    const continued = JSON.stringify(session.bodies[4]);
    assert.equal(session.bodies[4]?.max_completion_tokens, 64);
    assert.match(continued, /CURRENT_INPUT/);
    assert.match(continued, /call_keep/);
    assert.match(continued, /worked/);
    assert.match(continued, /"name":"work"/);
    assert.equal(continued.includes(old), false);
    assert.equal(continued.includes(secret), false);
    const stored = await session.runtime.storage.read((view) => view.entries());
    const image = stored.find((entry) => entry.payload.type === "message"
      && entry.payload.message.role === "user"
      && Array.isArray(entry.payload.message.content)
      && entry.payload.message.content.some((block) => block.type === "image"));
    assert.equal(image?.payload.type === "message"
      && image.payload.message.role === "user"
      && Array.isArray(image.payload.message.content)
      && image.payload.message.content.some((block) => block.type === "image" && block.data === secret), true);
    const usage = await session.runtime.storage.read((view) => view.usageRows());
    assert.equal(usage.length, session.calls());
    assert.equal((await lane.entries()).filter((entry) => entry.payload.type === "compaction").length, 1);
  } finally {
    session.runtime.close();
  }
});

test("disabled automatic compaction fails a server overflow without a summary call", async () => {
  const session = wire({
    responses: [() => overflow(), () => sse("should not run")],
    compaction: { enabled: false, maxTokens: 7_000 },
    maxTokens: 64,
  });
  try {
    const result = await session.runtime.lane().prompt("hello");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /compaction is disabled/);
    assert.equal(session.calls(), 1);
    assert.equal((await session.runtime.lane().entries()).some((entry) => entry.payload.type === "compaction"), false);
  } finally {
    session.runtime.close();
  }
});

test("an oversized current input fails before fetch", async () => {
  const session = wire({
    model: model({ contextWindow: 200, maxTokens: 50, input: ["text"] }),
    responses: [() => sse("no")],
    compaction: { enabled: true, maxTokens: 50 },
  });
  try {
    const result = await session.runtime.lane().prompt("Q".repeat(2_000));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Current input, system prompt, and tool definitions cannot fit/);
    assert.equal(session.calls(), 0);
    assert.equal((await session.runtime.lane().entries()).some((entry) => entry.payload.type === "compaction"), false);
  } finally {
    session.runtime.close();
  }
});

test("an oversized tool schema fails before fetch and the error omits the schema text", async () => {
  const marker = "SCHEMASECRET";
  const session = wire({
    model: model({ contextWindow: 200, maxTokens: 50, input: ["text"] }),
    responses: [() => sse("no")],
    compaction: { enabled: true, maxTokens: 50 },
    tools: [{
      name: "work",
      description: marker.repeat(80),
      parameters: { type: "object" },
      execute: async () => ({ content: [] }),
    }],
  });
  try {
    const result = await session.runtime.lane().prompt("hi");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /cannot fit/);
    assert.equal((result.error ?? "").includes(marker), false);
    assert.equal(session.calls(), 0);
  } finally {
    session.runtime.close();
  }
});

test("a huge old tool result is shortened in the summary request and kept intact in the tree", async () => {
  const blob = "T".repeat(20_000);
  const session = wire({
    model: model({ contextWindow: 2_000, maxTokens: 200, input: ["text"] }),
    responses: [() => toolSse(), () => sse("folded tool"), () => sse("continued")],
    tools: [workTool(async () => {
      await session.runtime.lane().steer("CURRENT_KEEP");
      return { content: [{ type: "text", text: blob }] };
    })],
    compaction: { enabled: true, maxTokens: 10_000 },
    maxTokens: 32,
    systemPrompt: "keep the goal",
  });
  try {
    const result = await session.runtime.lane().prompt("start");
    assert.equal(result.status, "completed");
    assert.equal(session.calls(), 3);
    const summary = JSON.stringify(session.bodies[1]);
    const continued = JSON.stringify(session.bodies[2]);
    assert.match(summary, /\[truncated\]/);
    assert.equal(summary.includes(blob), false);
    assert.match(summary, /\[ToolResult id=call_keep name=work\]/);
    assert.equal(session.bodies[1]?.max_completion_tokens, 62);
    assert.equal(Object.hasOwn(session.bodies[1] ?? {}, "tools"), false);
    assert.match(continued, /CURRENT_KEEP/);
    assert.equal(continued.includes(blob), false);
    assert.equal(session.bodies[2]?.max_completion_tokens, 32);
    const stored = await session.runtime.storage.read((view) => view.entries());
    assert.equal(stored.some((entry) => textOf(entry) === blob), true);
  } finally {
    session.runtime.close();
  }
});

test("an unusable summary fails without publishing it or moving the source tip", async () => {
  const session = wire({
    model: model({ contextWindow: 2_000, maxTokens: 200, input: ["text"] }),
    responses: [() => sse("short"), () => sse("S".repeat(20_000))],
    compaction: { enabled: true, maxTokens: 30 },
    maxTokens: 32,
  });
  try {
    const lane = session.runtime.lane();
    assert.equal((await lane.prompt("Y".repeat(200))).status, "completed");
    const result = await lane.prompt("CURRENT");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /cannot fit/);
    assert.equal(session.calls(), 2);
    const entries = await lane.entries();
    assert.equal(entries.filter((entry) => entry.payload.type === "compaction").length, 0);
    const current = entries.find((entry) => textOf(entry) === "CURRENT");
    assert.equal(result.tipId, current?.id);
    assert.equal((await lane.inspect()).tipId, current?.id);
    assert.equal(await session.runtime.storage.read((view) => view.usageRows().length), 2);
  } finally {
    session.runtime.close();
  }
});

test("manual compaction rejects an oversized pending user before calling the summarizer", async () => {
  const session = wire({
    model: model({ contextWindow: 2_000, maxTokens: 200, input: ["text"] }),
    responses: [() => sse("seeded"), () => sse("old goal")],
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const lane = session.runtime.lane();
    assert.equal((await lane.prompt("seed goal")).status, "completed");
    assert.equal((await lane.prompt("P".repeat(10_000))).status, "failed");
    const before = await lane.entries();
    const tip = (await lane.inspect()).tipId;
    const admitted = await lane.accept({ kind: "compaction" });
    assert.ok(admitted.ok);
    const outcome = await lane.drive(admitted.value.operationId);
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    assert.equal(outcome.value.result.status, "failed");
    assert.match(outcome.value.result.error ?? "", /cannot fit/);
    assert.equal(session.calls(), 1);
    assert.deepEqual(await lane.entries(), before);
    assert.equal((await lane.inspect()).tipId, tip);
  } finally {
    session.runtime.close();
  }
});

for (const boundary of ["finish", "navigation"] as const) {
  test(`${boundary} rejects an oversized summary while retaining the source branch and usage`, async () => {
    const session = wire({
      model: model({ contextWindow: 2_000, maxTokens: 200, input: ["text"] }),
      responses: [() => sse("seeded"), () => sse("S".repeat(20_000))],
      compaction: { enabled: false, maxTokens: 80_000 },
    });
    try {
      const lane = session.runtime.lane();
      assert.equal((await lane.prompt("seed goal")).status, "completed");
      const before = await lane.entries();
      const tip = (await lane.inspect()).tipId;
      const admitted = await lane.accept(boundary === "finish" ? { kind: "compaction" }
        : { kind: "navigation", targetId: null, summarize: true });
      assert.ok(admitted.ok);
      const outcome = await lane.drive(admitted.value.operationId);
      assert.ok(outcome.ok && outcome.value.kind === "settled");
      assert.equal(outcome.value.result.status, "failed");
      assert.match(outcome.value.result.error ?? "", /cannot fit/);
      assert.equal(session.calls(), 2);
      assert.deepEqual(await lane.entries(), before);
      assert.equal((await lane.inspect()).tipId, tip);
      assert.equal(await session.runtime.storage.read(view => view.usageRows().length), 2);
    } finally {
      session.runtime.close();
    }
  });
}

test("manual compaction merges an older summary and a second compact with nothing new fails", async () => {
  const seen: string[] = [];
  const provider = fauxProvider({
    respond: (context, options, state) => {
      seen.push(context.messages.map((message) => messageText(message)).join("\n"));
      if (state.callCount === 2 || state.callCount === 4) {
        assert.equal(context.tools?.length ?? 0, 0);
        assert.equal(options.thinkingLevel, "off");
        assert.ok((options.maxTokens ?? 0) > 0);
        return fauxAssistant(state.callCount === 2 ? "first fold" : "second fold");
      }
      return fauxAssistant(state.callCount === 1 ? "seeded" : "answered");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "sys",
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const lane = runtime.lane();
    assert.equal((await lane.prompt("seed goal")).status, "completed");
    const first = await lane.accept({ kind: "compaction" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const folded = await lane.drive(first.value.operationId);
    assert.equal(folded.ok && folded.value.kind === "settled" ? folded.value.result.status : "", "completed");
    assert.match(seen[1] ?? "", /\[User\]/);
    assert.match(seen[1] ?? "", /seed goal/);
    assert.equal((await lane.prompt("new goal")).status, "completed");
    const second = await lane.accept({ kind: "compaction" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const merged = await lane.drive(second.value.operationId);
    assert.equal(merged.ok && merged.value.kind === "settled" ? merged.value.result.status : "", "completed");
    assert.match(seen[3] ?? "", /\[Previous summary\]/);
    assert.match(seen[3] ?? "", /first fold/);
    assert.match(seen[3] ?? "", /new goal/);
    const third = await lane.accept({ kind: "compaction" });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    const empty = await lane.drive(third.value.operationId);
    assert.equal(empty.ok && empty.value.kind === "settled" ? empty.value.result.status : "", "failed");
    assert.match(empty.ok && empty.value.kind === "settled" ? empty.value.result.error ?? "" : "", /nothing to compact/);
    assert.equal((await lane.entries()).filter((entry) => entry.payload.type === "compaction").length, 2);
    assert.equal(provider.state.callCount, 4);
  } finally {
    runtime.close();
  }
});

test("manual compaction of a failed short turn leaves the user verbatim", async () => {
  const provider = fauxProvider({
    respond: () => fauxAssistant("nope", { stopReason: "error", errorMessage: "model error" }),
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const lane = runtime.lane();
    assert.equal((await lane.prompt("short goal")).status, "failed");
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "failed");
    assert.match(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error ?? "" : "", /nothing to compact/);
    const entries = await lane.entries();
    assert.equal(entries.some((entry) => entry.payload.type === "compaction"), false);
    const pending = entries.find((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
    assert.equal(pending?.payload.type === "message" && pending.payload.message.role === "user" ? pending.payload.message.content : "", "short goal");
    assert.equal(provider.state.callCount, 1);
  } finally {
    runtime.close();
  }
});

test("manual compaction does not truncate one oversized pending user", async () => {
  const pending = "P".repeat(2_000);
  let calls = 0;
  const models = createModels({ env: { COMPAT_KEY: "sk-test" } });
  models.setProvider(completionsProvider({
    id: "compat",
    name: "compat",
    baseUrl: "https://example.test/v1",
    env: "COMPAT_KEY",
    fetch: async () => {
      calls += 1;
      throw new Error("fetch should not run");
    },
    modelIds: ["small"],
    models: { small: { contextWindow: 200, maxTokens: 32, input: ["text"] } },
  }));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "compat", modelId: "small" },
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const lane = runtime.lane();
    const prompt = await lane.prompt(pending);
    assert.equal(prompt.status, "failed");
    assert.match(prompt.error ?? "", /cannot fit/);
    assert.equal(calls, 0);
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "failed");
    assert.match(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error ?? "" : "", /cannot fit/);
    assert.equal(calls, 0);
    const entries = await lane.entries();
    assert.equal(entries.some((entry) => entry.payload.type === "compaction"), false);
    const stored = entries.find((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
    assert.equal(stored?.payload.type === "message" && stored.payload.message.role === "user" ? stored.payload.message.content : "", pending);
  } finally {
    runtime.close();
  }
});

test("manual compaction keeps a later unanswered user and summarizes the earlier turn", async () => {
  const seen: string[] = [];
  const provider = fauxProvider({
    respond: (context, _options, state) => {
      seen.push(context.messages.map((message) => messageText(message)).join("\n"));
      if (state.callCount === 2) return fauxAssistant("nope", { stopReason: "error", errorMessage: "model error" });
      if (state.callCount === 3) return fauxAssistant("folded the seed");
      return fauxAssistant("answered");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const lane = runtime.lane();
    assert.equal((await lane.prompt("seed goal")).status, "completed");
    assert.equal((await lane.prompt("PENDING_EXACT")).status, "failed");
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.match(seen[2] ?? "", /seed goal/);
    assert.equal((seen[2] ?? "").includes("PENDING_EXACT"), false);
    const entries = await lane.entries();
    const summary = entries.find((entry) => entry.payload.type === "compaction");
    assert.equal(summary?.payload.type === "compaction" ? summary.payload.summary : "", "folded the seed");
    const tip = entries.at(-1);
    assert.equal(tip?.id, (await lane.inspect()).tipId);
    assert.equal(tip?.parentId, summary?.id ?? null);
    assert.equal(tip ? textOf(tip) : "", "PENDING_EXACT");
    const stored = await runtime.storage.read((view) => view.entries());
    const original = stored.filter((entry) => entry.id !== tip?.id && textOf(entry) === "PENDING_EXACT");
    assert.equal(original.length, 1);
    assert.equal(provider.state.callCount, 3);
  } finally {
    runtime.close();
  }
});

test("navigation summary attaches to the target, including null, without copying the left branch", async () => {
  for (const targetNull of [false, true]) {
    const provider = fauxProvider({
      respond: (_context, _options, state) => fauxAssistant(state.callCount === 1 ? "seeded" : "left the branch"),
    });
    const models = createModels();
    models.setProvider(provider);
    const runtime = new AgentHarness(new MemoryStorage(), {
      models,
      model: { provider: "faux", modelId: "faux-1" },
      compaction: { enabled: false, maxTokens: 80_000 },
    });
    try {
      const lane = runtime.lane();
      await lane.prompt("stay");
      const before = await runtime.storage.read((view) => view.entries());
      const target = targetNull ? null : before[0]?.id ?? null;
      const targetPayload = target ? before.find((entry) => entry.id === target)?.payload : undefined;
      const admitted = await lane.accept({ kind: "navigation", targetId: target, summarize: true });
      assert.equal(admitted.ok, true);
      if (!admitted.ok) continue;
      const outcome = await lane.drive(admitted.value.operationId);
      assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
      const stored = await runtime.storage.read((view) => view.entries());
      assert.equal(stored.length, before.length + 1);
      const summary = stored.find((entry) => entry.payload.type === "compaction");
      assert.equal(summary?.parentId ?? null, target);
      assert.equal((await lane.inspect()).tipId, summary?.id ?? null);
      if (target && targetPayload) {
        assert.deepEqual(stored.find((entry) => entry.id === target)?.payload, targetPayload);
        assert.equal(stored.filter((entry) => entry.parentId === target && entry.payload.type !== "compaction").length, 1);
      }
      assert.equal(stored.filter((entry) => entry.parentId === summary?.id).length, 0);
    } finally {
      runtime.close();
    }
  }
});

test("empty, truncated, and tool-call summaries are not published", async () => {
  const cases = [
    { name: "empty", message: fauxAssistant(""), error: /empty/ },
    { name: "length", message: fauxAssistant("cut off", { stopReason: "length" }), error: /truncated/ },
    { name: "tool", message: fauxAssistant([fauxToolCall("work", {})]), error: /tool/ },
  ];
  for (const item of cases) {
    const provider = fauxProvider({
      respond: (_context, _options, state) => (state.callCount === 1 ? fauxAssistant("seed") : item.message),
    });
    const models = createModels();
    models.setProvider(provider);
    const runtime = new AgentHarness(new MemoryStorage(), {
      models,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [workTool(async () => ({ content: [] }))],
      compaction: { enabled: false, maxTokens: 80_000 },
    });
    try {
      const lane = runtime.lane();
      await lane.prompt("seed");
      const admitted = await lane.accept({ kind: "compaction" });
      assert.equal(admitted.ok, true, item.name);
      if (!admitted.ok) continue;
      const outcome = await lane.drive(admitted.value.operationId);
      assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "failed", item.name);
      assert.match(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error ?? "" : "", item.error, item.name);
      assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), false, item.name);
      assert.equal(await runtime.storage.read((view) => view.usageRows().length), 2, item.name);
      assert.equal(provider.state.callCount, 2, item.name);
    } finally {
      runtime.close();
    }
  }
});

test("a summary that returns after cancel is not published", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = fauxProvider({
    respond: async (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant("seed");
      await gate;
      return fauxAssistant("too late");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    compaction: { enabled: false, maxTokens: 80_000 },
  });
  try {
    const lane = runtime.lane();
    await lane.prompt("seed");
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const driving = lane.drive(admitted.value.operationId);
    const start = Date.now();
    while (provider.state.callCount < 2 && Date.now() - start < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(provider.state.callCount, 2);
    const cancelled = await lane.requestAbort(admitted.value.operationId);
    assert.equal(cancelled.ok, true);
    release();
    const outcome = await driving;
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "aborted");
    assert.equal((await lane.entries()).some((entry) => entry.payload.type === "compaction"), false);
    assert.equal(await runtime.storage.read((view) => view.usageRows().length), 2);
    assert.equal(provider.state.callCount, 2);
  } finally {
    runtime.close();
  }
});

test("a steer arriving during summary is delivered once on the next request", async () => {
  const seen: string[] = [];
  let lane: ReturnType<AgentHarness["lane"]> | undefined;
  const provider = fauxProvider({
    respond: async (context, options, state) => {
      seen.push(context.messages.map((message) => messageText(message)).join("|"));
      if (state.callCount === 1) return fauxAssistant("older");
      if (state.callCount === 2) return fauxAssistant("", { stopReason: "error", overflow: true, errorMessage: "context length" });
      if (state.callCount === 3) {
        assert.equal(context.tools?.length ?? 0, 0);
        assert.equal(options.thinkingLevel, "off");
        await lane?.steer("DURING_SUMMARY");
        return fauxAssistant("folded");
      }
      return fauxAssistant("next");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "sys",
    compaction: { enabled: true, maxTokens: 100_000 },
  });
  lane = runtime.lane();
  try {
    assert.equal((await lane.prompt("O".repeat(36_000))).status, "completed");
    const result = await lane.prompt("CURRENT_INPUT");
    assert.equal(result.status, "completed");
    assert.equal(seen.filter((text) => text.includes("DURING_SUMMARY")).length, 1);
    assert.equal(seen[2]?.includes("DURING_SUMMARY") ?? false, false);
    assert.equal(seen[3]?.includes("DURING_SUMMARY") ?? false, false);
    assert.equal(seen[4]?.includes("DURING_SUMMARY"), true);
    const copies = (await runtime.storage.read((view) => view.entries())).filter((entry) => textOf(entry) === "DURING_SUMMARY");
    assert.equal(copies.length, 1);
  } finally {
    runtime.close();
  }
});

test("memory and jsonl keep the same compacted chain", async () => {
  async function project(storage: Storage): Promise<Array<{ kind: string; text: string }>> {
    const provider = fauxProvider({
      respond: (_context, _options, state) => {
        if (state.callCount === 2) return fauxAssistant("folded");
        return fauxAssistant(state.callCount === 1 ? "short" : "answer");
      },
    });
    const models = createModels();
    models.setProvider(provider);
    const runtime = new AgentHarness(storage, {
      models,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "sys",
      compaction: { enabled: true, maxTokens: 20 },
    });
    try {
      const lane = runtime.lane();
      assert.equal((await lane.prompt("Y".repeat(200))).status, "completed");
      assert.equal((await lane.prompt("CURRENT_QUESTION")).status, "completed");
      const entries = await lane.entries();
      return entries.map((entry, index) => ({
        kind: entry.payload.type === "compaction" ? "compaction" : entry.payload.message.role,
        text: textOf(entry),
        follows: index === 0 ? "root" : entries[index - 1]?.id === entry.parentId ? "parent" : "gap",
      })).map(({ kind, text, follows }) => ({ kind, text: `${follows}:${text}` }));
    } finally {
      runtime.close();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "amazme-compact-"));
  try {
    const memory = await project(new MemoryStorage());
    const file = join(dir, "lane.jsonl");
    const jsonl = await project(new JsonlStorage(file));
    assert.deepEqual(jsonl, memory);
    const visible = memory.slice(memory.findIndex((item) => item.kind === "compaction"));
    assert.equal(visible.some((item) => item.kind === "compaction" && item.text.includes("folded")), true);
    assert.equal(visible.some((item) => item.text.includes("CURRENT_QUESTION")), true);
    assert.equal(visible.some((item) => item.text.includes("Y".repeat(200))), false);
    const reloaded = new AgentHarness(new JsonlStorage(file), {
      models: createModels(),
      model: { provider: "faux", modelId: "faux-1" },
    });
    try {
      const entries = await reloaded.lane().entries();
      assert.deepEqual(entries.map((entry, index) => ({
        kind: entry.payload.type === "compaction" ? "compaction" : entry.payload.message.role,
        text: textOf(entry),
        follows: index === 0 ? "root" : entries[index - 1]?.id === entry.parentId ? "parent" : "gap",
      })).map(({ kind, text, follows }) => ({ kind, text: `${follows}:${text}` })), jsonl);
    } finally {
      reloaded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
