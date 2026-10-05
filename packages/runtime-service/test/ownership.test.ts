import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { Client, RemoteError } from "@amazme/client";
import {
  AgentHarness,
  value,
  type Apply,
  type CommitResult,
  type HarnessOptions,
  type HarnessTool,
  type Storage,
  type StorageView,
  type Write,
} from "@amazme/durable";
import { openJsonlOwner, StorageBusyError } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { Server, type RuntimeHandle } from "@amazme/server";
import { memoryConnector } from "@amazme/server/testing";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { openJsonlRuntime } from "@amazme/runtime-service/jsonl";
import {
  createManagementService,
  openOwnedRuntimes,
  type OwnedRuntimeOptions,
  type OwnedRuntimeResources,
} from "@amazme/runtime-service/server";
import { texts, until } from "./support.ts";

const timeout = { timeout: 10_000 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-own-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function modelOptions(): HarnessOptions {
  const models = createModels();
  models.setProvider(fauxProvider());
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

function memoryOwned(storage: MemoryStorage, harness: AgentHarness): OwnedRuntimeResources {
  return {
    harness,
    closeStorage: () => storage.whenIdle(),
    release: () => storage.whenIdle(),
    remove: () => storage.whenIdle(),
  };
}

/** A tool that stays inside execute until the test releases it, including after abort. */
function gatedTool() {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let settle: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { settle = resolve; });
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("work", {})])
      : fauxAssistant("after"),
  });
  const models = createModels();
  models.setProvider(provider);
  const tool: HarnessTool = {
    name: "work",
    description: "work",
    parameters: { type: "object", additionalProperties: true },
    replay: "never",
    async execute(_args, context) {
      markReady();
      await gate;
      return { content: [{ type: "text", text: context.signal.aborted ? "tool-saw-abort" : "tool-finished" }] };
    },
  };
  return { models, tool, ready, finish: () => { settle?.(); settle = undefined; }, calls: () => provider.state.callCount };
}

function serve(open: OwnedRuntimeOptions["open"]) {
  const errors: Error[] = [];
  const handles: RuntimeHandle[] = [];
  const opener = openOwnedRuntimes({
    open,
    publishWindowMs: 0,
    onError: (error) => errors.push(error),
  });
  let server!: Server;
  server = new Server({
    serverId: "srv",
    service: createManagementService({ removeRuntime: (runtimeId) => server.removeRuntime(runtimeId) }),
    onError: (error) => errors.push(error),
    openRuntime: async (runtimeId, signal) => {
      const handle = await opener(runtimeId, signal);
      if (handle) handles.push(handle);
      return handle;
    },
  });
  const connector = memoryConnector((connection) => server.accept(connection));
  const clients: Client[] = [];
  return {
    server,
    errors,
    handles,
    async connect() {
      const client = new Client({ serverId: "srv", transport: connector.transport });
      clients.push(client);
      await client.connect();
      return { client, remote: new RuntimeClient(client) };
    },
    async close() {
      for (const client of clients) await client.dispose();
      await server.close();
    },
  };
}

async function assertBusy(file: string): Promise<void> {
  let probe: ReturnType<typeof openJsonlOwner> | undefined;
  try {
    probe = openJsonlOwner(file);
  } catch (error) {
    assert.ok(error instanceof StorageBusyError, error instanceof Error ? error.message : String(error));
    return;
  }
  await probe.release();
  assert.fail("a second owner opened the file");
}

async function assertFree(file: string): Promise<void> {
  const probe = openJsonlOwner(file);
  try {
    assert.equal(existsSync(file), true);
  } finally {
    await probe.release();
  }
}

class HoldRun implements Storage {
  admitted = 0;
  started = 0;
  private hold: Promise<void> | undefined;
  private letGo: (() => void) | undefined;

  constructor(private readonly inner: Storage) {}

  arm(): void {
    this.hold = new Promise((resolve) => { this.letGo = resolve; });
  }

  release(): void {
    this.letGo?.();
    this.letGo = undefined;
  }

