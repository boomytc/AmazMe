import assert from "node:assert/strict";
import test from "node:test";
import { Client, ClientError, RemoteError, type ByteTransport, type ByteTransportHandlers, type ClientOptions } from "@amazme/client";
import { ClientMessageDecoder, encodeServerMessage, type ClientMessage, type ServerMessage } from "@amazme/protocol";
import { createMemoryLink, type MemoryEnd } from "@amazme/server/testing";

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A hand-driven server end: the test reads client messages and writes raw server frames. */
function scripted(options: Partial<ClientOptions> = {}) {
  let server!: MemoryEnd;
  const received: ClientMessage[] = [];
  const decoder = new ClientMessageDecoder();
  const client = new Client({
    serverId: "srv",
    transport: (handlers) => {
      const link = createMemoryLink();
      server = link.server;
      server.attach({ onData: (chunk) => received.push(...decoder.push(chunk)), onClose: () => undefined, onError: () => undefined });
      link.client.attach(handlers);
      return link.client;
    },
    ...options,
  });
  const reply = (message: ServerMessage) => void server.send(encodeServerMessage(message)).catch(() => undefined);
  const raw = (bytes: Uint8Array) => void server.send(bytes).catch(() => undefined);
  const handshake = async () => {
    const connected = client.connect();
    await until(() => received.some((message) => message.type === "hello"));
    reply({ type: "hello", version: 1, serverId: "srv" });
    await connected;
  };
  return { client, received, reply, raw, handshake, server: () => server };
}

const code = (expected: string) => (error: unknown) => (error instanceof ClientError || error instanceof RemoteError) && error.code === expected;

test("hello is sent first and the handshake fails on hello_error, a wrong first message, or timeout", async () => {
  const refused = scripted();
  const connecting = refused.client.connect();
  await until(() => refused.received.length === 1);
  assert.deepEqual(refused.received, [{ type: "hello", version: 1 }]);
  refused.reply({ type: "hello_error", error: { code: "unsupported_version", message: "no" } });
  await assert.rejects(connecting, (error) => error instanceof RemoteError && error.code === "unsupported_version");
  assert.equal(refused.client.state, "disconnected");

  const confused = scripted();
  const second = confused.client.connect();
  await until(() => confused.received.length === 1);
  confused.reply({ type: "attachment", attachment: null });
  await assert.rejects(second, code("protocol_error"));

  const silent = scripted({ handshakeTimeoutMs: 30 });
  await assert.rejects(silent.client.connect(), code("handshake_timeout"));
  assert.equal(silent.server().closed, true, "the timed-out transport was closed");
});

test("a response without a request, a foreign attachment, or a second hello is a protocol violation", async () => {
  for (const message of [
    { type: "response", id: "r9", ok: true },
    { type: "attachment", attachment: { serverId: "other", runtimeId: "rt", attachmentId: "a" } },
    { type: "hello", version: 1, serverId: "srv" },
  ] satisfies ServerMessage[]) {
    const peer = scripted();
    await peer.handshake();
    const pending = peer.client.request(peer.client.serverRoute(), null);
    peer.reply(message);
    await assert.rejects(pending, code("protocol_error"));
    assert.equal(peer.client.state, "disconnected");
  }
});

test("a hello_error after the handshake ends the connection with the remote code", async () => {
  const peer = scripted();
  await peer.handshake();
  const pending = peer.client.request(peer.client.serverRoute(), null);
  peer.reply({ type: "hello_error", error: { code: "duplicate_request", message: "x" } });
  await assert.rejects(pending, code("duplicate_request"));
});

test("a stream that ends inside a frame and undecodable bytes both fail the connection", async () => {
  const truncated = scripted();
  await truncated.handshake();
  const states: Array<string | undefined> = [];
  truncated.client.onStateChange((_state, error) => states.push((error as ClientError | undefined)?.code));
  truncated.raw(encodeServerMessage({ type: "attachment", attachment: null }).subarray(0, 3));
  await new Promise((resolve) => setTimeout(resolve, 5));
  truncated.server().close();
  await until(() => truncated.client.state === "disconnected");
  assert.deepEqual(states, ["protocol_error"]);

  const garbage = scripted();
  await garbage.handshake();
  garbage.raw(new Uint8Array([0, 0, 0, 1, 0xff]));
  await until(() => garbage.client.state === "disconnected");
});

