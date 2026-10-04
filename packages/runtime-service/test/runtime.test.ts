import assert from "node:assert/strict";
import test from "node:test";
import { ClientError, RemoteError } from "@amazme/client";
import { value, type StorageView } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { encodeClientMessage, ProtocolError, type JsonValue } from "@amazme/protocol";
import { ServiceError, type RuntimeCallContext, type SubscriptionSink } from "@amazme/server";
import { ContractError, parseLaneSnapshot, type LaneSnapshotDto } from "@amazme/runtime-service";
import { NotAttachedError, RuntimeClient } from "@amazme/runtime-service/client";
import { finish, pendingText, textDelta, texts, tick, until, world } from "./support.ts";

const code = (expected: string) => (error: unknown) => error instanceof RemoteError && error.code === expected;

test("attach, accept, subscribe, drive, pending prefix, settled snapshot and result travel as protocol bytes", async () => {
  const env = world();
  try {
    const { remote, client } = await env.connect();
    const route = await remote.attach("main");
    assert.deepEqual(client.attachment, route);
    const lane = remote.lane("main");
    const admitted = await lane.accept({ kind: "prompt", text: "hi", operationId: "op-1" });
    assert.deepEqual({ operationId: admitted.operationId, kind: admitted.kind }, { operationId: "op-1", kind: "run" });

    const seen: LaneSnapshotDto[] = [];
    const subscription = await lane.subscribe((snapshot) => seen.push(snapshot));
    assert.equal(subscription.initial.phase, "starting");
    assert.deepEqual(texts(subscription.initial), ["hi"]);
    assert.equal(env.runtime().streams.length, 0, "subscribing does not drive");

    const driving = lane.drive("op-1");
    await until(() => env.runtime().streams.length === 1, "the model call");
    const stream = env.runtime().streams[0]!;
    textDelta(stream, "He", "He");
    await until(() => pendingText(subscription.current()) === "He", "the first pending prefix");
    textDelta(stream, "llo", "Hello");
    await until(() => pendingText(subscription.current()) === "Hello", "the grown prefix");
    assert.deepEqual(texts(subscription.current()), ["hi"], "the unsettled reply is not an entry");
    finish(stream, "Hello");

    const outcome = await driving;
    assert.equal(outcome.kind, "settled");
    await until(() => subscription.current().pendingResponse === null && subscription.current().operationId === null, "the settled snapshot");
    const settled = subscription.current();
    assert.deepEqual(texts(settled), ["hi", "Hello"]);
    assert.equal(settled.lastOperationId, "op-1");
    const result = await lane.result("op-1");
    assert.equal(result?.status, "completed");
    assert.deepEqual(outcome.kind === "settled" && outcome.result, result);
    assert.deepEqual(await lane.snapshot(), settled);

    const versions = seen.map((snapshot) => snapshot.version);
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
    assert.equal(new Set(versions).size, versions.length, "each installed update is newer");
    assert.ok(versions[0]! > subscription.initial.version);
    assert.ok(seen.some((snapshot) => pendingText(snapshot) === "He"));
    assert.equal(seen.filter((snapshot) => texts(snapshot).includes("Hello")).every((snapshot) => snapshot.pendingResponse === null), true, "the reply never shows twice");
    assert.equal(env.runtime().streams.length, 1);
    await subscription.close();
  } finally {
    await env.close();
  }
});

test("updates keep arriving while the model is still generating, not only when it ends", async () => {
  const env = world({ publishWindowMs: 5 });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const prefixes: string[] = [];
    const subscription = await lane.subscribe((snapshot) => {
      const text = pendingText(snapshot);
      if (text !== undefined) prefixes.push(text);
    });
    const driving = lane.drive("op");
    await until(() => env.runtime().streams.length === 1);
    const stream = env.runtime().streams[0]!;
    let text = "";
    for (let index = 0; index < 40; index++) {
      text += `${index % 10}`;
      textDelta(stream, `${index % 10}`, text);
      await tick(3);
    }
    const duringGeneration = prefixes.length;
    finish(stream, text);
    await driving;
    assert.ok(duringGeneration >= 5, `only ${duringGeneration} updates arrived while generating`);
    for (let index = 1; index < prefixes.length; index++) assert.ok(prefixes[index]!.startsWith(prefixes[index - 1]!));
    await until(() => texts(subscription.current()).at(-1) === text);
  } finally {
    await env.close();
  }
});