  run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    this.admitted += 1;
    const hold = this.hold;
    this.hold = undefined;
    return this.inner.run(async (view, apply) => {
      this.started += 1;
      if (hold) await hold;
      return fn(view, apply);
    });
  }

  commit(writes: readonly Write[]): Promise<CommitResult> {
    return this.run((_view, apply) => apply(writes));
  }

  read<T>(fn: (view: StorageView) => T): Promise<T> {
    return this.run((view) => fn(view));
  }

  subscribe(listener: () => void): () => void {
    return this.inner.subscribe(listener);
  }

  whenIdle(): Promise<void> {
    return this.inner.whenIdle();
  }
}

class UnsubscribeOnce implements Storage {
  private thrown = false;
  activeSubscriptions = 0;

  constructor(private readonly inner: Storage) {}

  run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    return this.inner.run(fn);
  }

  commit(writes: readonly Write[]): Promise<CommitResult> {
    return this.inner.commit(writes);
  }

  read<T>(fn: (view: StorageView) => T): Promise<T> {
    return this.inner.read(fn);
  }

  subscribe(listener: () => void): () => void {
    const stop = this.inner.subscribe(listener);
    this.activeSubscriptions += 1;
    let stopped = false;
    return () => {
      if (!this.thrown) {
        this.thrown = true;
        throw new Error("unsubscribe failed");
      }
      stop();
      if (!stopped) this.activeSubscriptions -= 1;
      stopped = true;
    };
  }

  whenIdle(): Promise<void> {
    return this.inner.whenIdle();
  }
}

class IdleFailureOnce extends MemoryStorage {
  idleCalls = 0;

  override whenIdle(): Promise<void> {
    this.idleCalls += 1;
    if (this.idleCalls === 1) return Promise.reject(new Error("storage barrier failed"));
    return super.whenIdle();
  }
}

test("a failed harness barrier keeps storage owned, and a later close retries it", timeout, async () => {
  const storage = new IdleFailureOnce();
  const harness = new AgentHarness(storage, modelOptions());
  let closes = 0;
  let releases = 0;
  const open = openOwnedRuntimes({
    open: async () => ({
      harness,
      async closeStorage() { closes += 1; },
      async release() { releases += 1; },
      async remove() { assert.fail("closing must not delete data"); },
    }),
  });
  const handle = await open("main", new AbortController().signal);
  assert.ok(handle);
  const first = handle.close("drain");
  assert.equal(handle.close("drain"), first);
  await assert.rejects(first, /storage barrier failed/);
  assert.equal(closes, 0);
  assert.equal(releases, 0);
  const retry = handle.close("drain");
  assert.notEqual(retry, first);
  await retry;
  assert.equal(storage.idleCalls, 2);
  assert.equal(closes, 1);
  assert.equal(releases, 0);
  await handle.release!();
  assert.equal(releases, 1);
  assert.equal(closes, 1);
});

