import assert from "node:assert/strict";
import test from "node:test";
import { Client, ClientError, RemoteError, type ByteTransportHandlers, type ClientOptions } from "@amazme/client";
import {
  ClientMessageDecoder,
  encodeClientMessage,
  encodeServerMessage,
  ServerMessageDecoder,
  type JsonValue,
  type Route,
  type ServerMessage,
} from "@amazme/protocol";
import {
  Server,
  ServiceError,
  type CallContext,
  type ServerCallContext,
  type ServerOptions,
  type ServerService,
  type SubscriptionSink,
} from "@amazme/server";
import { chunksOf, createMemoryLink, memoryConnector, type MemoryLink, type PipeOptions } from "@amazme/server/testing";

type Call = { op: string; [key: string]: JsonValue };

const links: MemoryLink[] = [];
test.afterEach(() => {
  for (const link of links.splice(0)) {
    assert.deepEqual(link.client.handlerErrors, [], "client handlers must not throw");
    assert.deepEqual(link.server.handlerErrors, [], "server handlers must not throw");
  }
});

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: Partial<ServerOptions> = {}, pipes: { clientToServer?: PipeOptions; serverToClient?: PipeOptions } = {}) {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const gate = (name: string) => {
    let entry = gates.get(name);
    if (!entry) gates.set(name, entry = deferred());
    return entry;
  };
  const signals: AbortSignal[] = [];
  const sinks: SubscriptionSink[] = [];
  const contexts: ServerCallContext[] = [];
  const attachErrors: unknown[] = [];
  const errors: Error[] = [];
  const common = async (call: Call, context: CallContext): Promise<JsonValue | undefined> => {
    if (call.op === "echo") return call.value;
    if (call.op === "big") return "y".repeat(call.size as number);
    if (call.op === "fail") throw new ServiceError(call.code as string, "requested failure");
    if (call.op === "boom") throw new Error("secret detail");
    if (call.op === "wait") {
      signals.push(context.signal);
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return "late";
    }
    if (call.op === "gate") {
      signals.push(context.signal);
      await gate(call.name as string).promise;
      return call.name;
    }
    if (call.op === "subscribe") {
      const sink = context.openSubscription(call.subscriptionId as string);
      sinks.push(sink);
      if (call.early !== undefined) void sink.send(call.early);
      return { initial: call.initial ?? null };
    }
    if (call.op === "lateSubscribe") {
      setTimeout(() => {
        try {
          context.openSubscription("late");
        } catch (error) {
          attachErrors.push(error);
        }
      }, 0);
      return null;
    }
    if (call.op === "unsubscribe") {
      context.subscription(call.subscriptionId as string)?.close();
      return null;
    }
    if (call.op === "whoami") return { route: context.route as unknown as JsonValue, connection: context.connectionId };
    throw new ServiceError("unknown_call", call.op);
  };
  const service: ServerService = {
    async call(raw, context) {
      const call = raw as Call;
      if (call.op === "attach" || call.op === "gatedAttach") {
        if (call.op === "gatedAttach") await gate(call.name as string).promise;
        try {
          context.attach(call.runtimeId as string);
        } catch (error) {
          attachErrors.push(error);
          throw error;
        }
        return { attached: true };
      }
      if (call.op === "detach") {
        context.detach();
        return null;
      }
      if (call.op === "keep") {
        contexts.push(context);
        return null;
      }
      return common(call, context);
    },
  };
  const server = new Server({ serverId: "srv", service, onError: (error) => errors.push(error), ...options });
  const runtime = { call: (raw: JsonValue, context: CallContext) => common(raw as Call, context) };
  const unregister = { a: server.registerRuntime("rt.a", runtime), b: server.registerRuntime("rt.b", runtime) };
  const connector = memoryConnector((connection) => server.accept(connection), pipes);
  const transport: ClientOptions["transport"] = (handlers) => {
    const end = connector.transport(handlers);
    links.push(connector.links.at(-1)!);
    return end;
  };
  const client = (extra: Partial<ClientOptions> = {}) => new Client({ serverId: "srv", transport, ...extra });
  return { server, client, connector, transport, gate, signals, sinks, attachErrors, errors, unregister, contexts };
}

