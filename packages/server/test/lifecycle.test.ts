import assert from "node:assert/strict";
import test from "node:test";
import { Client, ClientError, RemoteError } from "@amazme/client";
import { encodeClientMessage, ServerMessageDecoder, type JsonValue, type ServerMessage } from "@amazme/protocol";
import {
  Server,
  ServiceError,
  type AttachmentLease,
  type ByteConnection,
  type RuntimeHandle,
  type RuntimeService,
  type ServerService,
} from "@amazme/server";
import { memoryConnector } from "@amazme/server/testing";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const code = (expected: string) => (error: unknown) =>
  (error instanceof RemoteError || error instanceof ClientError || error instanceof ServiceError) && error.code === expected;

interface HandleLog {
  acquires: number;
  leaseReleases: number;
  closes: Array<"drain" | "abort">;
  removes: number;
  ownershipReleases: number;
}

function emptyLog(): HandleLog {
  return { acquires: 0, leaseReleases: 0, closes: [], removes: 0, ownershipReleases: 0 };
}

function scripted(log: HandleLog, options: {
  service?: RuntimeService;
  idle?: () => boolean;
  acquire?: () => AttachmentLease;
  close?: (mode: "drain" | "abort") => Promise<void>;
  remove?: () => Promise<void>;
  release?: () => Promise<void>;
} = {}): RuntimeHandle {
  const handle: RuntimeHandle = {
    acquire: options.acquire ?? (() => {
      log.acquires += 1;
      return {
        service: options.service ?? { call: () => ({ ok: true }) },
        release: () => {
          log.leaseReleases += 1;
        },
      };
    }),
    close: (mode) => {
      log.closes.push(mode);
      return options.close?.(mode) ?? Promise.resolve();
    },
    idle: options.idle ?? (() => false),
    release: options.release === undefined && options.remove === undefined ? undefined : async () => {
      log.ownershipReleases += 1;
      await options.release?.();
    },
    remove: options.remove === undefined ? undefined : async () => {
      log.removes += 1;
      await options.remove?.();
    },
  };
  if (!options.release && !options.remove) {
    delete handle.release;
    delete handle.remove;
  } else if (!options.remove) {
    delete handle.remove;
  } else if (!options.release) {
    delete handle.release;
  }
  return handle;
}

function attachService(onAttach?: () => void): ServerService {
  return {
    async call(raw, context) {
      const call = raw as { op?: string; runtimeId?: string };
      if (call?.op === "attach") {
        onAttach?.();
        await context.attach(String(call.runtimeId ?? "rt"));
        return { attached: true };
      }
      if (call?.op === "detach") {
        await context.detach();
        return null;
      }
      throw new ServiceError("unknown_call", "unsupported call");
    },
  };
}

function connectorFor(server: Server) {
  const connector = memoryConnector((connection) => server.accept(connection));
  return async () => {
    const client = new Client({ serverId: "srv", transport: connector.transport });
    await client.connect();
    return client;
  };
}

async function shutdown(server: Server, clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.dispose().catch(() => undefined)));
  await server.close().catch(() => undefined);
}

test("concurrent attaches share one open and each take a lease; reattach does not", async () => {
  const gate = deferred<RuntimeHandle>();
  const bothWaiting = deferred();
  const log = emptyLog();
  let calls = 0;
  let entered = 0;
  let signal: AbortSignal | undefined;
  const server = new Server({
    serverId: "srv",
    service: attachService(() => {
      entered += 1;
      if (entered === 2) queueMicrotask(() => bothWaiting.resolve());
    }),
    openRuntime: (_runtimeId, openSignal) => {
      calls += 1;
      signal = openSignal;
      return gate.promise;
    },
  });
  const connect = connectorFor(server);
  const clients: Client[] = [];
  try {
    const first = await connect();
    const second = await connect();
    clients.push(first, second);
    const left = first.request(first.serverRoute(), { op: "attach", runtimeId: "rt" });
    const right = second.request(second.serverRoute(), { op: "attach", runtimeId: "rt" });
    await bothWaiting.promise;
    assert.equal(calls, 1, "one factory call covers both waiters");
    assert.equal(signal?.aborted, false);
    gate.resolve(scripted(log));
    await Promise.all([left, right]);
    assert.equal(log.acquires, 2);
    assert.notEqual(first.attachment?.attachmentId, second.attachment?.attachmentId);
    const kept = first.attachment?.attachmentId;
    await first.request(first.serverRoute(), { op: "attach", runtimeId: "rt" });
    assert.equal(first.attachment?.attachmentId, kept);
    assert.equal(log.acquires, 2);
    assert.equal(calls, 1);
  } finally {
    await shutdown(server, clients);
  }
});

