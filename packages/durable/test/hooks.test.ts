import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHook, AgentMessage } from "@amazme/agent";
import { createModels, messageText, type Message } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";
import { AgentHarness, type Entry, type HarnessTool, type Storage, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

interface StoredCall {
  status: string;
  resultEntryId: string;
}

interface StoredOperation {
  phase: string;
  responseEntryId?: string;
  calls?: StoredCall[];
}

class StateTrace extends MemoryStorage {
  readonly toolStatuses: string[] = [];

  protected override persist(writes: Write[]): void {
    for (const write of writes) {
      if (write.type !== "set" || write.address.namespace !== "pi.op.state") continue;
      const state = write.value as { phase?: string; calls?: Array<{ status?: string }> };
      if (state.phase !== "tools" || !state.calls) continue;
      for (const call of state.calls) {
        if (call.status) this.toolStatuses.push(call.status);
      }
    }
    super.persist(writes);
  }
}

class RecoveryWatch extends MemoryStorage {
  toolResultStored = false;

  protected override persist(writes: Write[]): void {
    if (writes.some((write) => write.type === "entry" && write.payload.type === "message" && write.payload.message.role === "toolResult")) {
      this.toolResultStored = true;
    }
    super.persist(writes);
  }
}

function recordAdds(live: Set<string>): string[] {
  const added: string[] = [];
  const add = live.add.bind(live);
  live.add = (id: string) => {
    added.push(id);
    return add(id);
  };
  return added;
}

function entryText(entry: Entry): string {
  if (entry.payload.type === "compaction") return entry.payload.summary;
  const message = entry.payload.message;
  return message.role === "custom" ? message.content : messageText(message);
}

function textOf(message: Message | AgentMessage): string {
  return message.role === "custom" ? message.content : messageText(message);
}

async function operationState(storage: Storage, operationId: string): Promise<StoredOperation | undefined> {
  return storage.read((view) => {
    const found = view.values().find((item) => item.key.includes(`pi.op.state\0${operationId}`));
    return found?.value as StoredOperation | undefined;
  });
}

function modelsFor(respond: FauxResponder) {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  return { provider, models };
}

const echo: HarnessTool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute() {
    return { content: [{ type: "text", text: "original" }] };
  },
};

test("the first block skips execute, later befores, and after", async () => {
  let runs = 0;
  let secondBefore = 0;
  let afterCalls = 0;
  const storage = new StateTrace();
  const { provider, models } = modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("echo", { text: "hi" })])
    : fauxAssistant("stopped"));
  const tool: HarnessTool = { ...echo, execute: async () => { runs += 1; return { content: [{ type: "text", text: "original" }] }; } };
  const hooks: readonly AgentHook[] = [
    {
      beforeToolCall: () => ({ action: "block", reason: "not allowed" }),
      afterToolCall: () => {
        afterCalls += 1;
        return undefined;
      },
    },
    {
      beforeToolCall: () => {
        secondBefore += 1;
        return undefined;
      },
      afterToolCall: () => {
        afterCalls += 1;
        return undefined;
      },
    },
  ];
  const runtime = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    hooks,
  });
  const armed = recordAdds(runtime.live);
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(runs, 0);
    assert.equal(secondBefore, 0);
    assert.equal(afterCalls, 0);
    assert.equal(provider.state.callCount, 2);
    assert.equal(storage.toolStatuses.includes("effect_pending"), false);
    assert.equal(storage.toolStatuses.includes("outcome_ready"), true);
    const stored = (await runtime.lane().entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(stored?.payload.type === "message" && stored.payload.message.role === "toolResult");
    assert.equal(stored.payload.message.isError, true);
    assert.match(messageText(stored.payload.message), /not allowed/);
    assert.equal(armed.includes(stored.id), false);
    assert.equal(runtime.live.has(stored.id), false);
  } finally {
    runtime.close();
  }
});

