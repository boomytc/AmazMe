import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHook } from "@amazme/agent";
import { createModels, messageText, type Message } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";
import { AgentHarness, type AgentLane, type Entry, type HarnessTool, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

function modelsFor(respond: FauxResponder) {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  return { provider, models };
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : []));
}

function entryText(entry: Entry): string {
  if (entry.payload.type !== "message") return "";
  const message = entry.payload.message;
  return message.role === "custom" ? message.content : messageText(message);
}

async function checkpoint(storage: MemoryStorage, operationId: string): Promise<{ phase?: string; continuation?: string } | undefined> {
  return storage.read((view) => {
    const found = view.values().find((item) => item.key.includes(`pi.op.state\0${operationId}`));
    return found?.value as { phase?: string; continuation?: string } | undefined;
  });
}

const echo: HarnessTool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(args) {
    const text = typeof args === "object" && args && "text" in args ? String((args as { text: unknown }).text) : "";
    return { content: [{ type: "text", text }] };
  },
};

test("the first onYield appends one user message and asks the model once more", async () => {
  let first = 0;
  let later = 0;
  let laterAtSecondRequest = -1;
  const { provider, models } = modelsFor((_context, _options, state) => {
    if (state.callCount === 2) laterAtSecondRequest = later;
    return fauxAssistant(state.callCount === 1 ? "answer-1" : "answer-2");
  });
  const hooks: readonly AgentHook[] = [
    {
      onYield: () => {
        first += 1;
        return first === 1 ? "again" : undefined;
      },
    },
    {
      onYield: () => {
        later += 1;
        return undefined;
      },
    },
  ];
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks,
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(provider.state.callCount, 2);
    assert.equal(provider.state.contexts.length, 2);
    assert.equal(laterAtSecondRequest, 0);
    assert.equal(later, 1);
    assert.equal(first, 2);
    assert.equal(userTexts(provider.state.contexts[1]?.messages ?? []).includes("again"), true);
    const again = (await runtime.lane().entries()).filter((entry) => entryText(entry) === "again");
    assert.equal(again.length, 1);
    assert.equal(again[0]?.payload.type === "message" && again[0].payload.message.role === "user", true);
    assert.equal(runtime.live.size, 0);
  } finally {
    runtime.close();
  }
});

test("onYield that returns nothing completes after one request", async () => {
  let calls = 0;
  const { provider, models } = modelsFor(() => fauxAssistant("answer"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks: [
      {
        onYield: () => {
          calls += 1;
          return undefined;
        },
      },
      {
        onYield: () => {
          calls += 1;
          return " \n\t";
        },
      },
    ],
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(provider.state.callCount, 1);
    assert.equal(calls, 2);
    const users = (await runtime.lane().entries()).filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0] ? entryText(users[0]) : "", "go");
  } finally {
    runtime.close();
  }
});

test("a queued steer or follow-up runs and onYield is not called at that stop", async () => {
  const yieldsAt: number[] = [];
  let lane: AgentLane | undefined;
  const { provider, models } = modelsFor(async (_context, _options, state) => {
    if (state.callCount === 1) {
      await lane?.steer("steer-msg");
      return fauxAssistant("first");
    }
    return fauxAssistant("after-steer");
  });
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks: [{
      onYield: () => {
        yieldsAt.push(provider.state.callCount);
        return undefined;
      },
    }],
  });
  try {
    lane = runtime.lane();
    const result = await lane.prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(provider.state.callCount, 2);
    assert.deepEqual(yieldsAt, [2]);
    assert.equal(userTexts(provider.state.contexts[1]?.messages ?? []).includes("steer-msg"), true);
    assert.equal((await lane.entries()).some((entry) => entryText(entry) === "again"), false);
  } finally {
    runtime.close();
  }

  const followedAt: number[] = [];
  let followLane: AgentLane | undefined;
  const followed = modelsFor(async (_context, _options, state) => {
    if (state.callCount === 1) {
      await followLane?.followUp("follow-msg");
      return fauxAssistant("first");
    }
    return fauxAssistant("after-follow");
  });
  const followRuntime = new AgentHarness(new MemoryStorage(), {
    models: followed.models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks: [{
      onYield: () => {
        followedAt.push(followed.provider.state.callCount);
        return undefined;
      },
    }],
  });
  try {
    followLane = followRuntime.lane();
    const result = await followLane.prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(followed.provider.state.callCount, 2);
    assert.deepEqual(followedAt, [2]);
    assert.equal(userTexts(followed.provider.state.contexts[1]?.messages ?? []).includes("follow-msg"), true);
    assert.equal((await followLane.entries()).some((entry) => entryText(entry) === "again"), false);
  } finally {
    followRuntime.close();
  }
});