test("JSONL runtime removal retries a partial unlock after deleting its data", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  const resources = await openJsonlRuntime(file, modelOptions());
  const open = openOwnedRuntimes({ open: async () => resources });
  const handle = await open("main", new AbortController().signal);
  assert.ok(handle);
  const stat = statSync(file, { bigint: true });
  const inodeLock = join(userInfo().homedir, ".amazme-jsonl-locks", "inode", `${stat.dev}-${stat.ino}`);
  try {
    chmodSync(inodeLock, 0o500);
    await assert.rejects(handle.remove!(), (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES");
    assert.equal(existsSync(file), false, "data deletion succeeded before the partial unlock failed");
    chmodSync(inodeLock, 0o700);
    await handle.remove!();
    assert.equal(existsSync(file), false);
    await assertFree(file);
  } finally {
    if (existsSync(inodeLock)) chmodSync(inodeLock, 0o700);
    await handle.remove!();
  }
});

test("automatic subscription cleanup reports a failure and retains the observer for host close", timeout, async () => {
  const storage = new UnsubscribeOnce(new MemoryStorage());
  const harness = new AgentHarness(storage, modelOptions());
  const host = serve(async () => ({
    harness,
    closeStorage: () => storage.whenIdle(),
    release: () => storage.whenIdle(),
    remove: () => storage.whenIdle(),
  }));
  try {
    const { remote } = await host.connect();
    await remote.attach("main");
    const subscription = await remote.lane("main").subscribe(() => undefined);
    await subscription.close();
    await until(() => host.errors.some((error) => error.message === "unsubscribe failed"), "the cleanup failure to be reported");
    assert.equal(storage.activeSubscriptions, 1);
    await host.handles[0]!.close("drain");
    assert.equal(storage.activeSubscriptions, 0);
  } finally {
    await host.close();
  }
});

test("concurrent attaches share one open, and the next attach after idle opens again", timeout, async () => {
  let releaseOpen!: () => void;
  const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const harnesses: AgentHarness[] = [];
  const calls: Array<() => number> = [];
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const provider = fauxProvider();
    calls.push(() => provider.state.callCount);
    const models = createModels();
    models.setProvider(provider);
    const storage = new MemoryStorage();
    const harness = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" } });
    harnesses.push(harness);
    if (harnesses.length === 1) await gate;
    return memoryOwned(storage, harness);
  });
  try {
    const [first, second] = await Promise.all([host.connect(), host.connect()]);
    const left = first.remote.attach("main");
    const right = second.remote.attach("main");
    await until(() => harnesses.length === 1, "the shared open to start");
    await flush();
    assert.equal(harnesses.length, 1);
    releaseOpen();
    const [routeA, routeB] = await Promise.all([left, right]);
    assert.notEqual(routeA.attachmentId, routeB.attachmentId);
    const repeated = await first.remote.attach("main");
    assert.equal(repeated.attachmentId, routeA.attachmentId);
    assert.equal(harnesses.length, 1);
    assert.deepEqual(texts(await first.remote.lane("main").snapshot()), []);
    assert.equal(calls[0]!(), 0, "opening and reading a snapshot does not drive");
    await first.remote.detach();
    assert.equal(harnesses[0]!.isClosed, false);
    await second.remote.detach();
    await until(() => harnesses[0]!.isClosed, "idle reclaim to close the harness");
    await second.remote.attach("main");
    assert.equal(harnesses.length, 2);
    assert.equal(harnesses[0]!.isClosed, true);
    assert.equal(harnesses[1]!.isClosed, false);
    assert.deepEqual(texts(await second.remote.lane("main").snapshot()), []);
    assert.equal(calls[1]!(), 0, "reopening does not drive");
  } finally {
    releaseOpen();
    await host.close();
  }
});

test("the last client can leave while a tool runs; reclaim unlocks only after it finishes, and the old owner cannot delete the next file", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  const tools: ReturnType<typeof gatedTool>[] = [];
  let releases = 0;
  let owned: OwnedRuntimeResources | undefined;
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const tool = gatedTool();
    tools.push(tool);
    const opened = await openJsonlRuntime(file, {
      models: tool.models,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [tool.tool],
    });
    if (owned) return opened;
    owned = {
      harness: opened.harness,
      closeStorage: () => opened.closeStorage(),
      async release() {
        releases += 1;
        await opened.release();
      },
      remove: () => opened.remove(),
    };
    return owned;
  });
  try {
    const [first, second] = await Promise.all([host.connect(), host.connect()]);
    await first.remote.attach("main");
    await second.remote.attach("main");
    assert.equal(tools.length, 1);
    const lane = first.remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const controller = new AbortController();
    const driving = lane.drive("op", { signal: controller.signal });
    await tools[0]!.ready;
    assert.equal(tools[0]!.calls(), 1);
    assert.equal(texts(await second.remote.lane("main").snapshot()).includes("go"), true);
    assert.equal(tools[0]!.calls(), 1, "snapshot does not drive");
    controller.abort();
    await assert.rejects(driving, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(owned!.harness.isClosed, false);
    assert.equal(owned!.harness.signal().aborted, false);
    await assertBusy(file);
    await first.client.disconnect();
    assert.equal(owned!.harness.isClosed, false);
    await second.client.disconnect();
    await until(() => host.server.connectionCount === 0, "both connections to leave");
    await flush();
    assert.equal(releases, 0);
    assert.equal(owned!.harness.isClosed, false);
    assert.equal((await owned!.harness.lane("main").inspect()).status, "open");
    await assertBusy(file);
    tools[0]!.finish();
    await until(() => releases === 1, "idle reclaim to release the lock");
    assert.equal(owned!.harness.isClosed, true);
    assert.equal(tools[0]!.calls(), 2, "the admitted drive finishes and is not sent again");
    assert.match(readFileSync(file, "utf8"), /tool-finished/);
    assert.match(readFileSync(file, "utf8"), /after/);
    const again = await host.connect();
    await again.remote.attach("main");
    assert.equal(tools.length, 2);
    assert.equal(tools[1]!.calls(), 0);
    assert.equal((await again.remote.lane("main").result("op"))?.status, "completed");
    assert.ok(texts(await again.remote.lane("main").snapshot()).includes("after"));
    await assert.rejects(() => host.handles[0]!.remove!(), /storage ownership was released/);
    await assert.rejects(owned!.remove(), /storage ownership was released/);
    assert.ok(texts(await again.remote.lane("main").snapshot()).includes("after"));
    assert.match(readFileSync(file, "utf8"), /after/);
    await assertBusy(file);
    assert.equal(releases, 1);
    assert.equal(tools[1]!.calls(), 0);
  } finally {
    tools[0]?.finish();
    await host.close();
  }
});