async function attach(client: Client, runtimeId: string) {
  const result = await client.request(client.serverRoute(), { op: "attach", runtimeId });
  assert.deepEqual(result, { attached: true }, "the business result carries no route identity");
  return client.attachment!;
}

function code(expected: string) {
  return (error: unknown) => (error instanceof RemoteError || error instanceof ClientError) && error.code === expected;
}

function rawPeer(server: Server) {
  const link = createMemoryLink();
  links.push(link);
  const messages: ServerMessage[] = [];
  const decoder = new ServerMessageDecoder();
  let closed = false;
  link.server.attach(server.accept(link.server));
  link.client.attach({ onData: (chunk) => messages.push(...decoder.push(chunk)), onClose: () => { closed = true; }, onError: () => { closed = true; } });
  return { link, messages, closed: () => closed, send: (bytes: Uint8Array) => void link.client.send(bytes).catch(() => undefined) };
}

test("the handshake verifies the logical server ID and requests wait for it", async () => {
  const { client, server } = fixture();
  const first = client();
  await assert.rejects(first.request(first.serverRoute(), { op: "echo", value: 1 }), code("not_connected"));
  const hello = await first.connect();
  assert.equal(hello.serverId, "srv");
  assert.equal(first.state, "connected");
  assert.equal(await first.request(first.serverRoute(), { op: "echo", value: 1 }), 1);
  await assert.rejects(first.connect(), code("already_connected"));

  const wrong = client({ serverId: "elsewhere" });
  await assert.rejects(wrong.connect(), code("server_mismatch"));
  assert.equal(wrong.state, "disconnected");
  await until(() => server.connectionCount === 1, "the mismatched connection to close");
  await first.dispose();
  await server.close();
});

test("an unsupported version or a missing hello ends the connection with hello_error", async () => {
  const { server } = fixture();
  for (const [first, expected] of [
    [encodeClientMessage({ type: "hello", version: 2 }), "unsupported_version"],
    [encodeClientMessage({ type: "request", id: "r1", route: { serverId: "srv" }, call: null }), "protocol_error"],
    [new Uint8Array([0, 0, 0, 1, 0xc1]), "protocol_error"],
  ] as const) {
    const peer = rawPeer(server);
    peer.send(first);
    await until(peer.closed, "the server to close");
    assert.deepEqual(peer.messages.map((message) => message.type === "hello_error" && message.error.code), [expected]);
  }
  await until(() => server.connectionCount === 0);
  await server.close();
});

test("requests correlate by ID while handlers finish out of order, keeping service codes but not internal details", async () => {
  const { client, server, gate, errors } = fixture();
  const peer = client();
  await peer.connect();
  const route = peer.serverRoute();
  const a = peer.request(route, { op: "gate", name: "a" });
  const b = peer.request(route, { op: "gate", name: "b" });
  const c = peer.request(route, { op: "echo", value: { nested: [1, "x"] } });
  assert.deepEqual(await c, { nested: [1, "x"] });
  gate("b").resolve();
  assert.equal(await b, "b");
  gate("a").resolve();
  assert.equal(await a, "a");
  await assert.rejects(peer.request(route, { op: "fail", code: "conflict" }), (error) => error instanceof RemoteError && error.code === "conflict" && error.message === "requested failure");
  await assert.rejects(peer.request(route, { op: "boom" }), (error) => error instanceof RemoteError && error.code === "internal" && !error.message.includes("secret"));
  assert.ok(errors.some((error) => error.message === "secret detail"));
  await peer.dispose();
  await server.close();
});

test("cancel aborts only the call context and the late response does not settle the request again", async () => {
  const { client, server, signals } = fixture();
  const peer = client();
  await peer.connect();
  const controller = new AbortController();
  const waiting = peer.request(peer.serverRoute(), { op: "wait" }, { signal: controller.signal });
  await until(() => signals.length === 1);
  controller.abort();
  await assert.rejects(waiting, (error) => error instanceof Error && error.name === "AbortError");
  await until(() => signals[0]!.aborted, "the server call to be aborted");
  await tick();
  assert.equal(peer.state, "connected", "the late cancelled response is not a protocol error");
  assert.equal(await peer.request(peer.serverRoute(), { op: "echo", value: 2 }), 2);
  const already = new AbortController();
  already.abort();
  await assert.rejects(peer.request(peer.serverRoute(), { op: "echo", value: 3 }, { signal: already.signal }), (error) => error instanceof Error && error.name === "AbortError");
  await peer.dispose();
  await server.close();
});

