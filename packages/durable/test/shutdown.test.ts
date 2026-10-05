import assert from "node:assert/strict";
import test from "node:test";
import { AgentHarness, type Apply, type HarnessTool, type Result, type StorageView, type Write } from "@amazme/durable";
import { waitUntil } from "../src/harness.ts";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";

class RetryCloseStorage extends MemoryStorage {
  onRetry?: () => void;

  protected override persist(writes: readonly Write[]): void {
    super.persist(writes);
    const retry = writes.some((write) => write.type === "set" && write.address.namespace === "pi.op.state"
      && (write.value as { phase?: string }).phase === "retry_wait");
    if (!retry || !this.onRetry) return;
    const notify = this.onRetry;
    this.onRetry = undefined;
    notify();
  }
}

/** Blocks the storage turn that first observes `assistant_ready`, before that turn can arm a model call. */
class HoldAssistantReady extends MemoryStorage {
  readonly blocked: Promise<void>;
  private resolveBlocked: () => void = () => undefined;
  private releaseHeld: () => void = () => undefined;
  private held = false;

  constructor() {
    super();
    this.blocked = new Promise((resolve) => { this.resolveBlocked = resolve; });
  }

  release(): void {
    this.releaseHeld();
  }

  override run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    return super.run(async (view, apply) => {
      const ready = !this.held && view.values().some((item) => (item.value as { phase?: string }).phase === "assistant_ready");
      if (ready) {
        this.held = true;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        this.releaseHeld = release;
        this.resolveBlocked();
        await gate;
      }
      return fn(view, apply);
    });
  }
}

class HoldStorage extends MemoryStorage {
  private gate: Promise<void> = Promise.resolve();
  private blockNext = false;

  hold(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise((resolve) => { release = resolve; });
    this.blockNext = true;
    return release;
  }

  override run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    const block = this.blockNext;
    this.blockNext = false;
    const gate = this.gate;
    return super.run(async (view, apply) => {
      if (block) await gate;
      return fn(view, apply);
    });
  }
}

function runtimeFor(execute?: HarnessTool["execute"], storage: MemoryStorage = new MemoryStorage()) {
  let calls = 0;
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      calls = state.callCount;
      if (execute && state.callCount === 1) return fauxAssistant([fauxToolCall("work", {})]);
      return fauxAssistant("done");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const tools: HarnessTool[] = execute
    ? [{ name: "work", description: "work", parameters: { type: "object" }, replay: "never", execute }]
    : [];
  const runtime = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" }, tools, maxAttempts: 2 });
  return { runtime, calls: () => calls, provider };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("drain waits for an admitted tool without aborting it or writing requestAbort", async () => {
  const started = deferred();
  const release = deferred<void>();
  let aborted = false;
  const { runtime } = runtimeFor(async (_args, context) => {
    started.resolve();
    await release.promise;
    aborted = context.signal.aborted;
    return { content: [{ type: "text", text: "worked" }] };
  });
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const drive = lane.drive(admitted.value.operationId, { waitForRetry: true });
  await started.promise;
  let drained = false;
  const draining = runtime.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal((await lane.inspect()).status, "open");
  release.resolve();
  await draining;
  const outcome = await drive;
  assert.ok(outcome.ok && outcome.value.kind === "settled");
  assert.equal(outcome.value.result.status, "completed");
  assert.equal(aborted, false);
  const again = await lane.accept({ kind: "prompt", text: "later" });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error.code, "closed");
  await runtime.close();
});

test("close aborts the signal but a tool that ignores it holds the barrier and the lock of work", async () => {
  const started = deferred();
  const release = deferred<{ content: [{ type: "text"; text: string }] }>();
  const { runtime, calls } = runtimeFor(() => {
    started.resolve();
    return release.promise;
  });
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const drive = lane.drive(admitted.value.operationId);
  await started.promise;
  let closed = false;
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(runtime.signal().aborted, true);
  assert.equal((await lane.inspect()).status, "open");
  assert.equal(calls(), 1);
  release.resolve({ content: [{ type: "text", text: "late" }] });
  await closing;
  await drive;
  assert.equal(calls(), 1);
  const text = (await lane.entries()).flatMap((entry) =>
    entry.payload.type === "message" && entry.payload.message.role !== "custom" ? [messageText(entry.payload.message)] : []);
  assert.ok(text.includes("late"));
});