test("drain waits without aborting or unlocking, and the admitted drive still completes", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  const tool = gatedTool();
  let harness: AgentHarness | undefined;
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const opened = await openJsonlRuntime(file, {
      models: tool.models,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [tool.tool],
    });
    harness = opened.harness;
    return opened;
  });
  try {
    const { remote } = await host.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const subscription = await lane.subscribe(() => undefined);
    const driving = lane.drive("op");
    await tool.ready;
    const handle = host.handles[0]!;
    let done = false;
    const closing = handle.close("drain");
    assert.equal(handle.close("drain"), closing);
    void closing.then(() => { done = true; }, () => { done = true; });
    assert.deepEqual(await subscription.ended, { reason: "ended", code: "runtime_closed", message: "the runtime host is closed" });
    await flush();
    assert.equal(done, false);
    assert.equal(harness!.signal().aborted, false);
    assert.equal((await harness!.lane("main").inspect()).status, "open");
    await assertBusy(file);
    tool.finish();
    const outcome = await driving;
    await closing;
    assert.equal(outcome.kind, "settled");
    if (outcome.kind === "settled") assert.equal(outcome.result.status, "completed");
    assert.equal(tool.calls(), 2);
    assert.match(readFileSync(file, "utf8"), /tool-finished/);
    assert.match(readFileSync(file, "utf8"), /after/);
    await assertBusy(file);
    await handle.release!();
    await assertFree(file);
    assert.match(readFileSync(file, "utf8"), /after/);
  } finally {
    tool.finish();
    await host.close();
  }
});

test("abort upgrades the shared close, still waits for a tool that ignores the signal, and keeps the lock", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  const tool = gatedTool();
  let harness: AgentHarness | undefined;
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const opened = await openJsonlRuntime(file, {
      models: tool.models,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [tool.tool],
    });
    harness = opened.harness;
    return opened;
  });
  try {
    const { remote } = await host.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const driving = lane.drive("op");
    await tool.ready;
    const handle = host.handles[0]!;
    let done = false;
    const closing = handle.close("abort");
    assert.equal(handle.close("drain"), closing);
    void closing.then(() => { done = true; }, () => { done = true; });
    assert.equal(harness!.signal().aborted, true);
    assert.equal(handle.close("drain"), closing, "a later drain does not replace or undo the abort");
    assert.equal(harness!.signal().aborted, true);
    await flush();
    assert.equal(done, false);
    assert.equal((await harness!.lane("main").inspect()).status, "open");
    await assertBusy(file);
    tool.finish();
    const outcome = await driving;
    await closing;
    assert.equal(outcome.kind, "waiting");
    assert.equal(tool.calls(), 1, "abort does not start the model call that follows the tool");
    assert.match(readFileSync(file, "utf8"), /tool-saw-abort/);
    assert.equal(readFileSync(file, "utf8").includes("\"after\""), false);
    await assertBusy(file);
    await handle.release!();
    await assertFree(file);
    assert.equal(existsSync(file), true);
  } finally {
    tool.finish();
    await host.close();
  }
});