test("a slow subscriber gets coalesced complete snapshots and still ends on the final state", async () => {
  const env = world({ publishWindowMs: 2 });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    let delivered = 0;
    const subscription = await lane.subscribe(() => { delivered += 1; });
    const outbound = env.links[0]!.server;
    const driving = lane.drive("op");
    await until(() => env.runtime().streams.length === 1);
    const stream = env.runtime().streams[0]!;
    outbound.pause();
    let text = "";
    for (let index = 0; index < 30; index++) {
      text += "x";
      textDelta(stream, "x", text);
      if (index % 5 === 0) await tick(4);
    }
    finish(stream, text);
    const local = env.runtime().harness.lane("main");
    await until(async () => (await local.inspect()).operationId === null, "settlement while the subscriber is stalled");
    const writes = (await local.snapshot()).version - subscription.initial.version;
    outbound.resume();
    await driving;
    const final = await local.snapshot();
    await until(() => subscription.current().version === final.version, "the final snapshot");
    assert.deepEqual(subscription.current(), parseLaneSnapshot(JSON.parse(JSON.stringify(final))));
    assert.ok(delivered < writes, `${delivered} updates for ${writes} writes`);
  } finally {
    await env.close();
  }
});

test("cancelling the drive RPC stops only the wait; the operation completes and stays queryable", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const controller = new AbortController();
    const waiting = lane.drive("op", { signal: controller.signal });
    await until(() => env.runtime().streams.length === 1);
    controller.abort();
    await assert.rejects(waiting, (error) => error instanceof Error && error.name === "AbortError");
    await tick();
    const during = await lane.snapshot();
    assert.equal(during.status, "open", "an RPC cancel is not a business abort");
    assert.equal(during.phase, "assistant_effect_pending");
    finish(env.runtime().streams[0]!, "done");
    await until(async () => (await lane.result("op")) !== null, "the operation to settle in the background");
    assert.equal((await lane.result("op"))?.status, "completed");
    assert.equal(env.runtime().streams.length, 1);
    assert.equal((await lane.drive("op")).kind, "settled", "driving a settled operation returns its result");
  } finally {
    await env.close();
  }
});

test("only requestAbort cancels; unsubscribe, detach, disconnect and reattach do not", async () => {
  const env = world();
  try {
    const first = await env.connect();
    await first.remote.attach("main");
    const lane = first.remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const subscription = await lane.subscribe(() => undefined);
    const driving = lane.drive("op");
    await until(() => env.runtime().streams.length === 1);
    await subscription.close();
    await first.remote.detach();
    const local = env.runtime().harness.lane("main");
    assert.equal((await local.inspect()).status, "open");
    await first.client.disconnect();
    await assert.rejects(driving, (error) => error instanceof ClientError && error.code === "disconnected");
    assert.equal((await local.inspect()).status, "open");

    const second = await env.connect();
    await second.remote.attach("main");
    const again = second.remote.lane("main");
    assert.equal((await again.snapshot()).status, "open");
    assert.deepEqual(await again.requestAbort("op"), { operationId: "op", newlyRequested: true });
    assert.equal((await again.snapshot()).status, "aborting");
    assert.deepEqual(await again.requestAbort("op"), { operationId: "op", newlyRequested: false });
    finish(env.runtime().streams[0]!, "ignored");
    await until(async () => (await again.result("op")) !== null);
    assert.equal((await again.result("op"))?.status, "aborted");
    await assert.rejects(again.requestAbort("op"), code("operation_mismatch"));
  } finally {
    await env.close();
  }
});