test("cancelling one waiter leaves the shared open for the others", async () => {
  const gate = deferred<RuntimeHandle>();
  const bothWaiting = deferred();
  const log = emptyLog();
  let calls = 0;
  let entered = 0;
  let signal: AbortSignal | undefined;
  const signals: AbortSignal[] = [];
  const server = new Server({
    serverId: "srv",
    service: {
      async call(raw, context) {
        signals.push(context.signal);
        entered += 1;
        if (entered === 2) queueMicrotask(() => bothWaiting.resolve());
        const call = raw as { op?: string; runtimeId?: string };
        if (call?.op !== "attach") throw new ServiceError("unknown_call", "unsupported call");
        await context.attach(String(call.runtimeId ?? "rt"));
        return { attached: true };
      },
    },
    openRuntime: (_runtimeId, openSignal) => {
      calls += 1;
      signal = openSignal;
      return gate.promise;
    },
  });
  const connect = connectorFor(server);
  const clients: Client[] = [];
  try {
    const first = await connect();
    const second = await connect();
    clients.push(first, second);
    const controller = new AbortController();
    const cancelled = first.request(first.serverRoute(), { op: "attach", runtimeId: "rt" }, { signal: controller.signal });
    const staying = second.request(second.serverRoute(), { op: "attach", runtimeId: "rt" });
    await bothWaiting.promise;
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await until(() => signals[0]?.aborted === true, "the server to observe the cancelled waiter");
    assert.equal(signals[1]?.aborted, false);
    assert.equal(signal?.aborted, false, "one waiter leaving does not abort the shared open");
    gate.resolve(scripted(log));
    assert.deepEqual(await staying, { attached: true });
    assert.equal(second.attachment?.runtimeId, "rt");
    assert.equal(first.attachment, null);
    assert.equal(calls, 1);
    assert.equal(log.acquires, 1);
    assert.equal(log.closes.length, 0);
  } finally {
    await shutdown(server, clients);
  }
});

test("a failed open can be retried and does not stick in the cache", async () => {
  const errors: Error[] = [];
  const log = emptyLog();
  let calls = 0;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    onError: (error) => errors.push(error),
    openRuntime: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("disk"));
      if (calls === 2) return Promise.resolve(null);
      return Promise.resolve(scripted(log));
    },
  });
  const connect = connectorFor(server);
  const clients: Client[] = [];
  try {
    const client = await connect();
    clients.push(client);
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("internal"));
    assert.equal(errors[0]?.message, "disk");
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("unknown_runtime"));
    assert.deepEqual(await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), { attached: true });
    assert.equal(calls, 3);
    assert.equal(log.acquires, 1);
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "bad id" }), code("unknown_runtime"));
    assert.equal(calls, 3, "an invalid runtime id never reaches the factory");
  } finally {
    await shutdown(server, clients);
  }
});