test("admission checks the whole route against this server and the connection's current attachment", async () => {
  const { client, server, unregister } = fixture();
  const peer = client();
  await peer.connect();
  const ask = (route: Route) => peer.request(route, { op: "whoami" });
  await assert.rejects(peer.request({ serverId: "other" }, { op: "echo", value: 1 }), code("wrong_server"));
  await assert.rejects(ask({ serverId: "srv", runtimeId: "rt.a", attachmentId: "guess" }), code("not_attached"));

  const changes: unknown[] = [];
  peer.onAttachmentChange((attachment) => changes.push(attachment));
  const a = await attach(peer, "rt.a");
  assert.equal(a.runtimeId, "rt.a");
  assert.deepEqual(((await ask(a)) as { route: unknown }).route, a);
  await assert.rejects(ask({ ...a, attachmentId: "forged" }), code("stale_attachment"));
  assert.deepEqual(await attach(peer, "rt.a"), a, "attaching the same runtime keeps the attachment");

  const b = await attach(peer, "rt.b");
  assert.notEqual(b.attachmentId, a.attachmentId);
  await assert.rejects(ask(a), code("not_attached"));
  assert.deepEqual(((await ask(b)) as { route: unknown }).route, b);
  await assert.rejects(peer.request(peer.serverRoute(), { op: "attach", runtimeId: "rt.none" }), code("unknown_runtime"));

  await peer.request(peer.serverRoute(), { op: "detach" });
  assert.equal(peer.attachment, null);
  await assert.rejects(ask(b), code("not_attached"));

  await attach(peer, "rt.a");
  unregister.a();
  await until(() => peer.attachment === null, "unregistering to detach");
  assert.deepEqual(changes.map((change) => (change as { runtimeId?: string } | null)?.runtimeId ?? null), ["rt.a", "rt.b", null, "rt.a", null]);
  await peer.dispose();
  await server.close();
});

test("two connections reuse request IDs and attachments without affecting each other", async () => {
  const { client, server, gate, signals } = fixture();
  const one = client();
  const two = client();
  await Promise.all([one.connect(), two.connect()]);
  const controller = new AbortController();
  const first = one.request(one.serverRoute(), { op: "gate", name: "one" }, { signal: controller.signal });
  const second = two.request(two.serverRoute(), { op: "gate", name: "two" });
  await until(() => signals.length === 2);
  controller.abort();
  await assert.rejects(first, (error) => error instanceof Error && error.name === "AbortError");
  await until(() => signals.filter((signal) => signal.aborted).length === 1);
  gate("two").resolve();
  assert.equal(await second, "two");
  assert.equal(signals.filter((signal) => signal.aborted).length, 1, "the same request ID on another connection was not cancelled");

  const route = await attach(one, "rt.a");
  assert.equal(two.attachment, null);
  await assert.rejects(two.request(route, { op: "whoami" }), code("not_attached"));
  gate("one").resolve();
  await Promise.all([one.dispose(), two.dispose()]);
  await server.close();
});

test("a duplicate active request ID closes the connection and aborts its calls", async () => {
  const { server, signals, gate } = fixture();
  const peer = rawPeer(server);
  peer.send(encodeClientMessage({ type: "hello", version: 1 }));
  const request = encodeClientMessage({ type: "request", id: "same", route: { serverId: "srv" }, call: { op: "gate", name: "never" } });
  peer.send(request);
  await until(() => signals.length === 1);
  peer.send(request);
  await until(peer.closed);
  assert.deepEqual(peer.messages.map((message) => message.type === "hello_error" ? message.error.code : message.type), ["hello", "duplicate_request"]);
  assert.equal(signals[0]!.aborted, true);
  gate("never").resolve();
  await server.close();
});

