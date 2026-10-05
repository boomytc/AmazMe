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

test("a sandbox open failure keeps its code and the original message", async () => {
  const message = "SANDBOX_UNAVAILABLE: probe failed: forbidden file was readable";
  const cases: unknown[] = [
    new ServiceError("sandbox_unavailable", message),
    new Error(message),
  ];
  for (const failure of cases) {
    const errors: Error[] = [];
    const server = new Server({
      serverId: "srv",
      service: attachService(),
      onError: (error) => errors.push(error),
      openRuntime: () => Promise.reject(failure),
    });
    const connect = connectorFor(server);
    const clients: Client[] = [];
    try {
      const client = await connect();
      clients.push(client);
      await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(error.code, "sandbox_unavailable");
        assert.equal(error.message, message);
        return true;
      });
      assert.equal(errors.length, 0);
    } finally {
      await shutdown(server, clients);
    }
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
  let exists = true;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      if (!exists) return Promise.resolve(null);
      opens += 1;
      return Promise.resolve(scripted(log, {
        idle: () => false,
        close: async () => {
          if (failClose) {
            failClose = false;
            throw new Error("close broke");
          }
        },
        remove: async () => { exists = false; },
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
    assert.equal(lateLog.removes, 1, "a finished reclaim must reacquire ownership before deleting durable data");
    assert.equal(lateLog.closes.length, 2);
  } finally {
    await lateClient.dispose();
    await lateServer.close().catch(() => undefined);
  }
});

test("remove resolves an unloaded runtime under one exclusive slot and only null means absent", async () => {
  const opening = deferred<RuntimeHandle>();
  const log = emptyLog();
  let opens = 0;
  let openSignal: AbortSignal | undefined;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: (id, signal) => {
      opens += 1;
      openSignal = signal;
      return id === "absent" ? Promise.resolve(null) : opening.promise;
    },
  });
  const client = await connectorFor(server)();
  try {
    const removing = server.removeRuntime("rt");
    assert.equal(server.removeRuntime("rt"), removing);
    await until(() => opens === 1, "the controlled resolver");
    assert.equal(openSignal?.aborted, false, "opening for deletion must not cancel its own acquisition");
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("runtime_busy"));
    opening.resolve(scripted(log, { remove: async () => undefined, release: async () => undefined }));
    await removing;
    assert.equal(log.acquires, 0);
    assert.deepEqual(log.closes, ["drain"]);
    assert.equal(log.removes, 1);
    assert.equal(log.ownershipReleases, 0);
    await server.removeRuntime("absent");
    assert.equal(opens, 2);
  } finally {
    await client.dispose();
    await server.close();
  }
});

test("initial abort signals the host before waiting for a runtime call that ignores the RPC signal", async () => {
  const started = deferred();
  const work = deferred<JsonValue>();
  const log = emptyLog();
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(log, {
      service: { call: () => { started.resolve(); return work.promise; } },
      close: async (mode) => { if (mode === "abort") work.resolve({ aborted: true }); },
      release: async () => undefined,
    })),
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    const pending = client.request(client.attachment!, { op: "work" }).catch(() => undefined);
    await started.promise;
    const closing = server.close("abort");
    assert.deepEqual(log.closes, ["abort"], "the host receives abort immediately");
    await closing;
    await pending;
    assert.equal(log.leaseReleases, 1);
    assert.equal(log.ownershipReleases, 1);
  } finally {
    work.resolve(null);
    await client.dispose();
    await server.close("abort");
  }
});

test("abort upgrade is part of the shutdown barrier and a failed server close retries without reopening admission", async () => {
  const drain = deferred();
  const abort = deferred();
  const log = emptyLog();
  let retry = false;
  const failure = new Error("abort upgrade failed");
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(log, {
      close: (mode) => retry ? Promise.resolve() : mode === "drain" ? drain.promise : abort.promise,
      release: async () => undefined,
    })),
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    const closing = server.close();
    const rejected = assert.rejects(closing, (error: unknown) => error === failure);
    await until(() => log.closes.includes("drain"), "the first drain");
    assert.equal(server.close("abort"), closing);
    drain.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(log.ownershipReleases, 0, "the first drain cannot release ahead of the abort upgrade");
    abort.reject(failure);
    await rejected;
    assert.equal(log.ownershipReleases, 0, "a failed upgrade keeps ownership");
    assert.equal(server.closed, true);
    await assert.rejects(connectorFor(server)(), code("server_closing"));
    retry = true;
    const retried = server.close();
    assert.notEqual(retried, closing);
    assert.equal(server.close(), retried);
    await retried;
    assert.equal(log.ownershipReleases, 1);
    assert.deepEqual(log.closes, ["drain", "abort", "abort"]);
    await assert.rejects(connectorFor(server)(), code("server_closing"));
  } finally {
    drain.resolve();
    abort.resolve();
    retry = true;
    await client.dispose();
    await server.close().catch(() => undefined);
  }
});