test("disconnect, close and remove during open discard the late handle", async () => {
  for (const mode of ["disconnect", "close", "remove"] as const) {
    const gate = deferred<RuntimeHandle>();
    const started = deferred();
    const settled = deferred();
    const log = emptyLog();
    let calls = 0;
    const server = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          return gate.promise;
        }
        return Promise.resolve(scripted(emptyLog(), { idle: () => false }));
      },
    });
    const connect = connectorFor(server);
    const client = await connect();
    const pending = assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }));
    await started.promise;
    const handle = scripted(log, {
      release: async () => { queueMicrotask(() => settled.resolve()); },
      remove: async () => { queueMicrotask(() => settled.resolve()); },
    });
    const closing = mode === "close" ? server.close() : undefined;
    const removing = mode === "remove" ? server.removeRuntime("rt") : undefined;
    if (mode === "disconnect") await client.disconnect();
    gate.resolve(handle);
    await pending;
    if (mode === "close") await closing;
    else if (mode === "remove") await removing;
    else await settled.promise;
    assert.equal(log.acquires, 0);
    assert.equal(log.closes.length, 1);
    if (mode === "remove") {
      assert.equal(log.removes, 1);
      assert.equal(log.ownershipReleases, 0);
    } else {
      assert.equal(log.removes, 0);
      assert.equal(log.ownershipReleases, 1);
    }
    if (mode !== "close") {
      const again = mode === "disconnect" ? await connect() : client;
      assert.deepEqual(await again.request(again.serverRoute(), { op: "attach", runtimeId: "rt" }), { attached: true });
      assert.equal(calls, 2, `${mode} must not poison the next open`);
      if (again !== client) await again.dispose();
    }
    await client.dispose().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("a failed switch keeps the previous attachment and a denied lease does not stay open", async () => {
  const allowed = emptyLog();
  const denied = emptyLog();
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: (runtimeId) => {
      if (runtimeId === "kept") return Promise.resolve(scripted(allowed, { idle: () => false }));
      if (runtimeId === "denied") {
        return Promise.resolve(scripted(denied, {
          idle: () => true,
          release: async () => undefined,
          acquire: () => { throw new Error("denied"); },
        }));
      }
      return Promise.reject(new Error("missing"));
    },
  });
  const connect = connectorFor(server);
  const clients: Client[] = [];
  try {
    const client = await connect();
    clients.push(client);
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "kept" });
    const route = client.attachment!;
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "missing" }), code("internal"));
    assert.equal(client.attachment?.attachmentId, route.attachmentId);
    assert.deepEqual(await client.request(route, { op: "whoami" }), { ok: true });
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "denied" }), code("internal"));
    assert.equal(client.attachment?.attachmentId, route.attachmentId);
    await until(() => denied.closes.length === 1 && denied.ownershipReleases === 1, "the denied runtime to be reclaimed");
    assert.equal(allowed.closes.length, 0);
    assert.equal(allowed.leaseReleases, 0);
    assert.deepEqual(await client.request(route, { op: "whoami" }), { ok: true });
  } finally {
    await shutdown(server, clients);
  }
});

test("detach publishes attachment null, then the response, then releases the lease after admitted calls", async () => {
  const order: string[] = [];
  const decoder = new ServerMessageDecoder();
  const hold = deferred();
  const call = deferred<JsonValue>();
  let invoked = false;
  let attached: { serverId: string; runtimeId: string; attachmentId: string } | undefined;
  const connection: ByteConnection = {
    send: (chunk) => {
      const waits: Array<Promise<void>> = [];
      for (const message of decoder.push(chunk)) {
        order.push(label(message));
        if (message.type === "attachment" && message.attachment) attached = message.attachment;
      }
      if (order.at(-1) === "attachment:null") waits.push(hold.promise);
      return waits.length > 0 ? Promise.all(waits).then(() => undefined) : Promise.resolve();
    },
    close: () => undefined,
  };
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(emptyLog(), {
      idle: () => false,
      service: {
        call: () => {
          invoked = true;
          return call.promise;
        },
      },
      acquire: () => ({
        service: {
          call: () => {
            invoked = true;
            return call.promise;
          },
        },
        release: () => {
          order.push("lease-release");
        },
      }),
    })),
  });
  const handlers = server.accept(connection);
  handlers.onData(encodeClientMessage({ type: "hello", version: 1 }));
  await until(() => order.includes("hello"), "the hello");
  handlers.onData(encodeClientMessage({ type: "request", id: "a", route: { serverId: "srv" }, call: { op: "attach", runtimeId: "rt" } }));
  await until(() => order.includes("response:a") && attached !== undefined, "the attach response");
  const route = attached!;
  handlers.onData(encodeClientMessage({ type: "request", id: "work", route, call: { op: "work" } }));
  await until(() => invoked, "the runtime call to be admitted");
  handlers.onData(encodeClientMessage({ type: "request", id: "d", route: { serverId: "srv" }, call: { op: "detach" } }));
  await until(() => order.includes("attachment:null"), "the detach envelope");
  assert.equal(order.includes("response:d"), false, "the detach response waits behind its attachment envelope");
  assert.equal(order.includes("lease-release"), false);
  handlers.onData(encodeClientMessage({ type: "request", id: "late", route, call: { op: "late" } }));
  hold.resolve();
  await until(() => order.includes("response:d") && order.includes("error:not_attached"), "the detach response and the revoked request");
  assert.equal(order.includes("lease-release"), false, "an admitted call keeps the lease after detach");
  assert.ok(order.indexOf("attachment:null") < order.indexOf("response:d"));
  call.resolve({ ok: true });
  await until(() => order.includes("lease-release"), "the lease release");
  assert.ok(order.indexOf("response:d") < order.indexOf("lease-release"));
  await server.close();
});