test("close waits for a storage callback admitted before it, then rejects later writes without unlocking", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  let holding: HoldRun | undefined;
  let harness: AgentHarness | undefined;
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const owner = openJsonlOwner(file);
    const storage = new HoldRun(owner.storage);
    holding = storage;
    harness = new AgentHarness(storage, modelOptions());
    return {
      harness,
      closeStorage: () => owner.close(),
      release: () => owner.release(),
      async remove() {
        await owner.deleteData();
        await owner.release();
      },
    };
  });
  try {
    const { remote } = await host.connect();
    await remote.attach("main");
    holding!.arm();
    const accepting = remote.lane("main").accept({ kind: "prompt", text: "hold" });
    await until(() => holding!.started === 1, "the admitted storage callback to start");
    const queued = harness!.storage.commit([{ type: "set", address: value("test", "queued"), value: 1 }]);
    assert.equal(holding!.admitted, 2);
    assert.equal(holding!.started, 1);
    const handle = host.handles[0]!;
    let done = false;
    const closing = handle.close("drain");
    void closing.then(() => { done = true; }, () => { done = true; });
    await flush();
    assert.equal(done, false);
    assert.equal(holding!.started, 1);
    holding!.release();
    await accepting;
    await queued;
    await closing;
    assert.equal(holding!.started, 2);
    assert.match(readFileSync(file, "utf8"), /queued/);
    await assert.rejects(
      harness!.storage.commit([{ type: "set", address: value("test", "too-late"), value: 1 }]),
      /storage is closed/,
    );
    assert.equal(readFileSync(file, "utf8").includes("too-late"), false);
    await assertBusy(file);
    await handle.release!();
    await assertFree(file);
  } finally {
    holding?.release();
    await host.close();
  }
});

test("one cleanup failure does not skip the other, and the lock stays until a later close and release succeed", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  let storageCloses = 0;
  let harness: AgentHarness | undefined;
  let observing: UnsubscribeOnce | undefined;
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const owner = openJsonlOwner(file);
    const storage = observing = new UnsubscribeOnce(owner.storage);
    harness = new AgentHarness(storage, modelOptions());
    return {
      harness,
      async closeStorage() {
        storageCloses += 1;
        if (storageCloses === 1) throw new Error("storage close failed");
        await owner.close();
      },
      release: () => owner.release(),
      async remove() {
        await owner.deleteData();
        await owner.release();
      },
    };
  });
  try {
    const [first, second] = await Promise.all([host.connect(), host.connect()]);
    await first.remote.attach("main");
    await second.remote.attach("main");
    const left = await first.remote.lane("main").subscribe(() => undefined);
    const right = await second.remote.lane("main").subscribe(() => undefined);
    const handle = host.handles[0]!;
    const closing = handle.close("drain");
    const failed = assert.rejects(closing, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const messages = error.errors.map((item) => item instanceof Error ? item.message : String(item));
      assert.ok(messages.some((message) => message.includes("unsubscribe failed")));
      assert.ok(messages.some((message) => message.includes("storage close failed")));
      return true;
    });
    const [endA, endB] = await Promise.all([left.ended, right.ended]);
    assert.equal(endA.reason, "ended");
    assert.equal(endB.reason, "ended");
    if (endA.reason === "ended") assert.equal(endA.code, "runtime_closed");
    if (endB.reason === "ended") assert.equal(endB.code, "runtime_closed");
    await failed;
    assert.equal(observing!.activeSubscriptions, 1, "the failed unsubscribe remains owned for retry");
    assert.equal(harness!.isClosed, true);
    assert.equal(storageCloses, 1);
    await assertBusy(file);
    const retry = handle.close("drain");
    assert.notEqual(retry, closing);
    await retry;
    assert.equal(observing!.activeSubscriptions, 0, "retry releases the failed observer too");
    assert.equal(handle.close("drain"), retry);
    assert.equal(storageCloses, 2);
    await assertBusy(file);
    await handle.release!();
    await assertFree(file);
    await handle.release!();
    await assertFree(file);
  } finally {
    await host.close();
  }
});