test("losing the connection rejects pending work, aborts server calls, ends subscriptions and never reconnects", async () => {
  const { client, server, connector, signals, sinks } = fixture();
  const peer = client();
  await peer.connect();
  const route = await attach(peer, "rt.a");
  const updates: JsonValue[] = [];
  const subscription = await peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId }), (update) => updates.push(update));
  subscription.start();
  const pending = peer.request(route, { op: "wait" });
  await until(() => signals.length === 1);

  connector.links[0]!.client.destroy(new Error("network down"));
  await assert.rejects(pending, code("transport_error"));
  const ended = await subscription.ended;
  assert.equal(ended.reason, "disconnected");
  assert.equal(peer.attachment, null);
  assert.equal(peer.state, "disconnected");
  await until(() => signals[0]!.aborted && sinks[0]!.closed && server.connectionCount === 0, "the server to release the connection");
  assert.equal(await sinks[0]!.send(1), false);
  await tick();
  assert.equal(connector.links.length, 1, "no automatic reconnect");

  await peer.connect();
  assert.equal(connector.links.length, 2);
  await assert.rejects(peer.request(route, { op: "whoami" }), code("not_attached"));
  const again = await attach(peer, "rt.a");
  assert.notEqual(again.attachmentId, route.attachmentId);
  await assert.rejects(peer.request(route, { op: "whoami" }), code("stale_attachment"));
  await peer.dispose();
  await server.close();
});

test("an attach admitted before a disconnect cannot install a route afterwards", async () => {
  const { client, server, gate, attachErrors } = fixture();
  const peer = client();
  await peer.connect();
  const attaching = peer.request(peer.serverRoute(), { op: "gatedAttach", name: "slow", runtimeId: "rt.a" });
  await tick();
  await peer.disconnect();
  await assert.rejects(attaching, code("disconnected"));
  await until(() => server.connectionCount === 0);
  gate("slow").resolve();
  await until(() => attachErrors.length === 1);
  assert.ok(attachErrors[0] instanceof ServiceError && attachErrors[0].code === "connection_closed");
  await server.close();
});

test("subscription updates follow the initial result, wait for start, and stop with their route", async () => {
  const { client, server, sinks, attachErrors } = fixture();
  const peer = client();
  await peer.connect();
  const route = await attach(peer, "rt.a");
  const updates: JsonValue[] = [];
  const subscription = await peer.subscribe(
    route,
    (subscriptionId) => ({ op: "subscribe", subscriptionId, initial: 1, early: 2 }),
    (update) => updates.push(update),
    { unsubscribe: (subscriptionId) => ({ op: "unsubscribe", subscriptionId }) },
  );
  assert.deepEqual(subscription.initial, { initial: 1 });
  await tick();
  assert.deepEqual(updates, [], "updates wait until the initial state is installed");
  subscription.start();
  assert.deepEqual(updates, [2]);
  assert.equal(await sinks[0]!.send(3), true);
  await until(() => updates.length === 2);
  assert.deepEqual(updates, [2, 3]);

  const serverWide: JsonValue[] = [];
  const global = await peer.subscribe(peer.serverRoute(), (subscriptionId) => ({ op: "subscribe", subscriptionId }), (update) => serverWide.push(update));
  global.start();
  await peer.request(peer.serverRoute(), { op: "detach" });
  assert.deepEqual(await subscription.ended, { reason: "detached" });
  assert.equal(sinks[0]!.closed, true);
  assert.equal(sinks[0]!.signal.aborted, true);
  assert.equal(await sinks[0]!.send(4), false);
  assert.equal(await sinks[1]!.send("still"), true, "a server-route subscription survives attachment changes");
  await until(() => serverWide.length === 1);

  const other = await attach(peer, "rt.b");
  const closable = await peer.subscribe(other, (subscriptionId) => ({ op: "subscribe", subscriptionId }), () => undefined, {
    unsubscribe: (subscriptionId) => ({ op: "unsubscribe", subscriptionId }),
  });
  await closable.close();
  assert.equal(sinks[2]!.closed, true);
  assert.equal(await closable.close(), undefined);
  assert.deepEqual(await closable.ended, { reason: "closed" });

  await peer.request(other, { op: "lateSubscribe" });
  await until(() => attachErrors.length === 1, "the late subscription to be refused");
  assert.ok(attachErrors[0] instanceof ServiceError && attachErrors[0].code === "call_settled");
  await peer.dispose();
  await server.close();
});