test("a watcher installation failure closes the acquired owner before allowing another open", async () => {
  const closed = deferred();
  const first = emptyLog();
  const next = emptyLog();
  let opens = 0;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      opens += 1;
      if (opens > 1) return Promise.resolve(scripted(next));
      const handle = scripted(first, { close: () => closed.promise, release: async () => undefined });
      handle.watchIdle = () => { throw new Error("watcher failed"); };
      return Promise.resolve(handle);
    },
  });
  const client = await connectorFor(server)();
  try {
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("internal"));
    assert.equal(first.acquires, 0);
    await assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("runtime_busy"));
    assert.equal(opens, 1);
    closed.resolve();
    await until(() => first.ownershipReleases === 1, "the failed owner's release");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    assert.equal(opens, 2);
    assert.equal(next.acquires, 1);
  } finally {
    closed.resolve();
    await shutdown(server, [client]);
  }
});

test("a synchronous factory can remove its own opening slot without losing the late owner", async () => {
  const gate = deferred<RuntimeHandle>();
  const log = emptyLog();
  let removing: Promise<void> | undefined;
  let server!: Server;
  server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      removing = server.removeRuntime("rt");
      return gate.promise;
    },
  });
  const client = await connectorFor(server)();
  try {
    const pending = assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("runtime_busy"));
    await until(() => removing !== undefined, "the reentrant removal");
    let finished = false;
    void removing!.then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "removal waits for a factory whose open barrier is already registered");
    gate.resolve(scripted(log, { remove: async () => undefined, release: async () => undefined }));
    await removing;
    await pending;
    assert.equal(log.acquires, 0);
    assert.deepEqual(log.closes, ["drain"]);
    assert.equal(log.removes, 1);
  } finally {
    await client.dispose();
    await server.close();
  }
});

test("removal during synchronous acquire waits for the orphan lease before releasing ownership", async () => {
  const released = deferred();
  const log = emptyLog();
  let removing: Promise<void> | undefined;
  let server!: Server;
  server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(log, {
      acquire: () => {
        removing = server.removeRuntime("rt");
        return { service: { call: () => null }, release: () => { log.leaseReleases += 1; return released.promise; } };
      },
      release: async () => undefined,
      remove: async () => undefined,
    })),
  });
  const client = await connectorFor(server)();
  try {
    const pending = assert.rejects(client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }), code("runtime_busy"));
    await until(() => log.leaseReleases === 1, "the orphan lease's release");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(log.closes.length, 0);
    assert.equal(log.removes, 0);
    released.resolve();
    await removing;
    await pending;
    assert.deepEqual(log.closes, ["drain"]);
    assert.equal(log.removes, 1);
  } finally {
    released.resolve();
    await client.dispose();
    await server.close();
  }
});

test("reentrant removal from an opening-signal callback shares the published removal barrier", async () => {
  const log = emptyLog();
  let nested: Promise<void> | undefined;
  let server!: Server;
  server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: (_id, signal) => {
      signal.addEventListener("abort", () => { nested = server.removeRuntime("rt"); }, { once: true });
      return Promise.resolve(scripted(log, { remove: async () => undefined, release: async () => undefined }));
    },
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    const removing = server.removeRuntime("rt");
    assert.equal(nested, removing);
    await removing;
    assert.deepEqual(log.closes, ["drain"]);
    assert.equal(log.leaseReleases, 1);
    assert.equal(log.removes, 1);
  } finally {
    await shutdown(server, [client]);
  }
});

test("a synchronous factory can close the server without allowing cleanup ahead of its late handle", async () => {
  const gate = deferred<RuntimeHandle>();
  const log = emptyLog();
  let closing: Promise<void> | undefined;
  let server!: Server;
  server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => {
      closing = server.close("abort");
      return gate.promise;
    },
  });
  const client = await connectorFor(server)();
  try {
    const pending = client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" }).catch(() => undefined);
    await until(() => closing !== undefined, "the reentrant close");
    let finished = false;
    void closing!.then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    gate.resolve(scripted(log, { release: async () => undefined }));
    await closing;
    await pending;
    assert.equal(log.acquires, 0);
    assert.deepEqual(log.closes, ["abort"]);
    assert.equal(log.ownershipReleases, 1);
  } finally {
    await client.dispose();
    await server.close();
  }
});

test("synchronous close callbacks cannot overwrite an abort upgrade or recursively start another abort", async () => {
  for (const fail of [false, true]) {
    const abort = deferred();
    const log = emptyLog();
    let retry = false;
    let server!: Server;
    const failure = new Error("reentrant abort failed");
    server = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => Promise.resolve(scripted(log, {
        close: (mode) => {
          void server.close("abort").catch(() => undefined);
          return mode === "drain" || retry ? Promise.resolve() : abort.promise;
        },
        release: async () => undefined,
      })),
    });
    const client = await connectorFor(server)();
    try {
      await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
      const closing = server.close();
      let finished = false;
      const observed = closing.then(() => { finished = true; }, (error: unknown) => {
        assert.equal(error, failure);
        assert.equal(fail, true);
        finished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(log.closes, ["drain", "abort"]);
      assert.equal(finished, false);
      assert.equal(log.ownershipReleases, 0);
      if (fail) abort.reject(failure);
      else abort.resolve();
      await observed;
      assert.equal(log.ownershipReleases, fail ? 0 : 1);
      if (fail) {
        retry = true;
        await server.close();
        assert.deepEqual(log.closes, ["drain", "abort", "abort"]);
        assert.equal(log.ownershipReleases, 1);
      }
    } finally {
      abort.resolve();
      retry = true;
      await client.dispose();
      await server.close().catch(() => undefined);
    }
  }
});