test("after passes content, isError, and terminate in order", async () => {
  let seen = "";
  let seenError = false;
  let seenTerminate: boolean | undefined;
  const { provider, models } = modelsFor(() => fauxAssistant([fauxToolCall("echo", { text: "hi" })]));
  const hooks: readonly AgentHook[] = [
    {
      afterToolCall: () => ({
        content: [{ type: "text", text: "replaced-once" }],
        isError: true,
        terminate: false,
      }),
    },
    {
      afterToolCall: ({ result }) => {
        seen = result.content[0]?.text ?? "";
        seenError = result.isError === true;
        seenTerminate = result.terminate;
        return {
          content: [{ type: "text", text: `seen:${seen}` }],
          isError: true,
          terminate: true,
        };
      },
    },
  ];
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [echo],
    hooks,
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(seen, "replaced-once");
    assert.equal(seenError, true);
    assert.equal(seenTerminate, false);
    assert.equal(provider.state.callCount, 1);
    const stored = (await runtime.lane().entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(stored?.payload.type === "message" && stored.payload.message.role === "toolResult");
    assert.equal(messageText(stored.payload.message), "seen:replaced-once");
    assert.equal(stored.payload.message.isError, true);
  } finally {
    runtime.close();
  }
});

test("transform changes only the messages passed to streamSimple", async () => {
  const injected = "injected-for-model";
  const hooks: readonly AgentHook[] = [
    {
      transformContext: (messages) => [...messages, { role: "user", content: injected, timestamp: 1 }],
    },
  ];
  const { provider, models } = modelsFor((context) => (context.systemPrompt ?? "").includes("summarize")
    ? fauxAssistant("summary-kept")
    : fauxAssistant("assistant-kept"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "sys",
    hooks,
  });
  try {
    const lane = runtime.lane();
    assert.equal((await lane.prompt("seed goal")).status, "completed");
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const folded = await lane.drive(admitted.value.operationId);
    assert.equal(folded.ok && folded.value.kind === "settled" ? folded.value.result.status : "", "completed");
    assert.equal(provider.state.contexts.length, 2);
    const assistant = provider.state.contexts[0];
    const summary = provider.state.contexts[1];
    assert.ok(assistant);
    assert.ok(summary);
    assert.equal(assistant.messages.some((message) => textOf(message) === "seed goal"), true);
    assert.equal(assistant.messages.some((message) => textOf(message) === injected), true);
    assert.equal(summary.messages.some((message) => textOf(message) === injected), true);
    assert.equal(summary.messages.some((message) => textOf(message).includes("seed goal") && textOf(message).includes(injected)), false);
    const entries = await lane.entries();
    assert.equal(entries.some((entry) => entryText(entry) === injected), false);
    assert.equal(entries.some((entry) => entryText(entry) === "seed goal"), true);
    assert.equal(entries.some((entry) => entryText(entry) === "assistant-kept"), true);
    assert.equal(entries.some((entry) => entryText(entry) === "summary-kept"), true);
  } finally {
    runtime.close();
  }
});

test("before throws before the write and the next drive does not call streamSimple", async () => {
  let befores = 0;
  let executions = 0;
  let callsAtExecute = -1;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { provider, models } = modelsFor(() => fauxAssistant([fauxToolCall("echo", {})]));
  const tool: HarnessTool = {
    ...echo,
    parameters: { type: "object" },
    execute: async () => {
      executions += 1;
      callsAtExecute = provider.state.callCount;
      markStarted();
      await gate;
      return { content: [{ type: "text", text: "done" }], terminate: true };
    },
  };
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    hooks: [{
      beforeToolCall: () => {
        befores += 1;
        if (befores === 1) throw new Error("before boom");
        return undefined;
      },
    }],
  });
  try {
    const lane = runtime.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /before boom/);
    const state = await operationState(runtime.storage, admitted.value.operationId);
    assert.equal(state?.phase, "tools");
    assert.equal(state?.calls?.[0]?.status, "planned");
    assert.equal(runtime.live.has(state?.calls?.[0]?.resultEntryId ?? ""), false);
    assert.equal(provider.state.callCount, 1);
    assert.equal(executions, 0);
    assert.equal(befores, 1);
    const pending = lane.drive(admitted.value.operationId);
    await started;
    assert.equal(befores, 2);
    assert.equal(executions, 1);
    assert.equal(callsAtExecute, 1);
    assert.equal(provider.state.callCount, 1);
    release();
    const outcome = await pending;
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.equal(provider.state.callCount, 1);
  } finally {
    runtime.close();
  }
});