test("after a disconnect the drive keeps going, nothing is resent, and another connection reads the settled state", async () => {
  const env = world();
  try {
    const first = await env.connect();
    const second = await env.connect();
    await first.remote.attach("main");
    await second.remote.attach("main");
    const lane = first.remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const ended: string[] = [];
    const subscription = await lane.subscribe(() => undefined);
    void subscription.ended.then((end) => ended.push(end.reason));
    const driving = lane.drive("op");
    await until(() => env.runtime().streams.length === 1);
    textDelta(env.runtime().streams[0]!, "part", "part");
    env.links[0]!.client.destroy(new Error("cable pulled"));
    await assert.rejects(driving, (error) => error instanceof ClientError && error.code === "transport_error");
    await until(() => ended.length === 1);
    assert.deepEqual(ended, ["disconnected"]);
    await assert.rejects(lane.snapshot(), (error) => error instanceof NotAttachedError);

    finish(env.runtime().streams[0]!, "part and rest");
    const other = second.remote.lane("main");
    await until(async () => (await other.result("op")) !== null, "the operation to settle");
    assert.deepEqual(texts(await other.snapshot()), ["go", "part and rest"]);
    assert.equal((await other.result("op"))?.status, "completed");
    assert.equal(env.runtime().streams.length, 1, "the model request was not resent");
    assert.equal(env.runtime().harness.isClosed, false, "a remaining attachment keeps the runtime");

    const finished = env.runtime();
    await second.remote.detach();
    await until(() => finished.harness.isClosed, "idle reclaim");
    await second.remote.attach("main");
    assert.notEqual(env.runtime().harness, finished.harness);
    assert.equal(env.runtime().streams.length, 0, "reopening does not drive");
    assert.deepEqual(texts(await second.remote.lane("main").snapshot()), []);
  } finally {
    await env.close();
  }
});

test("runtimes, lanes, attachments and subscriptions stay isolated", async () => {
  const env = world({ runtimes: ["main", "other"], lanes: ["main", "side"] });
  try {
    const { remote, client } = await env.connect();
    const mainRoute = await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    await assert.rejects(remote.lane("side").result("op"), code("operation_mismatch"));
    await assert.rejects(remote.lane("hidden").snapshot(), code("unknown_lane"));
    await assert.rejects(client.request(mainRoute, { method: "snapshot", lane: "bad lane" }), code("invalid_call"));
    await assert.rejects(client.request(mainRoute, { method: "drive", lane: "main", operationId: "op", extra: true }), code("invalid_call"));
    await assert.rejects(client.request(mainRoute, { method: "unsubscribe", subscriptionId: "s99" }), code("unknown_subscription"));
    assert.throws(() => remote.lane("no spaces"), ContractError);

    const updates: LaneSnapshotDto[] = [];
    const subscription = await lane.subscribe((snapshot) => updates.push(snapshot));
    const otherRoute = await remote.attach("other");
    assert.notEqual(otherRoute.attachmentId, mainRoute.attachmentId);
    assert.deepEqual(await subscription.ended, { reason: "detached" });
    await env.runtime("main").storage.commit([{ type: "set", address: value("test.after_switch"), value: 1 }]);
    await tick(20);
    assert.deepEqual(updates, [], "the old subscription receives nothing after the switch");
    await assert.rejects(client.request(mainRoute, { method: "snapshot", lane: "main" }), code("not_attached"));
    const otherSnapshot = await remote.lane("main").snapshot();
    assert.equal(otherSnapshot.operationId, null, "the other runtime has its own storage");
    assert.equal(await remote.lane("main").result("op"), null);

    const peer = await env.connect();
    await assert.rejects(peer.client.request(otherRoute, { method: "snapshot", lane: "main" }), code("not_attached"));
    await assert.rejects(peer.remote.attach("nowhere"), code("unknown_runtime"));
  } finally {
    await env.close();
  }
});