test("a tool turn and a terminating turn do not call onYield", async () => {
  const toolYields: number[] = [];
  const { provider, models } = modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("echo", { text: "hi" })])
    : fauxAssistant("done"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [echo],
    hooks: [{
      onYield: () => {
        toolYields.push(provider.state.callCount);
        return undefined;
      },
    }],
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.deepEqual(toolYields, [2]);
    assert.equal(provider.state.callCount, 2);
    assert.equal(provider.state.contexts[1]?.messages.some((message) => message.role === "toolResult"), true);
    assert.equal((await runtime.lane().entries()).some((entry) => entryText(entry) === "again"), false);
  } finally {
    runtime.close();
  }

  let terminateYields = 0;
  const stopping = modelsFor(() => fauxAssistant([fauxToolCall("echo", { text: "final" })]));
  const stopRuntime = new AgentHarness(new MemoryStorage(), {
    models: stopping.models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [{
      ...echo,
      async execute() {
        return { content: [{ type: "text", text: "final" }], terminate: true };
      },
    }],
    hooks: [{
      onYield: () => {
        terminateYields += 1;
        throw new Error("onYield during terminate");
      },
    }],
  });
  try {
    const result = await stopRuntime.lane().prompt("stop");
    assert.equal(result.status, "completed");
    assert.equal(terminateYields, 0);
    assert.equal(stopping.provider.state.callCount, 1);
    assert.equal((await stopRuntime.lane().entries()).some((entry) => entryText(entry) === "again"), false);
  } finally {
    stopRuntime.close();
  }
});

test("onYield throws before the write and the next drive does not call streamSimple first", async () => {
  let yields = 0;
  let callCountWhenRetryYielded = -1;
  const storage = new MemoryStorage();
  const { provider, models } = modelsFor((_context, _options, state) => fauxAssistant(state.callCount === 1 ? "answer-1" : "answer-2"));
  const runtime = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks: [{
      onYield: () => {
        yields += 1;
        if (yields === 1) throw new Error("yield boom");
        if (yields === 2) {
          callCountWhenRetryYielded = provider.state.callCount;
          return "again";
        }
        return undefined;
      },
    }],
  });
  try {
    const lane = runtime.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /yield boom/);
    const state = await checkpoint(storage, admitted.value.operationId);
    assert.equal(state?.phase, "checkpoint");
    assert.equal(state?.continuation, "may_finish");
    assert.equal(runtime.live.size, 0);
    assert.equal(provider.state.callCount, 1);
    assert.equal(provider.state.contexts.length, 1);
    assert.equal((await lane.entries()).some((entry) => entryText(entry) === "again"), false);
    assert.equal((await lane.entries()).some((entry) => entryText(entry) === "answer-1"), true);
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.equal(callCountWhenRetryYielded, 1);
    assert.equal(provider.state.callCount, 2);
    assert.equal(provider.state.contexts.length, 2);
    assert.equal(userTexts(provider.state.contexts[0]?.messages ?? []).includes("again"), false);
    assert.equal(userTexts(provider.state.contexts[1]?.messages ?? []).includes("again"), true);
    assert.equal((await lane.entries()).filter((entry) => entryText(entry) === "again").length, 1);
    assert.equal(runtime.live.size, 0);
    assert.equal(yields, 3);
  } finally {
    runtime.close();
  }
});

for (const cancel of ["requestAbort", "close"] as const) {
  for (const text of ["again", undefined]) {
    test(`${cancel} while onYield waits does not publish ${text === undefined ? "a later hook result" : "the yielded input"}`, async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started = () => {};
      const waiting = new Promise<void>((resolve) => { started = resolve; });
      let laterHooks = 0;
      const { provider, models } = modelsFor(() => fauxAssistant("answer"));
      const runtime = new AgentHarness(new MemoryStorage(), {
        models,
        model: { provider: "faux", modelId: "faux-1" },
        hooks: [{ onYield: async () => { started(); await gate; return text; } }, {
          onYield: () => { laterHooks += 1; return "later"; },
        }],
      });
      const lane = runtime.lane();
      const admitted = await lane.accept({ kind: "prompt", text: "go" });
      assert.ok(admitted.ok);
      const pending = lane.drive(admitted.value.operationId);
      try {
        await waiting;
        const before = await lane.inspect();
        if (cancel === "requestAbort") assert.ok((await lane.requestAbort(admitted.value.operationId)).ok);
        else runtime.close();
        release();
        const outcome = await pending;
        assert.ok(outcome.ok && outcome.value.kind === "settled");
        assert.equal(outcome.value.result.status, "aborted");
        assert.equal(provider.state.callCount, 1);
        assert.equal(laterHooks, 0);
        assert.equal((await lane.inspect()).tipId, before.tipId);
        const users = (await lane.entries()).filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
        assert.deepEqual(users.map(entryText), ["go"]);
        assert.equal(runtime.live.size, 0);
      } finally {
        release();
        await pending.catch(() => undefined);
        runtime.close();
      }
    });
  }
}