test("requestAbort during beforeToolCall resolves before the hook returns and does not execute", async () => {
  let executions = 0;
  let afters = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { models } = modelsFor(() => fauxAssistant([fauxToolCall("echo", { text: "hi" })]));
  const tool: HarnessTool = {
    ...echo,
    execute: async () => {
      executions += 1;
      return { content: [{ type: "text", text: "ran" }] };
    },
  };
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    hooks: [{
      beforeToolCall: async () => {
        markStarted();
        await gate;
        return undefined;
      },
      afterToolCall: () => {
        afters += 1;
        return undefined;
      },
    }],
  });
  const lane = runtime.lane();
  let pending: Promise<unknown> | undefined;
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const drive = lane.drive(admitted.value.operationId);
    pending = drive;
    await started;
    const aborting = lane.requestAbort(admitted.value.operationId);
    const winner = await Promise.race([
      aborting.then((result) => result.ok ? "abort" as const : "rejected" as const),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 300)),
    ]);
    assert.equal(winner, "abort");
    release();
    const outcome = await drive;
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "aborted");
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error : "", "cancelled");
    assert.equal(executions, 0);
    assert.equal(afters, 0);
    const stored = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(stored?.payload.type === "message" && stored.payload.message.role === "toolResult");
    assert.equal(stored.payload.message.isError, true);
    assert.equal(messageText(stored.payload.message), "cancelled");
    assert.equal(runtime.live.size, 0);
  } finally {
    release();
    await pending?.catch(() => undefined);
    runtime.close();
  }
});

test("a block returned after cancel keeps the block reason and does not execute", async () => {
  let executions = 0;
  let afters = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { models } = modelsFor(() => fauxAssistant([fauxToolCall("echo", { text: "hi" })]));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [{
      ...echo,
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
    }],
    hooks: [{
      beforeToolCall: async () => {
        markStarted();
        await gate;
        return { action: "block", reason: "not allowed" };
      },
      afterToolCall: () => {
        afters += 1;
        return undefined;
      },
    }],
  });
  const lane = runtime.lane();
  let pending: Promise<unknown> | undefined;
  try {
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const drive = lane.drive(admitted.value.operationId);
    pending = drive;
    await started;
    const aborting = lane.requestAbort(admitted.value.operationId);
    const winner = await Promise.race([
      aborting.then((result) => result.ok ? "abort" as const : "rejected" as const),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 300)),
    ]);
    assert.equal(winner, "abort");
    release();
    const outcome = await drive;
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "aborted");
    assert.equal(executions, 0);
    assert.equal(afters, 0);
    const stored = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(stored?.payload.type === "message" && stored.payload.message.role === "toolResult");
    assert.equal(messageText(stored.payload.message), "not allowed");
  } finally {
    release();
    await pending?.catch(() => undefined);
    runtime.close();
  }
});

test("a thrown tool is stored without afterToolCall", async () => {
  let afters = 0;
  const { provider, models } = modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("echo", { text: "hi" })])
    : fauxAssistant("stopped"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [{
      ...echo,
      execute: async () => {
        throw new Error("tool boom");
      },
    }],
    hooks: [{
      afterToolCall: () => {
        afters += 1;
        return undefined;
      },
    }],
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(afters, 0);
    assert.equal(provider.state.callCount, 2);
    const stored = (await runtime.lane().entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(stored?.payload.type === "message" && stored.payload.message.role === "toolResult");
    assert.equal(stored.payload.message.isError, true);
    assert.equal(messageText(stored.payload.message), "tool boom");
    assert.equal(runtime.live.size, 0);
  } finally {
    runtime.close();
  }
});