test("queries never start a drive, and steer and follow-up enqueue without driving", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const before = await lane.snapshot();
    assert.equal(await lane.result("op"), null);
    await lane.snapshot();
    assert.equal((await lane.snapshot()).version, before.version);
    const steered = await lane.steer("also this");
    const followed = await lane.followUp("and later");
    assert.equal(typeof steered.entryId, "string");
    assert.notEqual(steered.entryId, followed.entryId);
    await tick(20);
    assert.equal(env.runtime().streams.length, 0);
    assert.equal((await lane.snapshot()).phase, "starting");
    await assert.rejects(lane.accept({ kind: "prompt", text: "second" }), code("lane_busy"));
  } finally {
    await env.close();
  }
});

test("draining stops admission and subscriptions without persisting requestAbort", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    let updates = 0;
    const subscription = await lane.subscribe(() => { updates += 1; });
    const waiting = lane.drive("op");
    await until(() => env.runtime().streams.length === 1);
    const handle = env.runtime().handle;
    let drained = false;
    const closing = handle.close("drain");
    assert.equal(handle.close("drain"), closing);
    void closing.then(() => { drained = true; });
    await tick();
    assert.equal(drained, false, "the running model keeps the drain open");
    assert.equal(env.runtime().harness.signal().aborted, false);
    assert.equal((await env.runtime().harness.lane("main").inspect()).status, "open");
    assert.deepEqual(await subscription.ended, { reason: "ended", code: "runtime_closed", message: "the runtime host is closed" });
    await assert.rejects(lane.snapshot(), code("runtime_closed"));
    textDelta(env.runtime().streams[0]!, "more", "more");
    await env.runtime().storage.commit([{ type: "set", address: value("test.noise"), value: 1 }]);
    await tick(20);
    assert.equal(updates, 0, "released subscriptions deliver nothing");
    assert.equal(drained, false);
    finish(env.runtime().streams[0]!, "done");
    await closing;
    assert.equal((await waiting).kind, "settled");
    const settled = await env.runtime().harness.lane("main").result("op");
    assert.equal(settled.ok && settled.value?.status, "completed");
  } finally {
    await env.close();
  }
});

class AfterRead extends MemoryStorage {
  once?: () => Promise<unknown>;
  override async read<T>(fn: (view: StorageView) => T): Promise<T> {
    const result = await super.read(fn);
    const hook = this.once;
    this.once = undefined;
    if (hook) await hook();
    return result;
  }
}

class OnUnsubscribe extends MemoryStorage {
  once?: () => void;
  override subscribe(listener: () => void): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      unsubscribe();
      const hook = this.once;
      this.once = undefined;
      hook?.();
    };
  }
}

test("the host is already closed during synchronous subscription cleanup callbacks", async () => {
  const storage = new OnUnsubscribe();
  const env = world({ storage: () => storage });
  try {
    const { remote } = await env.connect();
    const route = await remote.attach("main");
    await remote.lane("main").subscribe(() => undefined);
    const { handle, service } = env.runtime();
    let checked: Promise<void> | undefined;
    const context: RuntimeCallContext = {
      connectionId: "reentrant",
      route,
      signal: new AbortController().signal,
      openSubscription() { throw new Error("unused"); },
      subscription() { return undefined; },
    };
    storage.once = () => {
      checked = assert.rejects(
        () => Promise.resolve(service.call({ method: "snapshot", lane: "main" }, context)),
        (error: unknown) => error instanceof ServiceError && error.code === "runtime_closed",
      );
    };
    await handle.close("drain");
    assert.ok(checked);
    await checked;
  } finally {
    await env.close();
  }
});

test("a write right after the initial snapshot read still produces an update", async () => {
  const storage = new AfterRead();
  const env = world({ storage: () => storage });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    storage.once = () => storage.commit([{ type: "set", address: value("test.after_initial"), value: 1 }]);
    const subscription = await lane.subscribe(() => undefined);
    await until(() => subscription.current().version > subscription.initial.version, "the missed-write update");
    assert.equal(subscription.current().version, await storage.read((view) => view.version()));
  } finally {
    await env.close();
  }
});