test("cancel, detach and disconnect leave an admitted runtime call running", async () => {
  const log = emptyLog();
  const gate = deferred<JsonValue>();
  let aborts = 0;
  const invoked = deferred();
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(log, {
      idle: () => false,
      service: {
        call: (_call, context) => {
          context.signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
          invoked.resolve();
          return gate.promise;
        },
      },
    })),
  });
  const connect = connectorFor(server);
  const clients: Client[] = [];
  try {
    const client = await connect();
    clients.push(client);
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    const route = client.attachment!;
    const controller = new AbortController();
    const waiting = client.request(route, { op: "work" }, { signal: controller.signal });
    await invoked.promise;
    controller.abort();
    await assert.rejects(waiting, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await until(() => aborts === 1, "the server to observe the cancel");
    assert.equal(log.leaseReleases, 0);
    assert.equal(log.closes.length, 0);
    gate.resolve({ ok: true });
    await until(() => log.leaseReleases === 0 && client.attachment?.attachmentId === route.attachmentId, "the attachment to survive cancel");
    assert.deepEqual(await client.request(route, { op: "whoami" }), { ok: true });

    const live = deferred<JsonValue>();
    const started = deferred();
    const hosted = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => Promise.resolve(scripted(log, {
        idle: () => false,
        service: { call: () => { started.resolve(); return live.promise; } },
      })),
    });
    const next = await connectorFor(hosted)();
    clients.push(next);
    try {
      await next.request(next.serverRoute(), { op: "attach", runtimeId: "rt" });
      const attached = next.attachment!;
      const working = next.request(attached, { op: "work" });
      await started.promise;
      await next.request(next.serverRoute(), { op: "detach" });
      assert.equal(next.attachment, null);
      await assert.rejects(next.request(attached, { op: "again" }), code("not_attached"));
      assert.equal(log.leaseReleases, 0);
      live.resolve({ done: true });
      assert.deepEqual(await working, { done: true });
      await until(() => log.leaseReleases === 1, "detach to release only after the admitted call");
      assert.equal(log.closes.length, 0, "a non-idle runtime stays open with no attachment");
      await next.disconnect();
      const reconnected = await connectorFor(hosted)();
      clients.push(reconnected);
      await reconnected.request(reconnected.serverRoute(), { op: "attach", runtimeId: "rt" });
      assert.notEqual(reconnected.attachment?.attachmentId, attached.attachmentId);
      await assert.rejects(reconnected.request(attached, { op: "stale" }), code("stale_attachment"));
      assert.equal(log.closes.length, 0);
    } finally {
      live.resolve({ done: true });
      await hosted.close().catch(() => undefined);
    }
  } finally {
    gate.resolve({ ok: true });
    await shutdown(server, clients);
  }
});

test("an idle runtime is reclaimed after the last lease and a busy one stays open", async () => {
  const idleLog = emptyLog();
  const busyLog = emptyLog();
  const servers: Server[] = [];
  const clients: Client[] = [];
  try {
    const idleServer = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => Promise.resolve(scripted(idleLog, { idle: () => true, release: async () => undefined })),
    });
    servers.push(idleServer);
    const idleClient = await connectorFor(idleServer)();
    clients.push(idleClient);
    await idleClient.request(idleClient.serverRoute(), { op: "attach", runtimeId: "rt" });
    const first = idleClient.attachment!;
    await idleClient.request(idleClient.serverRoute(), { op: "detach" });
    await until(() => idleLog.ownershipReleases === 1 && idleLog.closes.length === 1, "the idle runtime to close");
    assert.equal(idleLog.removes, 0);
    await idleClient.request(idleClient.serverRoute(), { op: "attach", runtimeId: "rt" });
    assert.notEqual(idleClient.attachment?.attachmentId, first.attachmentId);
    await assert.rejects(idleClient.request(first, { op: "old" }), code("stale_attachment"));

    let opens = 0;
    const busyServer = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => {
        opens += 1;
        return Promise.resolve(scripted(busyLog, { idle: () => false }));
      },
    });
    servers.push(busyServer);
    const busy = await connectorFor(busyServer)();
    clients.push(busy);
    await busy.request(busy.serverRoute(), { op: "attach", runtimeId: "rt" });
    await busy.request(busy.serverRoute(), { op: "detach" });
    await until(() => busyLog.leaseReleases === 1, "the busy runtime's lease to release");
    await Promise.resolve();
    assert.equal(busyLog.closes.length, 0);
    await busy.request(busy.serverRoute(), { op: "attach", runtimeId: "rt" });
    assert.equal(opens, 1, "a non-idle runtime is reused instead of opened again");
    assert.equal(busyLog.acquires, 2);
  } finally {
    await Promise.all(servers.map((server) => shutdown(server, [])));
    await Promise.all(clients.map((client) => client.dispose().catch(() => undefined)));
  }
});