test("sends keep order under backpressure and a stalled peer overflows the bounded queue", async () => {
  const { client, server, connector, sinks, errors } = fixture({ maxQueuedBytes: 2048 });
  const peer = client();
  await peer.connect();
  const route = await attach(peer, "rt.a");
  const updates: JsonValue[] = [];
  const subscription = await peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId }), (update) => updates.push(update));
  subscription.start();
  const outbound = connector.links[0]!.server;
  outbound.pause();
  let firstDone = false;
  let secondDone = false;
  const first = sinks[0]!.send("one").then((sent) => { firstDone = sent; });
  const second = sinks[0]!.send("two").then((sent) => { secondDone = sent; });
  await tick();
  assert.equal(firstDone, false, "a paused peer holds the send");
  assert.equal(secondDone, false);
  assert.ok(outbound.queuedBytes > 0);
  outbound.resume();
  await Promise.all([first, second]);
  assert.equal(firstDone && secondDone, true);
  await until(() => updates.length === 2);
  assert.deepEqual(updates, ["one", "two"]);

  outbound.pause();
  const replies = Array.from({ length: 8 }, () => peer.request(peer.serverRoute(), { op: "echo", value: "x".repeat(512) }));
  await until(() => server.connectionCount === 0, "the stalled connection to overflow");
  assert.ok(errors.some((error) => /bytes are waiting/.test(error.message)));
  outbound.resume();
  const settled = await Promise.allSettled(replies);
  assert.ok(settled.some((result) => result.status === "rejected"));
  await until(() => peer.state === "disconnected");
  await peer.dispose();
  await server.close();
});

test("fragmented, coalesced and delayed byte streams carry the same conversation", async () => {
  const { client, server, sinks } = fixture({}, {
    clientToServer: { split: chunksOf(1) },
    serverToClient: { coalesce: true, split: chunksOf(3), delayMs: 1 },
  });
  const peer = client();
  await peer.connect();
  const route = await attach(peer, "rt.a");
  const values = Array.from({ length: 12 }, (_, index) => ({ index, text: "é".repeat(index) }));
  assert.deepEqual(await Promise.all(values.map((value) => peer.request(route, { op: "echo", value }))), values);
  const updates: JsonValue[] = [];
  const subscription = await peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId, early: 0 }), (update) => updates.push(update));
  subscription.start();
  for (let index = 1; index <= 5; index++) await sinks[0]!.send(index);
  await until(() => updates.length === 6);
  assert.deepEqual(updates, [0, 1, 2, 3, 4, 5]);
  await peer.dispose();
  await server.close();
});