test("a write that lands during a publish read is published afterwards", async () => {
  const storage = new AfterRead();
  const env = world({ storage: () => storage });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const subscription = await remote.lane("main").subscribe(() => undefined);
    storage.once = () => storage.commit([{ type: "set", address: value("test.during_read"), value: 2 }]);
    await storage.commit([{ type: "set", address: value("test.before_read"), value: 1 }]);
    const latest = subscription.initial.version + 2;
    await until(() => subscription.current().version === latest, "the write made during the read");
    assert.equal(await storage.read((view) => view.version()), latest);
  } finally {
    await env.close();
  }
});

test("closing the host waits for an initial snapshot read and refuses that unfinished subscription", async () => {
  const storage = new AfterRead();
  const env = world({ storage: () => storage });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    let reading = false;
    storage.once = async () => { reading = true; await blocked; };
    const subscribing = remote.lane("main").subscribe(() => undefined);
    const rejected = assert.rejects(subscribing, code("runtime_closed"));
    await until(() => reading, "the initial snapshot read");
    let closed = false;
    const closing = env.runtime().handle.close("drain").then(() => { closed = true; });
    await tick();
    assert.equal(closed, false, "the host still owns the initial read");
    release();
    await closing;
    await rejected;
  } finally {
    release();
    await env.close();
  }
});

test("closing the host does not wait for a stalled peer, and the end notice follows the snapshot in flight", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const subscription = await remote.lane("main").subscribe(() => undefined);
    const outbound = env.links[0]!.server;
    outbound.pause();
    await env.runtime().storage.commit([{ type: "set", address: value("test.stalled"), value: 1 }]);
    await until(() => outbound.queuedBytes > 0, "the snapshot in flight");
    const started = Date.now();
    await env.runtime().handle.close("drain");
    assert.ok(Date.now() - started < 500, "close returned while the peer was not reading");
    outbound.resume();
    const ended = await subscription.ended;
    assert.equal(ended.reason === "ended" && ended.code, "runtime_closed");
    assert.equal(subscription.current().version, subscription.initial.version + 1, "the snapshot in flight arrived first");
  } finally {
    await env.close();
  }
});

test("large subscriptions on one slow connection take turns instead of overflowing it", async () => {
  const env = world({ limits: { maxFrameBytes: 64 * 1024 } });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lanes = ["l1", "l2", "l3"];
    for (const name of lanes) await env.runtime().harness.lane(name).accept({ kind: "prompt", text: "b".repeat(50 * 1024) });
    const subscriptions = await Promise.all(lanes.map((name) => remote.lane(name).subscribe(() => undefined)));
    const outbound = env.links[0]!.server;
    outbound.pause();
    await env.runtime().storage.commit([{ type: "set", address: value("test.all_lanes"), value: 1 }]);
    await tick(60);
    assert.equal(env.server.connectionCount, 1, "the connection survived");
    outbound.resume();
    const version = await env.runtime().storage.read((view) => view.version());
    await until(() => subscriptions.every((subscription) => subscription.current().version === version), "every lane to catch up");
  } finally {
    await env.close();
  }
});

test("large initial subscriptions on a slow connection also take turns", async () => {
  const env = world({ limits: { maxFrameBytes: 64 * 1024 } });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lanes = ["l1", "l2", "l3"];
    for (const name of lanes) await env.runtime().harness.lane(name).accept({ kind: "prompt", text: "b".repeat(50 * 1024) });
    const outbound = env.links[0]!.server;
    outbound.pause();
    const subscribing = Promise.all(lanes.map((name) => remote.lane(name).subscribe(() => undefined)));
    await tick(60);
    assert.equal(env.server.connectionCount, 1, "initial snapshots obey transport backpressure");
    outbound.resume();
    const subscriptions = await subscribing;
    assert.deepEqual(subscriptions.map((subscription) => subscription.initial.lane), lanes);
    assert.ok(subscriptions.every((subscription) => subscription.initial.entries.length === 1));
  } finally {
    for (const link of env.links) link.server.resume();
    await env.close();
  }
});

