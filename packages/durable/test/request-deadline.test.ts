import assert from "node:assert/strict";
import test from "node:test";
import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  messageText,
  type Model,
  type Provider,
} from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import {
  AgentHarness,
  armRequestDeadline,
  classifyDeadline,
  retryDelayMs,
  storedRequestPolicy,
  value,
  type HarnessOptions,
  type RequestDeadline,
} from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

const immediate: { baseDelayMs: number; maxDelayMs: number } = { baseDelayMs: 0, maxDelayMs: 0 };

test("retryDelayMs doubles a stored base and caps it", () => {
  const policy = { baseDelayMs: 400, maxDelayMs: 1_000 };
  assert.equal(retryDelayMs(policy, 1), 400);
  assert.equal(retryDelayMs(policy, 2), 800);
  assert.equal(retryDelayMs(policy, 3), 1_000);
  assert.equal(retryDelayMs({ baseDelayMs: 0, maxDelayMs: 60_000 }, 4), 0);
});

test("classifyDeadline retries only a pre-frame timeout", () => {
  assert.deepEqual(classifyDeadline({ timedOut: true, cancelRequested: false, contentFrames: 0 }), { kind: "retryable_timeout" });
  assert.deepEqual(classifyDeadline({ timedOut: true, cancelRequested: false, contentFrames: 1 }), { kind: "interrupted" });
  assert.deepEqual(classifyDeadline({ timedOut: true, cancelRequested: true, contentFrames: 0 }), { kind: "unchanged" });
  assert.deepEqual(classifyDeadline({ timedOut: false, cancelRequested: false, contentFrames: 0 }), { kind: "unchanged" });
});

test("armRequestDeadline fires without counting a caller abort as timeout", async () => {
  const parent = new AbortController();
  const waiting = armRequestDeadline(60_000, parent.signal);
  parent.abort();
  assert.equal(waiting.signal.aborted, true);
  assert.equal(waiting.timedOut(), false);
  waiting.dispose();

  const open = new AbortController();
  const deadline = armRequestDeadline(0, open.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deadline.timedOut(), true);
  assert.equal(deadline.signal.aborted, true);
  deadline.dispose();
});

test("a stored lane config without a deadline fails closed", () => {
  assert.throws(() => storedRequestPolicy({}), /no request deadline/);
});

test("a retryable model error stores notBefore from the lane policy and does not resend yet", async () => {
  const provider = fauxProvider({
    respond: () => fauxAssistant("later", { stopReason: "error", retryable: true, errorMessage: "later" }),
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    maxAttempts: 3,
    retry: { baseDelayMs: 400, maxDelayMs: 1_000 },
  });
  try {
    const admitted = await runtime.lane().accept({ kind: "prompt", text: "go" });
    assert.ok(admitted.ok);
    const before = Date.now();
    const outcome = await runtime.lane().drive(admitted.value.operationId);
    const after = Date.now();
    assert.equal(provider.state.callCount, 1);
    assert.ok(outcome.ok && outcome.value.kind === "waiting");
    assert.equal(outcome.value.reason, "retry");
    assert.ok(outcome.value.notBefore >= before + 400 && outcome.value.notBefore <= after + 400);
    const state = await runtime.storage.read((view) => view.get<{ phase: string; notBefore: number }>(value("pi.op.state", admitted.value.operationId)));
    assert.equal(state?.phase, "retry_wait");
    assert.equal(state?.notBefore, outcome.value.notBefore);
  } finally {
    runtime.close();
  }
});