test("a later close aborts a drain that is still waiting", async () => {
  const started = deferred();
  const release = deferred();
  let aborted = false;
  const { runtime, calls } = runtimeFor(async (_args, context) => {
    started.resolve();
    await release.promise;
    aborted = context.signal.aborted;
    return { content: [{ type: "text", text: "worked" }] };
  });
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const drive = lane.drive(admitted.value.operationId, { waitForRetry: true });
  await started.promise;
  const draining = runtime.drain();
  const closing = runtime.close();
  assert.equal(closing, draining);
  assert.equal(runtime.signal().aborted, true);
  release.resolve();
  await closing;
  const outcome = await drive;
  assert.ok(outcome.ok && outcome.value.kind === "waiting");
  assert.equal(aborted, true);
  assert.equal((await lane.inspect()).status, "open");
  assert.equal(calls(), 1);
});

test("close stops admission before synchronous harness and lane abort listeners run", async () => {
  const { runtime, calls } = runtimeFor();
  const lane = runtime.lane();
  const accepted = await lane.accept({ kind: "prompt", text: "before close" });
  assert.ok(accepted.ok);
  const before = await lane.snapshot();
  const closedDuringAbort: boolean[] = [];
  const attempts: Array<Promise<Result<unknown>>> = [];
  for (const [name, signal] of [["harness", runtime.signal()], ["lane", runtime.laneSignal("main")]] as const) {
    signal.addEventListener("abort", () => {
      closedDuringAbort.push(runtime.isClosed);
      const other = runtime.lane(name);
      attempts.push(
        other.accept({ kind: "prompt", text: "during abort" }),
        other.steer("during abort"),
        other.followUp("during abort"),
        other.drive("new drive"),
        lane.requestAbort(accepted.value.operationId),
      );
    }, { once: true });
  }
  await runtime.close();
  const results = await Promise.all(attempts);
  assert.deepEqual(closedDuringAbort, [true, true]);
  assert.equal(results.length, 10);
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "closed");
  }
  assert.deepEqual(await lane.snapshot(), before, "abort listeners cannot change persisted business state");
  assert.equal(calls(), 0);
});