test("a stalled connection does not block another connection's snapshot", async () => {
  const env = world();
  try {
    const first = await env.connect();
    await first.remote.attach("main");
    await first.remote.lane("main").subscribe(() => undefined);
    env.links[0]!.server.pause();
    await env.runtime().storage.commit([{ type: "set", address: value("test.two_connections"), value: 1 }]);
    await until(() => env.links[0]!.server.queuedBytes > 0, "the first connection's stalled snapshot");
    const second = await env.connect();
    await second.remote.attach("main");
    let opened = false;
    const opening = second.remote.lane("main").subscribe(() => undefined);
    void opening.then(() => { opened = true; }, () => undefined);
    await until(() => opened, "the independent connection's initial snapshot", 500);
    assert.equal((await opening).initial.version, 1);
  } finally {
    for (const link of env.links) link.server.resume();
    await env.close();
  }
});

test("a snapshot too large to send ends the subscription with a notice instead of going silent", async () => {
  const env = world({ limits: { maxFrameBytes: 8 * 1024 } });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const subscription = await remote.lane("main").subscribe(() => undefined);
    await env.runtime().harness.lane("main").accept({ kind: "prompt", text: "s".repeat(10 * 1024) });
    assert.deepEqual(await subscription.ended, { reason: "ended", code: "snapshot_unavailable", message: "the lane snapshot could not be sent" });
    assert.ok(env.errors.length > 0 && env.errors.every((error) => error instanceof ProtocolError && error.code === "limit_exceeded"));
    env.errors.length = 0;
  } finally {
    await env.close();
  }
});

test("operations admitted in process with opaque IDs can be observed, driven, aborted and queried remotely", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const operationId = "job 42/a";
    await env.runtime().harness.lane("main").accept({ kind: "prompt", text: "hi", operationId });
    const lane = remote.lane("main");
    assert.equal((await lane.snapshot()).operationId, operationId);
    const subscription = await lane.subscribe(() => undefined);
    assert.equal(subscription.initial.operationId, operationId);
    assert.equal(await lane.result(operationId), null);
    const driving = lane.drive(operationId);
    await until(() => env.runtime().streams.length === 1);
    assert.deepEqual(await lane.requestAbort(operationId), { operationId, newlyRequested: true });
    finish(env.runtime().streams[0]!, "ignored");
    const outcome = await driving;
    assert.equal(outcome.kind, "settled");
    const result = await lane.result(operationId);
    assert.equal(result?.operationId, operationId);
    assert.equal(result?.status, "aborted");
    await assert.rejects(remote.lane("other").result(operationId), code("operation_mismatch"));
    await assert.rejects(lane.result("bad\0id"), code("invalid_call"));
  } finally {
    await env.close();
  }
});

test("an update that breaks the contract ends the subscription with invalid_update", async () => {
  const env = world();
  try {
    const sinks: SubscriptionSink[] = [];
    env.allow("fake", {
      async call(raw, context) {
        const call = raw as { method: string; subscriptionId: string };
        if (call.method === "unsubscribe") context.subscription(call.subscriptionId)?.close();
        if (call.method !== "subscribe") return null;
        sinks.push(context.openSubscription(call.subscriptionId));
        return { version: 1, lane: "main", tipId: null, phase: null, operationId: null, lastOperationId: null, status: null, entries: [], pendingResponse: null };
      },
    });
    const { remote } = await env.connect();
    await remote.attach("fake");
    const subscription = await remote.lane("main").subscribe(() => undefined);
    await sinks[0]!.send({ kind: "snapshot", snapshot: { version: 2, lane: "other" } });
    const ended = await subscription.ended;
    assert.equal(ended.reason === "ended" && ended.code, "invalid_update");
    await until(() => sinks[0]!.closed, "the client to unsubscribe");
  } finally {
    await env.close();
  }
});