test("falsy host and factory rejections remain failures and can retry", async () => {
  const log = emptyLog();
  let failClose = true;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: () => Promise.resolve(scripted(log, {
      close: () => failClose ? Promise.reject(undefined) : Promise.resolve(),
      release: async () => undefined,
    })),
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    await server.close().then(() => assert.fail("undefined rejection became success"), (error: unknown) => assert.equal(error, undefined));
    assert.equal(log.ownershipReleases, 0);
    failClose = false;
    await server.close();
    assert.equal(log.ownershipReleases, 1);
  } finally {
    failClose = false;
    await client.dispose();
    await server.close().catch(() => undefined);
  }
  for (const failure of [undefined, null, false, 0, ""]) {
    let failOpen = true;
    const factory = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => failOpen ? Promise.reject(failure) : Promise.resolve(null),
    });
    await factory.removeRuntime("rt").then(() => assert.fail("falsy factory rejection became success"), (error: unknown) => assert.equal(error, failure));
    failOpen = false;
    await factory.removeRuntime("rt");
    await factory.close();
  }
});

test("a failed watcher unsubscribe is retained until a shutdown retry completes it", async () => {
  let active = 0;
  let unsubscribes = 0;
  let released = false;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: async () => ({
      idle: () => false,
      acquire: () => ({ service: { call: () => null }, release() {} }),
      close: async () => undefined,
      release: async () => { released = true; },
      watchIdle: () => {
        active += 1;
        return () => {
          unsubscribes += 1;
          if (unsubscribes === 1) throw new Error("unsubscribe once");
          active -= 1;
        };
      },
    }),
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    await assert.rejects(server.close(), /unsubscribe once/);
    assert.equal(active, 1);
    await server.close();
    assert.equal(active, 0);
    assert.equal(unsubscribes, 2);
    assert.equal(released, true);
  } finally {
    await client.dispose();
    await server.close().catch(() => undefined);
  }
});

test("a synchronous lease release failure can be retried instead of caching its rejected promise", async () => {
  let attempts = 0;
  const server = new Server({
    serverId: "srv",
    service: attachService(),
    openRuntime: async () => ({
      idle: () => false,
      acquire: () => ({
        service: { call: () => null },
        release() {
          attempts += 1;
          if (attempts === 1) throw new Error("release sync once");
        },
      }),
      close: async () => undefined,
      release: async () => undefined,
    }),
  });
  const client = await connectorFor(server)();
  try {
    await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
    await assert.rejects(server.close(), /release sync once/);
    assert.equal(attempts, 1);
    await server.close();
    assert.equal(attempts, 2);
  } finally {
    await client.dispose();
    await server.close().catch(() => undefined);
  }
});

test("an abort arriving during ownership release or deletion does not restart a completed host close", async () => {
  for (const deleting of [false, true]) {
    const dropping = deferred();
    const ownership = deferred();
    const abort = deferred();
    const log = emptyLog();
    const server = new Server({
      serverId: "srv",
      service: attachService(),
      openRuntime: () => Promise.resolve(scripted(log, {
        close: (mode) => mode === "abort" ? abort.promise : Promise.resolve(),
        release: () => { dropping.resolve(); return ownership.promise; },
        remove: () => { dropping.resolve(); return ownership.promise; },
      })),
    });
    const client = await connectorFor(server)();
    try {
      await client.request(client.serverRoute(), { op: "attach", runtimeId: "rt" });
      const removing = deleting ? server.removeRuntime("rt") : undefined;
      const closing = server.close();
      let finished = false;
      void closing.then(() => { finished = true; });
      await dropping.promise;
      assert.equal(server.close("abort"), closing);
      assert.deepEqual(log.closes, ["drain"], "host work has ended and cannot be restarted after ownership dropping begins");
      assert.equal(finished, false);
      ownership.resolve();
      await closing;
      await removing;
      assert.equal(finished, true);
      assert.equal(log.removes, deleting ? 1 : 0);
      assert.equal(log.ownershipReleases, deleting ? 0 : 1);
    } finally {
      ownership.resolve();
      abort.resolve();
      await client.dispose();
      await server.close().catch(() => undefined);
    }
  }
});

function label(message: ServerMessage): string {
  if (message.type === "hello") return "hello";
  if (message.type === "attachment") return message.attachment ? `attachment:${message.attachment.runtimeId}` : "attachment:null";
  if (message.type === "response") return message.ok ? `response:${message.id}` : `error:${message.error.code}`;
  return message.type;
}