test("request, subscription, buffer, frame and connection limits fail explicitly", async () => {
  const { client, server, gate, sinks } = fixture({ maxActiveRequests: 2, maxSubscriptions: 1, maxConnections: 3 });
  const peer = client({ maxPendingRequests: 3, maxSubscriptions: 2, maxBufferedUpdates: 2 });
  await peer.connect();
  const route = peer.serverRoute();
  const held = [peer.request(route, { op: "gate", name: "l1" }), peer.request(route, { op: "gate", name: "l2" })];
  await assert.rejects(peer.request(route, { op: "echo", value: 1 }), code("too_many_requests"));
  const local = peer.request(route, { op: "gate", name: "l3" });
  await assert.rejects(peer.request(route, { op: "echo", value: 1 }), (error) => error instanceof ClientError && error.code === "too_many_requests");
  gate("l1").resolve(); gate("l2").resolve(); gate("l3").resolve();
  await Promise.all([...held, local]);

  await peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId }), () => undefined);
  await assert.rejects(peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId }), () => undefined), code("too_many_subscriptions"));
  const unstarted = await peer.subscribe(peer.serverRoute(), (subscriptionId) => ({ op: "echo", value: subscriptionId }), () => undefined);
  await assert.rejects(peer.subscribe(route, () => null, () => undefined), (error) => error instanceof ClientError && error.code === "too_many_subscriptions");
  assert.equal(unstarted.id, "s3");
  const states: string[] = [];
  peer.onStateChange((state, error) => states.push(`${state}:${(error as ClientError | undefined)?.code ?? ""}`));
  for (const update of [1, 2, 3]) void sinks[0]!.send(update);
  await until(() => peer.state === "disconnected");
  assert.deepEqual(states, ["disconnected:subscription_overflow"]);

  const small = client({ limits: { maxFrameBytes: 256 } });
  await small.connect();
  await assert.rejects(small.request(route, { op: "echo", value: "x".repeat(400) }), (error) => error instanceof Error && /exceeds 256 bytes/.test(error.message));
  assert.equal(small.state, "connected", "a local encoding failure rejects only that request");
  await assert.rejects(small.request(route, { op: "big", size: 300 }), code("protocol_error"));
  assert.equal(small.state, "disconnected");
  await until(() => server.connectionCount === 0);

  const limitedServer = fixture({ limits: { maxFrameBytes: 128 } });
  const big = limitedServer.client();
  await big.connect();
  await assert.rejects(big.request(big.serverRoute(), { op: "echo", value: "z".repeat(200) }), code("protocol_error"));
  await limitedServer.server.close();

  const crowd = [client(), client(), client()];
  await crowd[0]!.connect();
  await crowd[1]!.connect();
  await crowd[2]!.connect();
  const extra = client();
  await assert.rejects(extra.connect(), code("server_busy"));
  for (const member of crowd) await member.dispose();
  await server.close();
});

test("closing is repeatable, waits for admitted calls, and observer failures do not stop cleanup", async () => {
  const { client, server, signals, sinks } = fixture();
  const listenerErrors: Error[] = [];
  const peer = client({ onListenerError: (error) => listenerErrors.push(error) });
  let states = 0;
  peer.onStateChange(() => { states += 1; throw new Error("state observer"); });
  peer.onAttachmentChange(() => { throw new Error("attachment observer"); });
  await peer.connect();
  const route = await attach(peer, "rt.a");
  const seen: JsonValue[] = [];
  const subscription = await peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId }), (update) => {
    seen.push(update);
    throw new Error("update observer");
  });
  subscription.start();
  await sinks[0]!.send(1);
  await sinks[0]!.send(2);
  await until(() => seen.length === 2);
  assert.ok(listenerErrors.some((error) => error.message === "update observer"));

  const waiting = peer.request(route, { op: "wait" });
  await until(() => signals.length === 1);
  const first = server.close();
  const second = server.close();
  assert.equal(first, second);
  await first;
  assert.equal(signals[0]!.aborted, true, "close aborted the admitted call before resolving");
  await assert.rejects(waiting);
  await until(() => peer.state === "disconnected");
  assert.equal(await subscription.ended.then((end) => end.reason), "disconnected");
  assert.ok(listenerErrors.some((error) => error.message === "attachment observer"));
  assert.ok(listenerErrors.some((error) => error.message === "state observer"));
  assert.equal(states, 3);
  await peer.disconnect();
  await peer.disconnect();
  assert.equal(states, 3, "repeated disconnects do not run cleanup twice");

  await assert.rejects(client().connect(), code("server_closing"));
  assert.throws(() => server.registerRuntime("rt.late", { call: () => null }), /closed/);
  await peer.dispose();
});