test("mutating exposed snapshots cannot change subscription version tracking", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const seen: number[] = [];
    const subscription = await remote.lane("main").subscribe((snapshot) => {
      seen.push(snapshot.version);
      Object.assign(snapshot, { version: Number.MAX_SAFE_INTEGER });
    });
    const initialVersion = subscription.initial.version;
    Object.assign(subscription.initial, { version: Number.MAX_SAFE_INTEGER });
    await env.runtime().storage.commit([{ type: "set", address: value("test.version"), value: 1 }]);
    await until(() => seen.length === 1, "an update after the initial DTO was modified");
    Object.assign(subscription.current(), { version: Number.MAX_SAFE_INTEGER });
    await env.runtime().storage.commit([{ type: "set", address: value("test.version"), value: 2 }]);
    await until(() => seen.length === 2, "an update after the callback modified the DTO");
    assert.deepEqual(seen, [initialVersion + 1, initialVersion + 2]);
  } finally {
    await env.close();
  }
});

test("operation replies must belong to the requested lane and operation", async () => {
  const env = world();
  try {
    let reply: JsonValue = null;
    env.allow("fake", { call() { return reply; } });
    const { remote } = await env.connect();
    await remote.attach("fake");
    const lane = remote.lane("main");
    const result = {
      operationId: "op", lane: "main", kind: "run", status: "completed", fromTipId: null, tipId: null,
      startedAt: 1, endedAt: 2,
    };
    const cases: Array<{ reply: JsonValue; invoke: () => Promise<unknown> }> = [
      { reply: { result: { ...result, lane: "other" } }, invoke: () => lane.result("op") },
      { reply: { result: { ...result, operationId: "other" } }, invoke: () => lane.result("op") },
      { reply: { kind: "settled", result: { ...result, lane: "other" } }, invoke: () => lane.drive("op") },
      { reply: { kind: "settled", result: { ...result, operationId: "other" } }, invoke: () => lane.drive("op") },
      { reply: { kind: "waiting", operationId: "other", reason: "retry", notBefore: 3 }, invoke: () => lane.drive("op") },
      { reply: { operationId: "other", newlyRequested: true }, invoke: () => lane.requestAbort("op") },
    ];
    for (const entry of cases) {
      reply = entry.reply;
      await assert.rejects(entry.invoke(), ContractError);
    }
    reply = { result };
    assert.deepEqual(await lane.result("op"), result);
  } finally {
    await env.close();
  }
});

test("contracts reject malformed calls and replies instead of trusting their types", async () => {
  const env = world();
  try {
    const { client } = await env.connect();
    const route = await new RuntimeClient(client).attach("main");
    for (const call of [
      { method: "accept", lane: "main", request: { kind: "prompt" } },
      { method: "accept", lane: "main", request: { kind: "prompt", text: "x", operationId: "" } },
      { method: "result", lane: "main" },
      { method: "subscribe", lane: "main", subscriptionId: "s1", extra: 1 },
      { method: "explode" },
      "accept",
    ] as JsonValue[]) {
      await assert.rejects(client.request(route, call), code("invalid_call"), JSON.stringify(call));
    }
    assert.throws(() => parseLaneSnapshot({ version: 1 }), ContractError);
    assert.throws(() => parseLaneSnapshot({ version: -1, lane: "main", tipId: null, phase: null, operationId: null, lastOperationId: null, status: null, entries: [], pendingResponse: null }), ContractError);
    assert.throws(() => parseLaneSnapshot({ version: 1, lane: "main", tipId: null, phase: "secret_internal", operationId: null, lastOperationId: null, status: null, entries: [], pendingResponse: null }), ContractError);
    assert.ok(encodeClientMessage({ type: "request", id: "r", route, call: { method: "snapshot", lane: "main" } }).byteLength > 0);
  } finally {
    await env.close();
  }
});