test("after throws, drops the live id, and recovery does not call streamSimple", async () => {
  let executions = 0;
  const storage = new RecoveryWatch();
  const { provider, models } = modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("echo", {})])
    : fauxAssistant("after"));
  const original = models.streamSimple.bind(models);
  let failed = false;
  let streamsBeforeRecovery = 0;
  models.streamSimple = (model, context, options) => {
    if (failed && !storage.toolResultStored) streamsBeforeRecovery += 1;
    return original(model, context, options);
  };
  const tool: HarnessTool = {
    ...echo,
    parameters: { type: "object" },
    execute: async () => {
      executions += 1;
      return { content: [{ type: "text", text: "done" }] };
    },
  };
  const runtime = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    hooks: [{
      afterToolCall: () => {
        throw new Error("after boom");
      },
    }],
  });
  try {
    const lane = runtime.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /after boom/);
    const state = await operationState(storage, admitted.value.operationId);
    const resultId = state?.calls?.[0]?.resultEntryId ?? "";
    assert.equal(state?.phase, "tools");
    assert.equal(state?.calls?.[0]?.status, "effect_pending");
    assert.equal(runtime.live.has(resultId), false);
    assert.equal(executions, 1);
    const callsAtFailure = provider.state.callCount;
    assert.equal(callsAtFailure, 1);
    failed = true;
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.equal(executions, 1);
    assert.equal(streamsBeforeRecovery, 0);
    assert.equal(storage.toolResultStored, true);
    assert.equal(runtime.live.has(resultId), false);
    const continued = provider.state.contexts.at(-1);
    assert.ok(continued?.messages.some((message) => message.role === "toolResult" && messageText(message).includes("interrupted before settlement")));
    const stored = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "toolResult");
    assert.ok(stored?.payload.type === "message" && stored.payload.message.role === "toolResult");
    assert.equal(messageText(stored.payload.message), "interrupted before settlement");
    assert.equal(provider.state.callCount, callsAtFailure + 1);
  } finally {
    runtime.close();
  }
});

test("transform throws before streamSimple and the next drive does not call streamSimple", async () => {
  const { provider, models } = modelsFor(() => fauxAssistant("unused"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks: [{
      transformContext: () => {
        throw new Error("transform boom");
      },
    }],
  });
  try {
    const lane = runtime.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /transform boom/);
    const state = await operationState(runtime.storage, admitted.value.operationId);
    assert.equal(state?.phase, "assistant_effect_pending");
    const responseId = state?.responseEntryId ?? "";
    assert.equal(responseId.length > 0, true);
    assert.equal(runtime.live.has(responseId), false);
    assert.equal(provider.state.callCount, 0);
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "aborted");
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error : "", "interrupted before settlement");
    assert.equal(provider.state.callCount, 0);
    assert.equal(runtime.live.has(responseId), false);
  } finally {
    runtime.close();
  }
});

test("summary transform throws and the next drive does not call streamSimple", async () => {
  let summarize = false;
  const { provider, models } = modelsFor(() => fauxAssistant("seeded"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "sys",
    hooks: [{
      transformContext: () => {
        if (summarize) throw new Error("summary transform boom");
        return undefined;
      },
    }],
  });
  try {
    const lane = runtime.lane();
    assert.equal((await lane.prompt("seed goal")).status, "completed");
    assert.equal(provider.state.callCount, 1);
    summarize = true;
    const admitted = await lane.accept({ kind: "compaction" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /summary transform boom/);
    const state = await operationState(runtime.storage, admitted.value.operationId);
    assert.equal(state?.phase, "summary_effect_pending");
    const responseId = state?.responseEntryId ?? "";
    assert.equal(responseId.length > 0, true);
    assert.equal(runtime.live.has(responseId), false);
    assert.equal(provider.state.callCount, 1);
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "aborted");
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.error : "", "interrupted before settlement");
    assert.equal(provider.state.callCount, 1);
    assert.equal(runtime.live.has(responseId), false);
    assert.equal((await lane.entries()).some((entry) => entryText(entry) === "injected-for-model"), false);
  } finally {
    runtime.close();
  }
});