test("storage_busy stays that code, and a later open failure does not poison the runtime", timeout, async () => {
  let attempt = 0;
  const host = serve(async () => {
    attempt += 1;
    if (attempt === 1) throw Object.assign(new Error("held"), { code: "storage_busy" });
    if (attempt === 2) throw new Error("boom");
    const storage = new MemoryStorage();
    return memoryOwned(storage, new AgentHarness(storage, modelOptions()));
  });
  try {
    const { remote } = await host.connect();
    await assert.rejects(remote.attach("main"), (error: unknown) => error instanceof RemoteError && error.code === "storage_busy" && error.message === "held");
    await assert.rejects(remote.attach("main"), (error: unknown) => error instanceof RemoteError && error.code === "internal");
    await remote.attach("main");
    assert.equal(attempt, 3);
    assert.deepEqual(texts(await remote.lane("main").snapshot()), []);
    assert.deepEqual(host.errors.map((error) => error.message), ["boom"]);
  } finally {
    await host.close();
  }
});

test("a corrupt JSONL open releases the lock so the next attach can open the repaired file", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  writeFileSync(file, "{\"writes\":null}\n");
  let attempt = 0;
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    attempt += 1;
    return openJsonlRuntime(file, modelOptions());
  });
  try {
    const { remote } = await host.connect();
    await assert.rejects(remote.attach("main"), (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "internal");
      return true;
    });
    writeFileSync(file, "");
    await remote.attach("main");
    assert.equal(attempt, 2);
    assert.deepEqual(texts(await remote.lane("main").snapshot()), []);
    await assertBusy(file);
  } finally {
    await host.close();
  }
});

test("an open that finishes after its waiter has left is discarded, unlocked, and not deleted", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  let releaseOpen = (): void => undefined;
  const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let abortedAtReturn = false;
  let opens = 0;
  const host = serve(async (runtimeId, signal) => {
    if (runtimeId !== "main") return null;
    opens += 1;
    const resources = await openJsonlRuntime(file, modelOptions());
    await gate;
    abortedAtReturn = signal.aborted;
    return resources;
  });
  try {
    const { client, remote } = await host.connect();
    const attaching = remote.attach("main");
    const failure = attaching.then(() => undefined, (error: unknown) => error);
    await until(() => opens === 1, "the open to take the lock");
    await assertBusy(file);
    await client.disconnect();
    await until(() => host.server.connectionCount === 0, "the waiter to leave");
    releaseOpen();
    const error = await failure;
    assert.ok(error instanceof Error);
    assert.equal(abortedAtReturn, true);
    await until(async () => {
      try {
        const probe = openJsonlOwner(file);
        await probe.release();
        return true;
      } catch (cause) {
        if (cause instanceof StorageBusyError) return false;
        throw cause;
      }
    }, "the discarded runtime to release the lock");
    assert.equal(existsSync(file), true);
    assert.equal(opens, 1);
    const again = await host.connect();
    await again.remote.attach("main");
    assert.equal(opens, 2);
    assert.deepEqual(texts(await again.remote.lane("main").snapshot()), []);
  } finally {
    releaseOpen();
    await host.close();
  }
});

test("remove during open keeps the lock until the handle arrives and removes each owner once", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  let releaseOpen = (): void => undefined;
  const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let opens = 0;
  const removals: number[] = [];
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    opens += 1;
    const index = removals.push(0) - 1;
    const resources = await openJsonlRuntime(file, modelOptions());
    await gate;
    return {
      ...resources,
      async remove() { removals[index]! += 1; await resources.remove(); },
    };
  });
  try {
    const waiting = await host.connect();
    const attaching = waiting.remote.attach("main");
    const failure = attaching.then(() => undefined, (error: unknown) => error);
    await until(() => opens === 1, "the open to take the lock");
    await assertBusy(file);
    const remover = await host.connect();
    const removing = remover.remote.remove("main");
    let removed = false;
    void removing.then(() => { removed = true; }, () => { removed = true; });
    const other = await host.connect();
    await assert.rejects(other.remote.attach("main"), (error: unknown) => error instanceof RemoteError && error.code === "runtime_busy");
    await flush();
    assert.equal(removed, false);
    assert.equal(existsSync(file), true);
    await assertBusy(file);
    releaseOpen();
    await removing;
    const error = await failure;
    assert.ok(error instanceof RemoteError && error.code === "runtime_busy");
    assert.equal(existsSync(file), false);
    await remover.remote.remove("main");
    assert.equal(existsSync(file), false);
    assert.deepEqual(removals, [1, 1], "a later removal acquires a new owner instead of cleaning the old one twice");
    await assertFree(file);
    const again = await host.connect();
    await again.remote.attach("main");
    assert.equal(opens, 3);
    assert.deepEqual(removals, [1, 1, 0]);
    assert.deepEqual(texts(await again.remote.lane("main").snapshot()), []);
  } finally {
    releaseOpen();
    await host.close();
  }
});