test("a deadline before any content frame is one retryable resend", async () => {
  let calls = 0;
  const seenRoles: string[][] = [];
  let markTimedOut: (() => void) | undefined;
  const provider = scriptedProvider(() => {
    calls += 1;
    return calls === 1 ? { mode: "timeout", markTimedOut: () => markTimedOut?.() } : { mode: "text", text: "done" };
  }, (roles) => seenRoles.push(roles));
  let attempts = 0;
  const runtime = harness(provider, {
    maxAttempts: 2,
    requestTimeoutMs: 2_222,
    retry: immediate,
    armDeadline(timeoutMs, parent) {
      attempts += 1;
      assert.equal(timeoutMs, 2_222);
      const deadline = follow(parent);
      if (attempts === 1) markTimedOut = () => deadline.mark();
      return deadline;
    },
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed", result.error ?? "");
    assert.equal(calls, 2);
    assert.equal(attempts, 2);
    const assistants = await assistantsOf(runtime);
    assert.deepEqual(assistants.map((message) => message.stopReason), ["error", "stop"]);
    assert.equal(assistants[0]?.retryable, true);
    assert.equal(assistants[0]?.errorMessage, "model request timed out");
    assert.equal(messageText(assistants[1]!), "done");
    assert.deepEqual(seenRoles[1], ["user"]);
  } finally {
    runtime.close();
  }
});

test("a pre-frame deadline with no attempts left fails once and does not resend", async () => {
  let calls = 0;
  let markTimedOut: (() => void) | undefined;
  const provider = scriptedProvider(() => {
    calls += 1;
    return { mode: "timeout", markTimedOut: () => markTimedOut?.() };
  });
  const runtime = harness(provider, {
    maxAttempts: 1,
    retry: immediate,
    armDeadline(_timeoutMs, parent) {
      const deadline = follow(parent);
      markTimedOut = () => deadline.mark();
      return deadline;
    },
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "failed");
    assert.equal(result.error, "model request timed out");
    assert.equal(calls, 1);
  } finally {
    runtime.close();
  }
});

test("a deadline after content frames does not resend or execute frame-only tool calls", async () => {
  let calls = 0;
  let runs = 0;
  const seen: number[] = [];
  let markTimedOut: (() => void) | undefined;
  const provider = scriptedProvider(() => {
    calls += 1;
    return { mode: "tool-then-timeout", markTimedOut: () => markTimedOut?.() };
  });
  const runtime = harness(provider, {
    maxAttempts: 3,
    requestTimeoutMs: 2_222,
    retry: immediate,
    tools: [{
      name: "work",
      description: "work",
      parameters: { type: "object" },
      replay: "never",
      async execute() {
        runs += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
    }],
    armDeadline(timeoutMs, parent) {
      seen.push(timeoutMs);
      const deadline = follow(parent);
      markTimedOut = () => {
        deadline.mark();
      };
      return deadline;
    },
  });
  try {
    const admitted = await runtime.lane().accept({ kind: "prompt", text: "go" });
    assert.ok(admitted.ok);
    const outcome = await runtime.lane().drive(admitted.value.operationId, { waitForRetry: true });
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    assert.equal(outcome.value.result.status, "aborted");
    assert.equal(outcome.value.result.error, "model request timed out after output started");
    assert.equal(calls, 1);
    assert.equal(runs, 0);
    assert.deepEqual(seen, [2_222]);
    const assistants = await assistantsOf(runtime);
    assert.equal(assistants.length, 1);
    assert.equal(messageText(assistants[0]!), "partial");
    assert.equal(assistants[0]?.content.some((block) => block.type === "toolCall"), false);
  } finally {
    runtime.close();
  }
});

test("requestAbort is not a timeout resend and does not execute the tool", async () => {
  let calls = 0;
  let runs = 0;
  let ready: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const provider = scriptedProvider(() => {
    calls += 1;
    return { mode: "wait-abort", ready: () => ready?.() };
  });
  const runtime = harness(provider, {
    maxAttempts: 3,
    retry: { baseDelayMs: 30_000, maxDelayMs: 30_000 },
    tools: [{
      name: "work",
      description: "work",
      parameters: { type: "object" },
      replay: "never",
      async execute() {
        runs += 1;
        return { content: [] };
      },
    }],
  });
  try {
    const admitted = await runtime.lane().accept({ kind: "prompt", text: "go" });
    assert.ok(admitted.ok);
    const drive = runtime.lane().drive(admitted.value.operationId, { waitForRetry: true });
    await started;
    const aborted = await runtime.lane().requestAbort(admitted.value.operationId);
    assert.equal(aborted.ok, true);
    const outcome = await drive;
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    assert.equal(outcome.value.result.status, "aborted");
    assert.equal(calls, 1);
    assert.equal(runs, 0);
  } finally {
    ready?.();
    runtime.close();
  }
});

test("accept rejects a non-positive request deadline", async () => {
  const models = createModels();
  models.setProvider(fauxProvider());
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    requestTimeoutMs: 0,
  });
  await assert.rejects(runtime.lane().accept({ kind: "prompt", text: "go" }), /requestTimeoutMs/);
  runtime.close();
});