test("events from a replaced transport cannot change the new connection", async () => {
  const { server, transport } = fixture();
  const captured: ByteTransportHandlers[] = [];
  const peer = new Client({ serverId: "srv", transport: (handlers) => { captured.push(handlers); return transport(handlers); } });
  await peer.connect();
  await peer.disconnect();
  await peer.connect();
  const stale = captured[0]!;
  stale.onData(encodeServerMessage({ type: "attachment", attachment: { serverId: "srv", runtimeId: "rt.a", attachmentId: "old" } }));
  stale.onData(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  stale.onError(new Error("old failure"));
  stale.onClose();
  assert.equal(peer.state, "connected");
  assert.equal(peer.attachment, null);
  assert.equal(await peer.request(peer.serverRoute(), { op: "echo", value: "fresh" }), "fresh");
  await peer.dispose();
  await server.close();
});

test("routing capabilities and sinks refuse use after their call settled", async () => {
  const { client, server, contexts } = fixture();
  const peer = client();
  await peer.connect();
  const attachments: unknown[] = [];
  peer.onAttachmentChange((attachment) => attachments.push(attachment));
  await peer.request(peer.serverRoute(), { op: "keep" });
  const kept = contexts[0]!;
  assert.throws(() => kept.attach("rt.a"), (error) => error instanceof ServiceError && error.code === "call_settled");
  assert.throws(() => kept.detach(), (error) => error instanceof ServiceError && error.code === "call_settled");
  assert.throws(() => kept.openSubscription("late"), (error) => error instanceof ServiceError && error.code === "call_settled");
  await tick();
  assert.deepEqual(attachments, []);
  assert.equal(peer.attachment, null);
  await peer.dispose();
  await server.close();
});

test("an attachment envelope that overflows the send queue closes the connection instead of returning a route", async () => {
  const { client, server, connector, attachErrors } = fixture({ maxQueuedBytes: 160 });
  const peer = client();
  await peer.connect();
  const outbound = connector.links[0]!.server;
  outbound.pause();
  const echoed = peer.request(peer.serverRoute(), { op: "echo", value: "x".repeat(100) });
  await tick();
  const attaching = peer.request(peer.serverRoute(), { op: "attach", runtimeId: "rt.a" });
  await until(() => attachErrors.length === 1, "attach to fail");
  assert.ok(attachErrors[0] instanceof ServiceError && attachErrors[0].code === "connection_closed");
  assert.equal(server.connectionCount, 0);
  outbound.resume();
  await Promise.allSettled([echoed, attaching]);
  await until(() => peer.state === "disconnected");
  assert.equal(peer.attachment, null);
  await peer.dispose();
  await server.close();
});

test("updates fired without awaiting are bounded per connection and overflow closes it", async () => {
  const { client, server, connector, sinks, errors } = fixture({ maxQueuedBytes: 2048 });
  const peer = client();
  await peer.connect();
  const route = await attach(peer, "rt.a");
  const subscription = await peer.subscribe(route, (subscriptionId) => ({ op: "subscribe", subscriptionId }), () => undefined);
  subscription.start();
  connector.links[0]!.server.pause();
  const sends = Array.from({ length: 50 }, () => sinks[0]!.send("u".repeat(100)));
  const results = await Promise.all(sends);
  assert.equal(server.connectionCount, 0);
  assert.ok(results.includes(false));
  assert.ok(errors.some((error) => /update bytes are waiting/.test(error.message)));
  connector.links[0]!.server.resume();
  await until(() => peer.state === "disconnected");
  await peer.dispose();
  await server.close();
});

test("the memory pipe coalesces queued sends, splits deliveries and holds sends while paused", async () => {
  const link = createMemoryLink({ clientToServer: { coalesce: true, split: chunksOf(4) } });
  const chunks: number[][] = [];
  let closed = false;
  link.server.attach({ onData: (chunk) => chunks.push([...chunk]), onClose: () => { closed = true; }, onError: () => undefined });
  link.client.attach({ onData: () => undefined, onClose: () => undefined, onError: () => undefined });
  await Promise.all([link.client.send(new Uint8Array([1, 2, 3])), link.client.send(new Uint8Array([4, 5, 6]))]);
  await until(() => chunks.length === 2);
  assert.deepEqual(chunks, [[1, 2, 3, 4], [5, 6]]);
  link.client.pause();
  let sent = false;
  const held = link.client.send(new Uint8Array([7])).then(() => { sent = true; });
  await tick();
  assert.equal(sent, false);
  link.client.resume();
  await held;
  link.client.close();
  await until(() => closed);
  assert.deepEqual(chunks.flat(), [1, 2, 3, 4, 5, 6, 7]);
  await assert.rejects(link.client.send(new Uint8Array([8])), /closed/);
});

test("the decoder used by servers accepts only client messages", () => {
  const decoder = new ClientMessageDecoder();
  assert.throws(() => decoder.push(encodeServerMessage({ type: "attachment", attachment: null })), /invalid client protocol message/);
});