test("explicit removal deletes, server close only releases, and a later abort upgrades a drain", async () => {
  const log = emptyLog();
  const removeGate = deferred();
  let opens = 0;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      opens += 1;
      return Promise.resolve(scripted(log, {
        idle: () => false,
        remove: () => removeGate.promise,
        release: async () => undefined,
      }));
    },
  });
  const connect = connectorFor(server);
  const clients: Client[] = [];
  try {
    const client = await connect();
    clients.push(client);
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    const removing = server.removeRuntime("rt");
    const again = server.removeRuntime("rt");
    await until(() => log.removes === 1, "the in-flight delete");
    assert.equal(log.ownershipReleases, 0);
    assert.deepEqual(log.closes, ["drain"]);
    const rejected = client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    await assert.rejects(rejected, code("runtime_busy"));
    assert.equal(opens, 1);
    removeGate.resolve();
    await removing;
    await again;
    assert.equal(log.removes, 1);
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    assert.equal(opens, 2);
    assert.equal(log.removes, 1);
  } finally {
    await shutdown(server, clients);
  }

  const drained = emptyLog();
  const drainServer = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(drained, { release: async () => undefined, remove: async () => undefined })),
  });
  const drainClient = await connectorFor(drainServer)();
  await drainClient.request(drainClient.serverRoute(), { op: "attach", runtimeId: "rt" });
  await drainServer.close();
  assert.deepEqual(drained.closes, ["drain"]);
  assert.equal(drained.removes, 0);
  assert.equal(drained.ownershipReleases, 1);
  await drainClient.dispose();

  const abortLog = emptyLog();
  const abortGate = deferred();
  const abortServer = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(abortLog, {
      close: (mode) => mode === "abort" ? Promise.resolve() : abortGate.promise,
      release: async () => undefined,
    })),
  });
  const abortClient = await connectorFor(abortServer)();
  try {
    await abortClient.request(abortClient.serverRoute(), { op: "attach", runtimeId: "rt" });
    const closing = abortServer.close();
    await until(() => abortLog.closes.includes("drain"), "the drain close");
    const aborting = abortServer.close("abort");
    assert.equal(aborting, closing);
    assert.deepEqual(abortLog.closes, ["drain", "abort"]);
    abortGate.resolve();
    await aborting;
    assert.equal(abortLog.ownershipReleases, 1);
    assert.equal(abortLog.removes, 0);
  } finally {
    await abortClient.dispose();
  }
});

test("close waits for an admitted call, and one failed cleanup does not skip the other", async () => {
  const gate = deferred<JsonValue>();
  const started = deferred();
  let handleClosed = false;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve({
      acquire: () => ({ service: { call: () => { started.resolve(); return gate.promise; } }, release: () => undefined }),
      close: () => {
        handleClosed = true;
        return Promise.resolve();
      },
      idle: () => false,
    }),
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    const pending = client.request(client.attachment!, { op: "work" });
    await started.promise;
    const closing = server.close();
    await Promise.resolve();
    assert.equal(handleClosed, false, "close waits for the admitted call before closing the handle");
    gate.resolve({ ok: true });
    await pending.catch(() => undefined);
    await closing;
    assert.equal(handleClosed, true);
  } finally {
    await client.dispose().catch(() => undefined);
  }

  const attempts: string[] = [];
  const failing = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: (runtimeId) => Promise.resolve({
      acquire: () => ({ service: { call: () => null }, release: () => undefined }),
      close: () => {
        attempts.push(runtimeId);
        return runtimeId === "bad" ? Promise.reject(new Error("bad close")) : Promise.resolve();
      },
      idle: () => false,
      release: async () => { attempts.push(`${runtimeId}:release`); },
    }),
  });
  const peer = await connectorFor(failing)();
  try {
    await peer.request(peer.serverRoute(), { op: "attach", runtimeId: "ok" });
    await peer.request(peer.serverRoute(), { op: "attach", runtimeId: "bad" });
    await assert.rejects(failing.close(), (error: unknown) => error instanceof Error && error.message === "bad close");
    assert.ok(attempts.includes("ok") && attempts.includes("ok:release") && attempts.includes("bad"));
    assert.equal(attempts.includes("bad:release"), false, "a failed close does not release that runtime");
    assert.ok(attempts.indexOf("ok") < attempts.indexOf("ok:release"));
    await assert.rejects(connectorFor(failing)().then((extra) => extra.dispose()), code("server_closing"));
  } finally {
    await peer.dispose().catch(() => undefined);
  }
});