type Script =
  | { mode: "timeout"; markTimedOut: () => void }
  | { mode: "text"; text: string }
  | { mode: "tool-then-timeout"; markTimedOut: () => void }
  | { mode: "wait-abort"; ready: () => void };

function scriptedProvider(next: () => Script, observe?: (roles: string[]) => void): Provider {
  const model: Model = {
    id: "faux-1",
    name: "Faux",
    provider: "faux",
    api: "faux",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0 },
  };
  return {
    id: "faux",
    name: "Faux",
    auth: { apiKey: { env: "FAUX", ambient: "x" } },
    getModels: () => [model],
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    streamSimple(active, context, options) {
      observe?.(context.messages.map((message) => message.role));
      const script = next();
      const stream = createAssistantEventStream();
      void (async () => {
        if (script.mode === "wait-abort") {
          script.ready();
          await waitForAbort(options?.signal);
          const message = baseAssistant(active, [
            { type: "text", text: "partial" },
            { type: "toolCall", id: "call_work", name: "work", arguments: {} },
          ], "toolUse");
          stream.push({ type: "done", reason: "toolUse", message });
          return;
        }
        if (script.mode === "tool-then-timeout") {
          const partial = baseAssistant(active, [{ type: "text", text: "partial" }], "stop");
          stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
          const tool = { type: "toolCall" as const, id: "call_work", name: "work", arguments: { a: 1 } };
          stream.push({
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: tool,
            partial: baseAssistant(active, [{ type: "text", text: "partial" }, tool], "toolUse"),
          });
          script.markTimedOut();
          const message = baseAssistant(active, [{ type: "text", text: "partial" }, tool], "toolUse");
          stream.push({ type: "done", reason: "toolUse", message });
          return;
        }
        if (script.mode === "timeout") {
          script.markTimedOut();
          const failed = baseAssistant(active, [{ type: "text", text: "" }], "aborted");
          failed.errorMessage = "aborted";
          stream.push({ type: "error", error: failed });
          return;
        }
        if (options?.signal?.aborted) {
          const failed = baseAssistant(active, [{ type: "text", text: "" }], "aborted");
          failed.errorMessage = "aborted";
          stream.push({ type: "error", error: failed });
          return;
        }
        const message = baseAssistant(active, [{ type: "text", text: script.text }], "stop");
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    },
  };
}

function harness(provider: Provider, options: Partial<HarnessOptions>): AgentHarness {
  const models = createModels();
  models.setProvider(provider);
  return new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    ...options,
  });
}

function follow(parent: AbortSignal): RequestDeadline & { mark(): void } {
  const controller = new AbortController();
  let timedOut = false;
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", () => controller.abort(), { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut && !parent.aborted,
    dispose() {},
    mark() {
      timedOut = true;
      controller.abort();
    },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function assistantsOf(runtime: AgentHarness) {
  return runtime.storage.read((view) => view.entries().flatMap((entry) =>
    entry.payload.type === "message" && entry.payload.message.role === "assistant" ? [entry.payload.message] : []));
}