test("the transport factory failing and the send queue overflowing reject explicitly", async () => {
  const broken = new Client({ serverId: "srv", transport: () => { throw new Error("no route"); } });
  await assert.rejects(broken.connect(), (error) => error instanceof ClientError && error.code === "transport_error" && /no route/.test(error.message));
  assert.equal(broken.state, "disconnected");

  const sends: Array<() => void> = [];
  let closed = 0;
  let handlers!: Parameters<ClientOptions["transport"]>[0];
  const stalled: ByteTransport = {
    send: () => new Promise<void>((resolve) => sends.push(resolve)),
    close: () => { closed += 1; },
  };
  const client = new Client({ serverId: "srv", maxQueuedBytes: 200, transport: (given) => { handlers = given; return stalled; } });
  const connecting = client.connect();
  await until(() => sends.length === 1);
  sends[0]!();
  handlers.onData(encodeServerMessage({ type: "hello", version: 1, serverId: "srv" }));
  await connecting;
  const requests = Array.from({ length: 6 }, () => client.request(client.serverRoute(), "x".repeat(40)));
  const outcomes = await Promise.allSettled(requests);
  const codes = outcomes.map((outcome) => outcome.status === "rejected" && (outcome.reason as ClientError).code);
  const overflowed = codes.filter((value) => value === "send_overflow").length;
  assert.ok(overflowed >= 1 && overflowed < codes.length, codes.join());
  assert.deepEqual(codes, [...Array(overflowed).fill("send_overflow"), ...Array(codes.length - overflowed).fill("not_connected")]);
  assert.equal(client.state, "disconnected");
  assert.equal(closed, 1);
});

test("synchronous and asynchronous transport send failures both report transport_error", async () => {
  for (const synchronous of [true, false]) {
    let closed = 0;
    const client = new Client({
      serverId: "srv",
      transport: () => ({
        send: () => {
          if (synchronous) throw new Error("send failed");
          return Promise.reject(new Error("send failed"));
        },
        close: () => { closed += 1; },
      }),
    });
    await assert.rejects(client.connect(), (error) => error instanceof ClientError && error.code === "transport_error" && /send failed/.test(error.message));
    assert.equal(client.state, "disconnected");
    assert.equal(closed, 1);
  }
});

test("server bytes arriving before the transport factory returns cannot connect or strand a request", async () => {
  for (const fragmented of [false, true]) {
    let closed = 0;
    const states: string[] = [];
    const frame = encodeServerMessage({ type: "hello", version: 1, serverId: "srv" });
    const client = new Client({ serverId: "srv", transport: (handlers) => {
      handlers.onData(fragmented ? frame.subarray(0, 3) : frame);
      return {
        send: async () => { if (fragmented) handlers.onData(frame.subarray(3)); },
        close: () => { closed += 1; },
      };
    } });
    client.onStateChange((state) => states.push(state));
    await assert.rejects(client.connect(), code("protocol_error"));
    assert.deepEqual(states, ["connecting", "disconnected"]);
    assert.equal(closed, 1);
    await assert.rejects(client.request(client.serverRoute(), null), code("not_connected"));
  }
});

test("a server refusal before the transport factory returns preserves its remote error code", async () => {
  let closed = 0;
  const client = new Client({ serverId: "srv", transport: (handlers) => {
    handlers.onData(encodeServerMessage({ type: "hello_error", error: { code: "server_busy", message: "full" } }));
    return { send: async () => undefined, close: () => { closed += 1; } };
  } });
  await assert.rejects(client.connect(), (error) => error instanceof RemoteError && error.code === "server_busy");
  assert.equal(closed, 1);
});

test("a throwing unsubscribe builder cannot strand the messages that follow it in one chunk", async () => {
  const errors: Error[] = [];
  const peer = scripted({ onListenerError: (error) => errors.push(error) });
  await peer.handshake();
  const controller = new AbortController();
  const subscribing = peer.client.subscribe(peer.client.serverRoute(), () => "open", () => undefined, {
    signal: controller.signal,
    unsubscribe: () => { throw new Error("builder failed"); },
  });
  const other = peer.client.request(peer.client.serverRoute(), "other");
  await until(() => peer.received.filter((message) => message.type === "request").length === 2);
  controller.abort();
  await assert.rejects(subscribing);
  const late = encodeServerMessage({ type: "response", id: "r1", ok: true, result: "initial" });
  const next = encodeServerMessage({ type: "response", id: "r2", ok: true, result: "answer" });
  const chunk = new Uint8Array(late.byteLength + next.byteLength);
  chunk.set(late);
  chunk.set(next, late.byteLength);
  peer.raw(chunk);
  assert.equal(await other, "answer");
  assert.equal(peer.client.state, "connected");
  assert.deepEqual(errors.map((error) => error.message), ["builder failed"]);
  assert.deepEqual(peer.server().handlerErrors, []);
  await peer.client.dispose();
});

test("dispose is final and repeatable", async () => {
  const peer = scripted();
  await peer.handshake();
  const pending = peer.client.request(peer.client.serverRoute(), null);
  await Promise.all([peer.client.dispose(), peer.client.dispose()]);
  await assert.rejects(pending, code("disposed"));
  await assert.rejects(peer.client.connect(), code("disposed"));
  await assert.rejects(peer.client.request(peer.client.serverRoute(), null), code("disposed"));
});