test("a failed removal is not success and can retry without opening again", async () => {
  const log = emptyLog();
  let failClose = true;
  let opens = 0;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      opens += 1;
      return Promise.resolve(scripted(log, {
        idle: () => false,
        close: async () => {
          if (failClose) {
            failClose = false;
            throw new Error("close broke");
          }
        },
        remove: async () => undefined,
        release: async () => undefined,
      }));
    },
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    await assert.rejects(server.removeRuntime("rt"), (error: unknown) => error instanceof Error && error.message === "close broke");
    assert.equal(log.removes, 0);
    assert.equal(log.ownershipReleases, 0);
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("runtime_busy"));
    assert.equal(opens, 1);
    await server.removeRuntime("rt");
    assert.equal(log.removes, 1);
    assert.equal(log.ownershipReleases, 0);
    assert.equal(opens, 1);
    await server.removeRuntime("rt");
    assert.equal(log.removes, 1);
  } finally {
    await client.dispose().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("an in-flight release cannot be upgraded into a delete, but an in-flight close can", async () => {
  const closeGate = deferred();
  const upgradeLog = emptyLog();
  let opens = 0;
  const upgradeServer = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      opens += 1;
      return Promise.resolve(scripted(upgradeLog, {
        idle: () => true,
        close: () => closeGate.promise,
        remove: async () => undefined,
        release: async () => undefined,
      }));
    },
  });
  const upgradeClient = await connectorFor(upgradeServer)();
  try {
    await upgradeClient.request(upgradeClient.serverRoute(), { op: "attach", runtimeId: "rt" });
    await upgradeClient.request(upgradeClient.serverRoute(), { op: "detach" });
    await until(() => upgradeLog.closes.length === 1, "idle reclaim to start closing");
    const removing = upgradeServer.removeRuntime("rt");
    closeGate.resolve();
    await removing;
    assert.equal(upgradeLog.removes, 1);
    assert.equal(upgradeLog.ownershipReleases, 0);
    assert.equal(opens, 1);
  } finally {
    await upgradeClient.dispose();
    await upgradeServer.close().catch(() => undefined);
  }

  const releaseGate = deferred();
  const lateLog = emptyLog();
  const lateServer = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(lateLog, {
      idle: () => true,
      remove: async () => undefined,
      release: () => releaseGate.promise,
    })),
  });
  const lateClient = await connectorFor(lateServer)();
  try {
    await lateClient.request(lateClient.serverRoute(), { op: "attach", runtimeId: "rt" });
    await lateClient.request(lateClient.serverRoute(), { op: "detach" });
    await until(() => lateLog.ownershipReleases === 1, "ownership release to start");
    await assert.rejects(lateServer.removeRuntime("rt"), /releasing ownership without deleting data/);
    releaseGate.resolve();
    await releaseGate.promise;
    // The release function, dropOwnership, and finishRemoval each resume on a later turn.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lateLog.closes.length, 1);
    assert.equal(lateLog.removes, 0);
    await lateServer.removeRuntime("rt");
    assert.equal(lateLog.removes, 0, "a finished reclaim no longer has a handle that can delete");
  } finally {
    await lateClient.dispose();
    await lateServer.close().catch(() => undefined);
  }
});

function label(message: ServerMessage): string {
  if (message.type === "hello") return "hello";
  if (message.type === "attachment") return message.attachment ? `attachment:${message.attachment.runtimeId}` : "attachment:null";
  if (message.type === "response") return message.ok ? `response:${message.id}` : `error:${message.error.code}`;
  return message.type;
}