test("abandon while the yielded input waits for storage does not publish or advance it", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = () => {};
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const storage = new MemoryStorage();
  const { provider, models } = modelsFor(() => fauxAssistant("answer"));
  let before: Entry[] = [];
  const runtime = new AgentHarness(storage, {
    models, model: { provider: "faux", modelId: "faux-1" },
    hooks: [{ onYield: () => {
      void storage.run(async (view) => { before = structuredClone(view.entries()); started(); await gate; });
      return "again";
    } }],
  });
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const pending = lane.drive(admitted.value.operationId);
  try {
    await waiting;
    await new Promise((resolve) => setImmediate(resolve));
    runtime.abandon();
    release();
    await pending;
    assert.deepEqual(await lane.entries(), before);
    assert.equal(provider.state.callCount, 1);
    assert.equal((await lane.inspect()).phase, "checkpoint");
    assert.equal(runtime.live.size, 0);
  } finally {
    release();
    await pending.catch(() => undefined);
    runtime.close();
  }
});

test("summary and navigation do not call onYield", async () => {
  let watch = false;
  let watched = 0;
  const { provider, models } = modelsFor(() => fauxAssistant("seeded"));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    systemPrompt: "sys",
    hooks: [{
      onYield: () => {
        if (watch) watched += 1;
        return undefined;
      },
    }],
  });
  try {
    const lane = runtime.lane();
    assert.equal((await lane.prompt("seed goal")).status, "completed");
    assert.equal(provider.state.callCount, 1);
    watch = true;
    const compacted = await lane.accept({ kind: "compaction" });
    assert.equal(compacted.ok, true);
    if (!compacted.ok) return;
    const folded = await lane.drive(compacted.value.operationId);
    assert.equal(folded.ok && folded.value.kind === "settled" ? folded.value.result.status : "", "completed");
    assert.equal(watched, 0);
    assert.equal(provider.state.callCount, 2);
    const userEntry = (await lane.entries()).find((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
    assert.ok(userEntry);
    const admitted = await lane.accept({ kind: "navigation", targetId: userEntry.id });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const moved = await lane.drive(admitted.value.operationId);
    assert.equal(moved.ok && moved.value.kind === "settled" ? moved.value.result.status : "", "completed");
    assert.equal(watched, 0);
    assert.equal(provider.state.callCount, 2);
    assert.equal((await lane.entries()).some((entry) => entryText(entry) === "again"), false);
  } finally {
    runtime.close();
  }
});

class YieldBoundaryStorage extends MemoryStorage {
  private crashAfterCommit = false;

  constructor() {
    super();
    this.subscribe(() => {
      if (!this.crashAfterCommit) return;
      this.crashAfterCommit = false;
      throw new Error("yield boundary crash");
    });
  }

  protected override persist(writes: Write[]): void {
    const yielded = writes.some((write) => write.type === "entry"
      && write.payload.type === "message"
      && write.payload.message.role === "user"
      && write.payload.message.content === "again");
    if (yielded) this.crashAfterCommit = true;
    super.persist(writes);
  }
}

test("a crash after the yielded user message still requests the model with that text", async () => {
  let yields = 0;
  let callCountAtLaterYield = -1;
  const storage = new YieldBoundaryStorage();
  const { provider, models } = modelsFor((_context, _options, state) => fauxAssistant(state.callCount === 1 ? "answer-1" : "answer-2"));
  const runtime = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    hooks: [{
      onYield: () => {
        yields += 1;
        if (yields === 1) return "again";
        callCountAtLaterYield = provider.state.callCount;
        return undefined;
      },
    }],
  });
  try {
    const lane = runtime.lane();
    const admitted = await lane.accept({ kind: "prompt", text: "go" });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    await assert.rejects(lane.drive(admitted.value.operationId), /yield boundary crash/);
    const state = await checkpoint(storage, admitted.value.operationId);
    assert.equal(state?.phase, "assistant_ready");
    assert.equal(provider.state.callCount, 1);
    assert.equal((await lane.entries()).filter((entry) => entryText(entry) === "again").length, 1);
    const outcome = await lane.drive(admitted.value.operationId);
    assert.equal(outcome.ok && outcome.value.kind === "settled" ? outcome.value.result.status : "", "completed");
    assert.equal(provider.state.callCount, 2);
    assert.equal(provider.state.contexts.length, 2);
    assert.equal(userTexts(provider.state.contexts[1]?.messages ?? []).includes("again"), true);
    assert.equal(userTexts(provider.state.contexts[0]?.messages ?? []).includes("again"), false);
    assert.equal(callCountAtLaterYield, 2);
    assert.equal(yields, 2);
    assert.equal((await lane.entries()).filter((entry) => entryText(entry) === "again").length, 1);
  } finally {
    runtime.close();
  }
});