test("a locally cancelled subscribe that succeeds remotely is unsubscribed", async () => {
  const peer = scripted();
  await peer.handshake();
  const controller = new AbortController();
  const subscribing = peer.client.subscribe(
    peer.client.serverRoute(),
    (subscriptionId) => ({ open: subscriptionId }),
    () => undefined,
    { signal: controller.signal, unsubscribe: (subscriptionId) => ({ close: subscriptionId }) },
  );
  await until(() => peer.received.some((message) => message.type === "request"));
  controller.abort();
  await assert.rejects(subscribing, (error) => error instanceof Error && error.name === "AbortError");
  peer.reply({ type: "response", id: "r1", ok: true, result: "initial" });
  peer.reply({ type: "service_update", subscriptionId: "s1", update: "ignored" });
  await until(() => peer.received.some((message) => message.type === "request" && JSON.stringify(message.call) === '{"close":"s1"}'));
  assert.deepEqual(peer.received.filter((message) => message.type !== "hello").map((message) => message.type), ["request", "cancel", "request"]);
  assert.equal(peer.client.state, "connected");
  await peer.client.dispose();
});

test("buffered subscription updates stay ordered when an update callback receives more bytes synchronously", async () => {
  let handlers!: ByteTransportHandlers;
  const requests: ClientMessage[] = [];
  const decoder = new ClientMessageDecoder();
  const client = new Client({ serverId: "srv", transport: (given) => {
    handlers = given;
    return { send: async (frame) => {
      for (const message of decoder.push(frame)) {
        if (message.type === "hello") handlers.onData(encodeServerMessage({ type: "hello", version: 1, serverId: "srv" }));
        else requests.push(message);
      }
    }, close: () => undefined };
  } });
  await client.connect();
  const updates: number[] = [];
  const subscribing = client.subscribe(client.serverRoute(), () => "open", (update) => {
    updates.push(update as number);
    if (update === 1) handlers.onData(encodeServerMessage({ type: "service_update", subscriptionId: "s1", update: 3 }));
  });
  await until(() => requests.length === 1);
  for (const update of [1, 2]) handlers.onData(encodeServerMessage({ type: "service_update", subscriptionId: "s1", update }));
  handlers.onData(encodeServerMessage({ type: "response", id: "r1", ok: true, result: "initial" }));
  const subscription = await subscribing;
  subscription.start();
  assert.deepEqual(updates, [1, 2, 3]);
  await client.dispose();
});

test("a reconnect during attachment cleanup prevents an old disconnected event from following connecting", async () => {
  const peer = scripted();
  await peer.handshake();
  peer.reply({ type: "attachment", attachment: { serverId: "srv", runtimeId: "rt", attachmentId: "a1" } });
  await until(() => peer.client.attachment !== null);
  const states: string[] = [];
  peer.client.onStateChange((state) => states.push(state));
  let connecting: Promise<unknown> | undefined;
  peer.client.onAttachmentChange((attachment) => {
    if (attachment === null) connecting = peer.client.connect();
  });
  await peer.client.disconnect();
  assert.equal(peer.client.state, "connecting");
  assert.deepEqual(states, ["connecting"]);
  await until(() => peer.received.filter((message) => message.type === "hello").length === 2);
  peer.reply({ type: "hello", version: 1, serverId: "srv" });
  await connecting;
  await peer.client.dispose();
});

test("a state listener changing the connection cannot deliver the obsolete state to later listeners", async () => {
  const peer = scripted();
  peer.client.onStateChange((state) => { if (state === "connected") void peer.client.disconnect(); });
  const states: string[] = [];
  peer.client.onStateChange((state) => states.push(state));
  await assert.rejects(peer.handshake(), code("disconnected"));
  assert.deepEqual(states, ["connecting", "disconnected"]);
});

test("route observations and caller mutations cannot change attachment or cancellation identity", async () => {
  const peer = scripted();
  await peer.handshake();
  peer.client.onAttachmentChange((attachment) => { if (attachment) Object.assign(attachment, { runtimeId: "changed" }); });
  const observed: string[] = [];
  peer.client.onAttachmentChange((attachment) => { if (attachment) observed.push(attachment.runtimeId); });
  const route = { serverId: "srv", runtimeId: "rt", attachmentId: "a1" };
  peer.reply({ type: "attachment", attachment: route });
  await until(() => observed.length === 1);
  assert.deepEqual(observed, ["rt"]);
  const attachment = peer.client.attachment!;
  Object.assign(attachment, { attachmentId: "changed" });
  assert.deepEqual(peer.client.attachment, route);
  const controller = new AbortController();
  const pending = peer.client.request(route, "wait", { signal: controller.signal });
  route.runtimeId = "changed";
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
  await until(() => peer.received.some((message) => message.type === "cancel"));
  const cancel = peer.received.find((message) => message.type === "cancel");
  assert.deepEqual(cancel, { type: "cancel", id: "r1", route: { serverId: "srv", runtimeId: "rt", attachmentId: "a1" } });
  await peer.client.dispose();
});