test("a rejected storage barrier can be retried while concurrent shutdown callers share each attempt", async () => {
  const failure = new Error("temporary storage barrier failure");
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  class RetryIdleStorage extends MemoryStorage {
    idleCalls = 0;

    override whenIdle(): Promise<void> {
      this.idleCalls += 1;
      return this.idleCalls === 1 ? first : super.whenIdle();
    }
  }
  const storage = new RetryIdleStorage();
  const { runtime } = runtimeFor(undefined, storage);
  const draining = runtime.drain();
  assert.equal(runtime.drain(), draining);
  assert.equal(runtime.close(), draining, "abort upgrades the pending drain without replacing its barrier");
  assert.equal(storage.idleCalls, 1);
  const rejected = assert.rejects(draining, (error: unknown) => error === failure);
  rejectFirst(failure);
  await rejected;
  assert.equal(runtime.isClosed, true);

  const retry = runtime.drain();
  assert.notEqual(retry, draining);
  assert.equal(runtime.close(), retry);
  await retry;
  assert.equal(storage.idleCalls, 2);
  assert.equal(runtime.drain(), retry, "a successful shutdown remains complete");
  const refused = await runtime.lane().accept({ kind: "prompt", text: "after retry" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "closed");
});

test("queued storage work admitted before drain is applied, and a later accept is refused", async () => {
  const storage = new HoldStorage();
  const release = storage.hold();
  const { runtime, calls } = runtimeFor(undefined, storage);
  const blocker = storage.run(() => undefined);
  const lane = runtime.lane();
  const accepted = lane.accept({ kind: "prompt", text: "queued" });
  const reading = lane.snapshot();
  let drained = false;
  const draining = runtime.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(calls(), 0);
  release();
  const admission = await accepted;
  assert.ok(admission.ok);
  await reading;
  await blocker;
  await draining;
  assert.equal(calls(), 0);
  const refused = await lane.accept({ kind: "prompt", text: "after" });
  assert.equal(refused.ok, false);
  await runtime.drain();
});

test("close during the armed model step does not call the model or persist requestAbort", async () => {
  const storage = new HoldAssistantReady();
  const { runtime, calls } = runtimeFor(undefined, storage);
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const drive = lane.drive(admitted.value.operationId);
  await storage.blocked;
  const closing = runtime.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(calls(), 0);
  storage.release();
  await closing;
  const outcome = await drive;
  assert.ok(outcome.ok && outcome.value.kind === "waiting");
  assert.equal(calls(), 0);
  const status = await lane.inspect();
  assert.equal(status.status, "open");
  assert.notEqual(status.phase, "retry_wait");
});

test("closing during retry_wait does not start another model call or persist requestAbort", async () => {
  const storage = new RetryCloseStorage();
  let runtime!: AgentHarness;
  const provider = fauxProvider({
    respond: () => fauxAssistant("retry", { stopReason: "error", retryable: true, errorMessage: "retry" }),
  });
  const models = createModels();
  models.setProvider(provider);
  runtime = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" }, maxAttempts: 3 });
  storage.onRetry = () => { void runtime.close(); };
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const outcome = await lane.drive(admitted.value.operationId, { waitForRetry: true });
  assert.equal(provider.state.callCount, 1);
  assert.ok(outcome.ok && outcome.value.kind === "waiting");
  const status = await lane.inspect();
  assert.equal(status.phase, "retry_wait");
  assert.equal(status.status, "open");
  await runtime.close();
  assert.equal(provider.state.callCount, 1);
});

test("close resolves when a drive rejects and does not start another request", async () => {
  let calls = 0;
  const models = createModels();
  models.setProvider(fauxProvider());
  const runtime = new AgentHarness(new MemoryStorage(), {
    models: {
      getModel: models.getModel.bind(models),
      streamSimple: () => {
        calls += 1;
        throw new Error("model broke");
      },
    },
    model: { provider: "faux", modelId: "faux-1" },
  });
  const lane = runtime.lane();
  const admitted = await lane.accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  await assert.rejects(lane.drive(admitted.value.operationId), /model broke/);
  await runtime.close();
  assert.equal(calls, 1);
  await runtime.drain();
});

test("waitUntil finishes immediately when the signal is already aborted or the time has passed", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let added = 0;
  const signal = aborted.signal;
  const add = signal.addEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    added += 1;
    return add(type, listener, options);
  }) as typeof signal.addEventListener;
  await waitUntil(Date.now() + 60_000, signal);
  assert.equal(added, 0);
  await waitUntil(Date.now() - 5, new AbortController().signal);
});

test("waitUntil clears the timer and the listener once, on expiry and on abort", async () => {
  const expiry = new AbortController();
  let removed = 0;
  const expiring = expiry.signal;
  const remove = expiring.removeEventListener.bind(expiring);
  expiring.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    removed += 1;
    return remove(type, listener, options);
  }) as typeof expiring.removeEventListener;
  await waitUntil(Date.now() + 20, expiring);
  assert.equal(removed, 1);
  expiry.abort();
  assert.equal(removed, 1);

  const controller = new AbortController();
  let cleared = 0;
  const waiting = controller.signal;
  const removeWaiting = waiting.removeEventListener.bind(waiting);
  waiting.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    cleared += 1;
    return removeWaiting(type, listener, options);
  }) as typeof waiting.removeEventListener;
  const pending = waitUntil(Date.now() + 60_000, waiting);
  controller.abort();
  controller.abort();
  await pending;
  assert.equal(cleared, 1);
});

test("waitUntil rejects and clears the timer when adding the listener throws", async () => {
  let cleared = false;
  const original = globalThis.clearTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    cleared = true;
    return original(timer);
  }) as typeof clearTimeout;
  const signal = {
    aborted: false,
    addEventListener() { throw new Error("listener failed"); },
    removeEventListener() { return undefined; },
  } as unknown as AbortSignal;
  try {
    await assert.rejects(waitUntil(Date.now() + 60_000, signal), /listener failed/);
    assert.equal(cleared, true);
  } finally {
    globalThis.clearTimeout = original;
  }
});