test("remove waits for a running tool and acquires new ownership for a later removal", timeout, async (t) => {
  const file = join(directory(t), "lane.jsonl");
  const tools: ReturnType<typeof gatedTool>[] = [];
  const removals: number[] = [];
  const host = serve(async (runtimeId) => {
    if (runtimeId !== "main") return null;
    const tool = gatedTool();
    tools.push(tool);
    const index = removals.push(0) - 1;
    const resources = await openJsonlRuntime(file, {
      models: tool.models,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [tool.tool],
    });
    return {
      ...resources,
      async remove() { removals[index]! += 1; await resources.remove(); },
    };
  });
  try {
    const first = await host.connect();
    await first.remote.attach("main");
    const lane = first.remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const driving = lane.drive("op");
    await tools[0]!.ready;
    const remover = await host.connect();
    const removing = remover.remote.remove("main");
    let removed = false;
    void removing.then(() => { removed = true; }, () => { removed = true; });
    const other = await host.connect();
    await assert.rejects(other.remote.attach("main"), (error: unknown) => error instanceof RemoteError && error.code === "runtime_busy");
    await flush();
    assert.equal(removed, false);
    assert.equal(existsSync(file), true);
    assert.equal(tools[0]!.calls(), 1);
    await assertBusy(file);
    tools[0]!.finish();
    const outcome = await driving;
    await removing;
    assert.equal(outcome.kind, "settled");
    if (outcome.kind === "settled") assert.equal(outcome.result.status, "completed");
    assert.equal(tools[0]!.calls(), 2);
    assert.equal(existsSync(file), false);
    await remover.remote.remove("main");
    assert.equal(existsSync(file), false);
    assert.deepEqual(removals, [1, 1]);
    assert.equal(tools[1]!.calls(), 0, "opening for removal never drives the new harness");
    await assertFree(file);
    const again = await host.connect();
    await again.remote.attach("main");
    assert.equal(tools.length, 3);
    assert.deepEqual(removals, [1, 1, 0]);
    assert.equal(tools[2]!.calls(), 0);
    assert.deepEqual(texts(await again.remote.lane("main").snapshot()), []);
    assert.equal((await again.remote.lane("main").result("op")), null);
  } finally {
    tools[0]?.finish();
    await host.close();
  }
});

for (const previouslyOpened of [false, true]) {
  test(`remove deletes JSONL data after ${previouslyOpened ? "idle reclamation" : "starting a fresh server"} without driving`, timeout, async (t) => {
    const file = join(directory(t), "lane.jsonl");
    const seed = openJsonlOwner(file);
    await seed.storage.commit([{ type: "set", address: value("test", "saved"), value: "keep until removed" }]);
    await seed.release();
    const provider = fauxProvider();
    const models = createModels();
    models.setProvider(provider);
    let releases = 0;
    const host = serve(async (runtimeId) => {
      if (runtimeId !== "main") return null;
      const resources = await openJsonlRuntime(file, { models, model: { provider: "faux", modelId: "faux-1" } });
      return {
        ...resources,
        async release() { await resources.release(); releases += 1; },
      };
    });
    try {
      const { remote } = await host.connect();
      if (previouslyOpened) {
        await remote.attach("main");
        await remote.detach();
        await until(() => releases === 1, "idle reclamation to release the storage");
      }
      assert.equal(existsSync(file), true);
      await remote.remove("main");
      assert.equal(existsSync(file), false, "remove must delete persisted data even without a live slot");
      assert.equal(provider.state.callCount, 0);
      assert.equal(host.handles.length, previouslyOpened ? 2 : 1);
      await remote.remove("missing");
      assert.equal(existsSync(file), false);
    } finally {
      await host.close();
    }
  });
}
