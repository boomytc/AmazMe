import {
  ClientMessageDecoder,
  encodeServerMessage,
  errorBody,
  isRuntimeRoute,
  isSupportedVersion,
  PROTOCOL_VERSION,
  ProtocolError,
  resolveLimits,
  sameRoute,
  type ClientMessage,
  type ErrorBody,
  type JsonValue,
  type ProtocolLimits,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Route,
  type RuntimeRoute,
  type ServerMessage,
} from "@amazme/protocol";
import { ServiceError, toError } from "./errors.ts";
import type {
  AttachmentLease,
  ByteConnection,
  ByteConnectionHandlers,
  CallContext,
  RuntimeHandle,
  RuntimeService,
  ServerCallContext,
  ServerService,
  SubscriptionSink,
} from "./types.ts";
import { FrameWriter } from "@amazme/protocol/writer";

export interface ServerOptions {
  /** Logical identity reported in the handshake. Unrelated to any listening address. */
  serverId: string;
  /** Handles server-route calls; it decides when to use the attach and detach capability. */
  service: ServerService;
  limits?: Partial<ProtocolLimits>;
  /** Default 64. Further connections receive `server_busy` and are closed. */
  maxConnections?: number;
  /** Concurrent calls per connection. Further requests are answered with `too_many_requests`. Default 64. */
  maxActiveRequests?: number;
  /** Open sinks per connection. Default 32. */
  maxSubscriptions?: number;
  /** Encoded bytes waiting for one connection's transport. Going over closes that connection. Default two frames. */
  maxQueuedBytes?: number;
  handshakeTimeoutMs?: number;
  /** Diagnostics for internal service errors and dropped connections. Its own errors are ignored. */
  onError?: (error: Error) => void;
  /**
   * Opens one host-allowed runtime. Return null when the id is not offered.
   * The server merges concurrent opens of the same id and calls this once.
   * `signal` aborts when every waiter has left, or when the runtime is removed or the server is closing.
   * It is not the signal of one RPC. A client cannot supply a path, module, or constructor options.
   * A throw must leave no acquired resource. A returned handle belongs to the server, which closes it and
   * then releases or deletes it; the factory does not free that handle itself.
   */
  openRuntime(runtimeId: string, signal: AbortSignal): Promise<RuntimeHandle | null>;
}

const CODE = /^[a-z][a-z0-9_.-]*$/;
const FINAL_FRAME_TIMEOUT_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

interface Active {
  controller: AbortController;
  route: Route;
}

interface Opened {
  readonly sinks: Sink[];
  settled: boolean;
  /** Runs after this call's response has been handed to the transport. */
  readonly after: Array<() => Promise<void>>;
}

interface LeaseState {
  readonly slot: RuntimeSlot;
  readonly lease: AttachmentLease;
  readonly admitted: Set<Promise<void>>;
  released: boolean;
  settling?: Promise<void>;
}

interface RuntimeSlot {
  readonly runtimeId: string;
  readonly controller: AbortController;
  state: "opening" | "open" | "removing";
  handle?: RuntimeHandle;
  ready?: Promise<RuntimeHandle>;
  interests: number;
  readonly leases: Set<LeaseState>;
  unwatch?: () => void;
  removal?: Promise<void>;
  closeOnce?: Promise<void>;
  closeMode?: "drain" | "abort";
  /** Explicit removal. An idle reclaim must not clear it. */
  deleteData: boolean;
  /** Set for the ownership step that is already in progress. A release cannot be upgraded into a delete. */
  dropping?: "release" | "remove";
}

interface Conn {
  readonly id: string;
  readonly transport: ByteConnection;
  readonly decoder: ClientMessageDecoder;
  readonly writer: FrameWriter;
  readonly active: Map<string, Active>;
  readonly sinks: Map<string, Sink>;
  state: "awaiting_hello" | "ready" | "closed";
  attachment: RuntimeRoute | null;
  lease: LeaseState | null;
  /**
   * Serializes route changes and admission. The running job is not in `gate`. Business calls start only
   * after the running admission releases it, so a call can itself attach or detach.
   */
  gate: Array<() => void>;
  gating: boolean;
  timer?: ReturnType<typeof setTimeout>;
  updates: Promise<unknown>;
  updateBytes: number;
}

/**
 * Routes protocol envelopes to the server service and to runtimes opened through `openRuntime`.
 * It interprets no business payload. One lifecycle owns every runtime id: concurrent opens join,
 * and removal or close is the only way that instance is dropped.
 */
export class Server {
  readonly serverId: string;
  private readonly options: ServerOptions;
  private readonly limits: ProtocolLimits;
  private readonly maxConnections: number;
  private readonly maxActive: number;
  private readonly maxSubscriptions: number;
  private readonly maxQueued: number;
  private readonly handshakeTimeoutMs: number;
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly connections = new Set<Conn>();
  private readonly tasks = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private stopped = false;
  private abortClose = false;

  constructor(options: ServerOptions) {
    this.options = options;
    this.serverId = options.serverId;
    this.limits = resolveLimits(options.limits);
    encodeServerMessage({ type: "hello", version: PROTOCOL_VERSION, serverId: options.serverId }, this.limits);
    this.maxConnections = positive("maxConnections", options.maxConnections ?? 64);
    this.maxActive = positive("maxActiveRequests", options.maxActiveRequests ?? 64);
    this.maxSubscriptions = positive("maxSubscriptions", options.maxSubscriptions ?? 32);
    this.maxQueued = positive("maxQueuedBytes", options.maxQueuedBytes ?? 2 * (this.limits.maxFrameBytes + 4));
    this.handshakeTimeoutMs = positive("handshakeTimeoutMs", options.handshakeTimeoutMs ?? 10_000);
    if (this.handshakeTimeoutMs > MAX_TIMER_MS) throw new RangeError(`handshakeTimeoutMs must be at most ${MAX_TIMER_MS}`);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get closed(): boolean {
    return this.stopped;
  }

  /**
   * Forbids new attachments, revokes current ones, waits until their admitted calls finish, then closes
   * the handle and, if the handle offers it, deletes host data. Repeated calls share one operation.
   * An unloaded id is resolved through `openRuntime` under the same exclusive slot; null is absent.
   * Failure rejects and can be retried; it is not reported as success.
   */
  removeRuntime(runtimeId: string): Promise<void> {
    const slot = this.slots.get(runtimeId);
    if (slot) return this.removeSlot(slot, true);
    if (this.stopped) return Promise.reject(new ServiceError("server_closing", "server is closing"));
    try {
      this.validateRuntimeId(runtimeId);
      // An unloaded runtime can still have durable data. Resolve it under the same slot that
      // excludes attachment opens, and retain its ownership until removal finishes.
      return this.removeSlot(this.slotFor(runtimeId, true), true, false);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  accept(transport: ByteConnection): ByteConnectionHandlers {
    const conn: Conn = {
      id: globalThis.crypto.randomUUID(),
      transport,
      decoder: new ClientMessageDecoder(this.limits),
      writer: new FrameWriter((chunk) => transport.send(chunk), this.maxQueued, (error) => this.drop(conn, error)),
      active: new Map(),
      sinks: new Map(),
      state: "awaiting_hello",
      attachment: null,
      lease: null,
      gate: [],
      gating: false,
      updates: Promise.resolve(),
      updateBytes: 0,
    };
    const handlers: ByteConnectionHandlers = {
      onData: (chunk) => this.receive(conn, chunk),
      onClose: () => {
        if (conn.state === "closed") return;
        try {
          conn.decoder.end();
        } catch (error) {
          this.report(error);
        }
        this.drop(conn);
      },
      onError: (error) => this.drop(conn, error),
    };
    if (this.stopped) {
      this.fatal(conn, errorBody("server_closing", "server is closing"));
      return handlers;
    }
    if (this.connections.size >= this.maxConnections) {
      this.fatal(conn, errorBody("server_busy", `server accepts at most ${this.maxConnections} connections`));
      return handlers;
    }
    this.connections.add(conn);
    conn.timer = setTimeout(() => this.fatal(conn, errorBody("handshake_timeout", "client hello did not arrive in time")), this.handshakeTimeoutMs);
    return handlers;
  }

  /**
   * Stops accepting, aborts call signals, and closes every opened runtime.
   * `drain` waits for host work. `abort` asks each handle to stop; a later abort upgrades an in-flight drain.
   * Repeated calls share this promise. A rejected shutdown can be retried while admission stays closed.
   * One handle failing does not skip the others.
   */
  close(mode: "drain" | "abort" = "drain"): Promise<void> {
    if (mode === "abort") this.abortClose = true;
    this.stopped = true;
    if (!this.closing) {
      const closing = deferred<void>();
      this.closing = closing.promise;
      for (const conn of [...this.connections]) this.drop(conn);
      void this.shutdown().then(() => closing.resolve(), (error: unknown) => {
        if (this.closing === closing.promise) this.closing = undefined;
        closing.reject(error);
      });
    }
    if (mode === "abort") {
      // Ask the producer to stop before waiting for calls that may themselves await that producer.
      // closeHandle retains its completion/error barrier; the shutdown waits before dropping ownership.
      for (const slot of this.slots.values()) {
        if (slot.handle) void this.closeHandle(slot, "abort").catch((error: unknown) => this.report(error));
      }
    }
    return this.closing;
  }

  private receive(conn: Conn, chunk: Uint8Array): void {
    if (conn.state === "closed") return;
    let messages: ClientMessage[];
    try {
      messages = conn.decoder.push(chunk);
    } catch (error) {
      this.fatal(conn, errorBody("protocol_error", error instanceof ProtocolError ? error.message : "invalid client data"));
      return;
    }
    for (const message of messages) {
      if (closed(conn)) return;
      this.dispatch(conn, message);
    }
  }

  private dispatch(conn: Conn, message: ClientMessage): void {
    if (conn.state === "awaiting_hello") {
      if (message.type !== "hello") {
        this.fatal(conn, errorBody("protocol_error", "the first client message must be hello"));
        return;
      }
      if (!isSupportedVersion(message.version)) {
        this.fatal(conn, errorBody("unsupported_version", `protocol version ${message.version} is not ${PROTOCOL_VERSION}`));
        return;
      }
      conn.state = "ready";
      clearTimeout(conn.timer);
      this.write(conn, { type: "hello", version: PROTOCOL_VERSION, serverId: this.serverId });
      return;
    }
    if (message.type === "hello") {
      this.fatal(conn, errorBody("protocol_error", "hello may only be sent once"));
      return;
    }
    if (message.type === "cancel") {
      const active = conn.active.get(message.id);
      if (active && sameRoute(active.route, message.route)) active.controller.abort(new DOMException("request cancelled", "AbortError"));
      return;
    }
    this.admit(conn, message);
  }

  private admit(conn: Conn, request: RequestEnvelope): void {
    if (conn.active.has(request.id)) {
      this.fatal(conn, errorBody("duplicate_request", `request ${request.id} is already active`));
      return;
    }
    if (conn.active.size >= this.maxActive) {
      this.respond(conn, request.id, errorBody("too_many_requests", `at most ${this.maxActive} requests may be active`));
      return;
    }
    const route = request.route;
    if (route.serverId !== this.serverId) {
      this.respond(conn, request.id, errorBody("wrong_server", `request is for server ${route.serverId}`));
      return;
    }
    const controller = new AbortController();
    conn.active.set(request.id, { controller, route });
    const opened: Opened = { sinks: [], settled: false, after: [] };
    // Admission is synchronous when the gate is free, so a call that closes the server still stops
    // later messages in the same chunk. The gate is released before the call, which may attach.
    this.enterGate(conn, () => {
      let ready: ((context: CallContext) => ReturnType<ServerService["call"]>) | null;
      try {
        ready = this.prepare(conn, request, controller);
      } catch (error) {
        this.releaseGate(conn);
        this.finishCall(conn, request, controller, opened, Promise.reject(error));
        return;
      }
      this.releaseGate(conn);
      if (!ready) return;
      // Register the call before invoking it. close() from that call must see the task, and the
      // invocation itself stays synchronous so it still runs inside this chunk.
      const outcome = deferred<JsonValue | undefined>();
      this.finishCall(conn, request, controller, opened, outcome.promise);
      try {
        outcome.resolve(ready(this.context(conn, route, controller.signal, opened)));
      } catch (error) {
        outcome.reject(error);
      }
    });
  }

  /** Tracks the call before awaiting it, so close sees work that a synchronous call has already started. */
  private finishCall(conn: Conn, request: RequestEnvelope, controller: AbortController, opened: Opened, pending: ReturnType<ServerService["call"]>): void {
    const outcome = Promise.resolve(pending);
    const task = (async () => {
      let response: ResponseEnvelope;
      try {
        const result = await outcome;
        response = result === undefined ? { type: "response", id: request.id, ok: true } : { type: "response", id: request.id, ok: true, result };
      } catch (error) {
        response = { type: "response", id: request.id, ok: false, error: this.errorFor(error, controller.signal) };
      }
      opened.settled = true;
      if (conn.active.get(request.id)?.controller === controller) conn.active.delete(request.id);
      if (conn.state === "closed") {
        for (const sink of opened.sinks) sink.close();
      } else {
        let succeeded = response.ok;
        const sent = this.write(conn, response, true);
        if (!sent) {
          succeeded = false;
          if (response.ok) this.respond(conn, request.id, errorBody("internal", "the result could not be encoded"));
        }
        if (succeeded && sent) {
          try {
            await sent;
          } catch {
            succeeded = false;
          }
        }
        for (const sink of opened.sinks) {
          if (succeeded) sink.activate();
          else sink.close();
        }
      }
      for (const follow of opened.after) {
        try {
          await follow();
        } catch (error) {
          this.report(error);
        }
      }
    })();
    this.track(task);
  }

  /** Route check under the connection gate. The returned call runs after the gate is released. */
  private prepare(
    conn: Conn,
    request: RequestEnvelope,
    controller: AbortController,
  ): ((context: CallContext) => ReturnType<ServerService["call"]>) | null {
    if (conn.state === "closed" || conn.active.get(request.id)?.controller !== controller) {
      conn.active.delete(request.id);
      return null;
    }
    const route = request.route;
    if (isRuntimeRoute(route)) {
      const attached = conn.attachment;
      const lease = conn.lease;
      if (!attached || attached.runtimeId !== route.runtimeId || !lease || lease.slot.state === "removing") {
        conn.active.delete(request.id);
        this.respond(conn, request.id, errorBody("not_attached", `runtime ${route.runtimeId} is not attached to this connection`));
        return null;
      }
      if (attached.attachmentId !== route.attachmentId) {
        conn.active.delete(request.id);
        this.respond(conn, request.id, errorBody("stale_attachment", "the attachment was replaced or released"));
        return null;
      }
      let finish!: () => void;
      const admitted = new Promise<void>((resolve) => { finish = resolve; });
      lease.admitted.add(admitted);
      return async (context) => {
        try {
          return await lease.lease.service.call(request.call, context as Parameters<RuntimeService["call"]>[1]);
        } finally {
          lease.admitted.delete(admitted);
          finish();
        }
      };
    }
    return (context) => this.options.service.call(request.call, context as ServerCallContext);
  }

  private context(conn: Conn, route: Route, signal: AbortSignal, opened: Opened): CallContext | ServerCallContext {
    const base: CallContext = {
      connectionId: conn.id,
      route,
      limits: this.limits,
      signal,
      openSubscription: (subscriptionId) => {
        if (conn.state === "closed") throw new ServiceError("connection_closed", "the connection is closed");
        if (opened.settled) throw new ServiceError("call_settled", "subscriptions open only while their call runs");
        if (isRuntimeRoute(route) && !sameRoute(route, conn.attachment)) throw new ServiceError("stale_attachment", "the attachment was replaced or released");
        try {
          encodeServerMessage({ type: "service_update", subscriptionId, update: null }, this.limits);
        } catch {
          throw new ServiceError("invalid_subscription", "subscription ID is not a protocol ID");
        }
        if (conn.sinks.has(subscriptionId)) throw new ServiceError("duplicate_subscription", `subscription ${subscriptionId} is already open`);
        if (conn.sinks.size >= this.maxSubscriptions) throw new ServiceError("too_many_subscriptions", `at most ${this.maxSubscriptions} subscriptions may be open`);
        const sink: Sink = new Sink(conn.id, subscriptionId, route, {
          send: (update): Promise<boolean> => this.sendUpdate(conn, sink, update),
          remove: () => {
            if (conn.sinks.get(subscriptionId) === sink) conn.sinks.delete(subscriptionId);
          },
        });
        conn.sinks.set(subscriptionId, sink);
        opened.sinks.push(sink);
        return sink;
      },
      subscription: (subscriptionId) => {
        const sink = conn.sinks.get(subscriptionId);
        return sink && sameRoute(sink.route, route) ? sink : undefined;
      },
    };
    if (isRuntimeRoute(route)) return base;
    const server = this;
    return {
      ...base,
      route,
      get attachment() {
        return conn.attachment ? { ...conn.attachment } : null;
      },
      attach(runtimeId: string): Promise<RuntimeRoute> {
        if (opened.settled) throw new ServiceError("call_settled", "attachment changes only while their call runs");
        if (conn.state === "closed" || server.stopped) throw new ServiceError("connection_closed", "the connection is closed");
        return server.changeAttachment(conn, runtimeId, signal, opened);
      },
      detach(): Promise<void> {
        if (opened.settled) throw new ServiceError("call_settled", "attachment changes only while their call runs");
        if (conn.state === "closed" || !conn.attachment) return Promise.resolve();
        return server.exclusive(conn, () => {
          if (conn.state === "closed" || !conn.attachment) return;
          const previous = conn.lease;
          server.publishAttachment(conn, null, null);
          if (previous) opened.after.push(() => server.settleLease(previous));
        });
      },
    } satisfies ServerCallContext;
  }

  /** Runs `fn` immediately when the gate is free, otherwise after the current job. Holds the gate until `fn` settles. */
  private exclusive<T>(conn: Conn, fn: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        let finished: Promise<T>;
        try {
          finished = Promise.resolve(fn());
        } catch (error) {
          finished = Promise.reject(error);
        }
        void finished.then(resolve, reject).finally(() => this.releaseGate(conn));
      };
      this.enterGate(conn, start);
    });
  }

  private enterGate(conn: Conn, start: () => void): void {
    if (conn.gating) conn.gate.push(start);
    else {
      conn.gating = true;
      start();
    }
  }

  private releaseGate(conn: Conn): void {
    const next = conn.gate.shift();
    if (next) next();
    else conn.gating = false;
  }

  private async changeAttachment(conn: Conn, runtimeId: string, signal: AbortSignal, opened: Opened): Promise<RuntimeRoute> {
    return this.exclusive(conn, async () => {
      if (opened.settled) throw new ServiceError("call_settled", "attachment changes only while their call runs");
      if (closed(conn) || this.stopped) throw new ServiceError("connection_closed", "the connection is closed");
      if (conn.attachment?.runtimeId === runtimeId && conn.lease && conn.lease.slot.state === "open") return { ...conn.attachment };
      const previous = conn.lease;
      try {
        const handle = await this.joinOpen(runtimeId, signal);
        if (closed(conn) || this.stopped) throw new ServiceError("connection_closed", "the connection closed while attaching");
        if (signal.aborted) throw aborted();
        const slot = this.slots.get(runtimeId);
        if (!slot || slot.handle !== handle || !isOpen(slot)) throw new ServiceError("runtime_busy", `runtime ${runtimeId} is closing`);
        let acquired: AttachmentLease;
        try {
          acquired = handle.acquire();
        } catch (error) {
          if (error instanceof ServiceError) throw error;
          throw new ServiceError("internal", "the runtime did not grant a lease");
        }
        if (closed(conn) || this.stopped || signal.aborted || !isOpen(slot) || slot.handle !== handle) {
          await this.settleAcquired(slot, acquired);
          if (signal.aborted && !closed(conn) && !this.stopped) throw aborted();
          if (slot.state === "removing") throw new ServiceError("runtime_busy", `runtime ${runtimeId} is closing`);
          throw new ServiceError("connection_closed", "the connection closed while attaching");
        }
        const next: LeaseState = { slot, lease: acquired, admitted: new Set(), released: false };
        const route: RuntimeRoute = { serverId: this.serverId, runtimeId, attachmentId: globalThis.crypto.randomUUID() };
        this.publishAttachment(conn, route, next);
        if (closed(conn) || conn.lease !== next) {
          if (conn.lease === next) {
            conn.attachment = null;
            conn.lease = null;
          }
          opened.after.push(() => this.settleLease(next));
          if (previous && previous !== next) opened.after.push(() => this.settleLease(previous));
          throw new ServiceError("connection_closed", "the connection closed while attaching");
        }
        if (previous && previous !== next) opened.after.push(() => this.settleLease(previous));
        return { ...route };
      } finally {
        const openedSlot = this.slots.get(runtimeId);
        if (openedSlot && conn.lease?.slot !== openedSlot) this.reclaimIfIdle(openedSlot);
      }
    });
  }

  private async settleAcquired(slot: RuntimeSlot, acquired: AttachmentLease): Promise<void> {
    const orphan: LeaseState = { slot, lease: acquired, admitted: new Set(), released: false };
    slot.leases.add(orphan);
    await this.settleLease(orphan);
  }

  private publishAttachment(conn: Conn, attachment: RuntimeRoute | null, lease: LeaseState | null): void {
    conn.attachment = attachment;
    conn.lease = lease;
    if (lease) lease.slot.leases.add(lease);
    for (const sink of [...conn.sinks.values()]) {
      if (isRuntimeRoute(sink.route) && !sameRoute(sink.route, attachment)) sink.close();
    }
    if (conn.state !== "closed") this.write(conn, { type: "attachment", attachment });
  }

  private async joinOpen(runtimeId: string, signal: AbortSignal): Promise<RuntimeHandle> {
    this.validateRuntimeId(runtimeId);
    if (this.stopped) throw new ServiceError("connection_closed", "the connection is closed");
    const slot = this.slotFor(runtimeId);
    if (slot.state === "open" && slot.handle) return slot.handle;
    slot.interests += 1;
    let opened = false;
    try {
      const handle = await unlessAborted(slot.ready!, signal);
      opened = true;
      if (slot.state === "open" && slot.handle === handle) return handle;
      throw new ServiceError(slot.state === "removing" ? "runtime_busy" : "unknown_runtime", `runtime ${runtimeId} is not available`);
    } finally {
      slot.interests -= 1;
      if (!opened && slot.interests === 0 && slot.state === "opening") slot.controller.abort();
    }
  }

  private validateRuntimeId(runtimeId: string): void {
    try {
      encodeServerMessage({ type: "attachment", attachment: { serverId: this.serverId, runtimeId, attachmentId: "probe" } }, this.limits);
    } catch (error) {
      throw new ServiceError("unknown_runtime", error instanceof Error ? error.message : "invalid runtime");
    }
  }

  private slotFor(runtimeId: string, forRemoval = false): RuntimeSlot {
    const existing = this.slots.get(runtimeId);
    if (existing) {
      if (existing.state === "removing") throw new ServiceError("runtime_busy", `runtime ${runtimeId} is closing`);
      return existing;
    }
    const slot: RuntimeSlot = {
      runtimeId,
      controller: new AbortController(),
      state: "opening",
      interests: 0,
      leases: new Set(),
      deleteData: false,
    };
    this.slots.set(runtimeId, slot);
    // Publish the open barrier and register interests/removal before invoking a reentrant factory.
    slot.ready = Promise.resolve().then(() => this.runOpen(slot, forRemoval));
    return slot;
  }

  private async runOpen(slot: RuntimeSlot, forRemoval: boolean): Promise<RuntimeHandle> {
    let handle: RuntimeHandle | null;
    try {
      handle = await this.options.openRuntime(slot.runtimeId, slot.controller.signal);
    } catch (error) {
      this.dropOpening(slot);
      throw error;
    }
    if (handle === null) {
      this.dropOpening(slot);
      throw new ServiceError("unknown_runtime", `runtime ${slot.runtimeId} is not available`);
    }
    if (forRemoval) {
      slot.handle = handle;
      return handle;
    }
    // A signal abort only discards the handle when nobody is still waiting. A waiter that arrived after
    // the previous last waiter left still receives this handle.
    if (slot.state !== "opening" || slot.interests === 0 || this.stopped) {
      slot.handle = handle;
      if (!slot.removal) void this.removeSlot(slot, false).catch((error: unknown) => this.report(error));
      throw new ServiceError(slot.state === "removing" || this.stopped ? "runtime_busy" : "connection_closed", `runtime ${slot.runtimeId} open was discarded`);
    }
    slot.handle = handle;
    slot.state = "open";
    try {
      slot.unwatch = handle.watchIdle?.(() => this.reclaimIfIdle(slot));
    } catch (error) {
      // The factory has handed us ownership even when installing the watcher fails. Keep the
      // slot unavailable until the handle has closed and released; never forget a live owner.
      void this.removeSlot(slot, false).catch((cause: unknown) => this.report(cause));
      throw error;
    }
    return handle;
  }

  /** Forget a failed open so a later request can try again. A removal in progress keeps the slot. */
  private dropOpening(slot: RuntimeSlot): void {
    if (this.slots.get(slot.runtimeId) !== slot || slot.state !== "opening") return;
    this.slots.delete(slot.runtimeId);
  }

  private closeMode(): "drain" | "abort" {
    return this.abortClose ? "abort" : "drain";
  }

  private settleLease(lease: LeaseState): Promise<void> {
    if (lease.settling) return lease.settling;
    // Publish before host release code runs, including a synchronous throw or reentrant cleanup.
    const settling = Promise.resolve().then(async () => {
      while (lease.admitted.size > 0) await Promise.allSettled([...lease.admitted]);
      if (!lease.released) {
        await lease.lease.release();
        lease.released = true;
      }
      lease.slot.leases.delete(lease);
      this.reclaimIfIdle(lease.slot);
    });
    lease.settling = settling;
    void settling.catch(() => {
      if (lease.settling === settling) lease.settling = undefined;
    });
    return settling;
  }

  private reclaimIfIdle(slot: RuntimeSlot): void {
    if (slot.state !== "open" || slot.leases.size > 0 || slot.interests > 0 || !slot.handle?.idle()) return;
    void this.removeSlot(slot, false).catch((error: unknown) => this.report(error));
  }

  private removeSlot(slot: RuntimeSlot, deleteData: boolean, abortOpening = true): Promise<void> {
    if (slot.removal) {
      if (this.stopped) slot.controller.abort();
      // A release already in progress has dropped the write right. Do not mark the slot for deletion
      // or report that this call removed the data.
      if (deleteData && slot.dropping === "release") {
        return Promise.reject(new Error(`runtime ${slot.runtimeId} is releasing ownership without deleting data`));
      }
      if (deleteData) slot.deleteData = true;
      return slot.removal;
    }
    if (deleteData) slot.deleteData = true;
    const removal = deferred<void>();
    slot.removal = removal.promise;
    slot.state = "removing";
    if (abortOpening) slot.controller.abort();
    for (const conn of [...this.connections]) {
      if (conn.lease?.slot !== slot) continue;
      void this.exclusive(conn, () => {
        if (conn.lease?.slot !== slot) return;
        const previous = conn.lease;
        this.publishAttachment(conn, null, null);
        if (previous) void this.settleLease(previous).catch((error: unknown) => this.report(error));
      });
    }
    void this.finishRemoval(slot).then(() => removal.resolve(), (error: unknown) => {
      if (slot.removal === removal.promise) slot.removal = undefined;
      removal.reject(error);
    });
    return removal.promise;
  }

  private async finishRemoval(slot: RuntimeSlot): Promise<void> {
    let readyError: unknown;
    let readyRejected = false;
    await slot.ready?.then(
      () => undefined,
      (error: unknown) => {
        readyRejected = true;
        readyError = error;
        return undefined;
      },
    );
    const errors: unknown[] = [];
    if (readyRejected && !slot.handle && !(readyError instanceof ServiceError && readyError.code === "unknown_runtime")) errors.push(readyError);
    // Removing forbids later acquires. A synchronous acquire that reentered removal registers
    // its orphan before the ready await above resumes, so this set includes every admitted lease.
    const releases = await Promise.allSettled([...slot.leases].map((lease) => this.settleLease(lease)));
    for (const result of releases) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    let closed = !slot.handle;
    if (slot.handle) {
      try {
        let work = this.closeHandle(slot, this.closeMode());
        for (;;) {
          const [settled] = await Promise.allSettled([work]);
          // An abort upgrade can add host shutdown work while the first drain is pending.
          // Wait for the newest barrier, including its failure, before giving up ownership.
          if (slot.closeOnce === work) {
            if (settled!.status === "rejected") throw settled!.reason;
            break;
          }
          work = slot.closeOnce!;
        }
        closed = true;
      } catch (error) {
        errors.push(error);
        slot.closeOnce = undefined;
        slot.closeMode = undefined;
      }
    }
    if (closed && slot.handle && (slot.handle.release || slot.handle.remove)) {
      try {
        await this.dropOwnership(slot);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      slot.unwatch?.();
      slot.unwatch = undefined;
    } catch (error) {
      errors.push(error);
    }
    const same = this.slots.get(slot.runtimeId) === slot;
    // A handle whose close failed must stay owned so a retry can close it. Without a handle there is nothing to retry.
    if (same && (errors.length === 0 || !slot.handle)) this.slots.delete(slot.runtimeId);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `runtime ${slot.runtimeId} cleanup failed`);
  }

  /** Close has succeeded. Delete data or release the write right, and do not start until `deleteData` is read. */
  private async dropOwnership(slot: RuntimeSlot): Promise<void> {
    const handle = slot.handle;
    if (!handle) return;
    if (slot.deleteData && handle.remove) {
      slot.dropping = "remove";
      await handle.remove();
      return;
    }
    if (handle.release) {
      slot.dropping = "release";
      await handle.release();
    }
  }

  private closeHandle(slot: RuntimeSlot, mode: "drain" | "abort"): Promise<void> {
    if (!slot.handle) return Promise.resolve();
    const previous = slot.closeOnce;
    // Host work has ended before ownership dropping starts. A late abort cannot restart host
    // cleanup after storage is closed or the write right is already being released/deleted.
    if (previous && (slot.dropping || slot.closeMode === "abort" || mode === "drain")) return previous;
    const closing = deferred<void>();
    const work = previous ? Promise.allSettled([previous, closing.promise]).then((settled) => {
      const errors = [...new Set(settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []))];
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `runtime ${slot.runtimeId} close failed`);
    }) : closing.promise;
    // Publish before invoking host code: it can synchronously reenter close and upgrade the mode.
    slot.closeOnce = work;
    slot.closeMode = mode;
    // An early abort may reject before admitted calls finish. Keep its error for finishRemoval,
    // while also handling it immediately so the shutdown cannot create an unhandled rejection.
    void work.catch(() => undefined);
    try {
      void Promise.resolve(slot.handle.close(mode)).then(() => closing.resolve(), closing.reject);
    } catch (error) {
      closing.reject(error);
    }
    return work;
  }

  private async shutdown(): Promise<void> {
    const removals = [...this.slots.values()].map((slot) => this.removeSlot(slot, false));
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
    const settled = await Promise.allSettled(removals);
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "server close failed");
  }

  /**
   * Serializes the updates of one connection so at most one sits in its send queue. Updates waiting for
   * their turn are bounded by `maxQueuedBytes` too; going over closes the connection.
   */
  private sendUpdate(conn: Conn, sink: Sink, update: JsonValue): Promise<boolean> {
    if (sink.closed || conn.state === "closed") return Promise.resolve(false);
    const frame = encodeServerMessage({ type: "service_update", subscriptionId: sink.id, update }, this.limits);
    if (conn.updateBytes + frame.byteLength > this.maxQueued) {
      this.drop(conn, new Error(`more than ${this.maxQueued} update bytes are waiting to be sent`));
      return Promise.resolve(false);
    }
    conn.updateBytes += frame.byteLength;
    const turn = conn.updates.then(async () => {
      try {
        if (!(await sink.ready) || sink.closed || conn.state === "closed") return false;
        await conn.writer.write(frame, () => overflow(this.maxQueued));
        return true;
      } catch {
        return false;
      } finally {
        conn.updateBytes -= frame.byteLength;
      }
    });
    conn.updates = turn;
    return turn;
  }

  private respond(conn: Conn, id: string, error: ErrorBody): boolean {
    return this.write(conn, { type: "response", id, ok: false, error }) !== null;
  }

  private write(conn: Conn, message: ServerMessage, quiet = false): Promise<void> | null {
    if (conn.state === "closed") return null;
    let frame: Uint8Array;
    try {
      frame = encodeServerMessage(message, this.limits);
    } catch (error) {
      if (!quiet) this.drop(conn, toError(error));
      else this.report(error);
      return null;
    }
    const sent = conn.writer.write(frame, () => overflow(this.maxQueued));
    void sent.catch(() => undefined);
    return sent;
  }

  /** Queues a final `hello_error`, stops the connection and closes the transport once it was sent or timed out. */
  private fatal(conn: Conn, error: ErrorBody): void {
    if (conn.state === "closed") return;
    this.stop(conn);
    let frame: Uint8Array | undefined;
    try {
      frame = encodeServerMessage({ type: "hello_error", error }, this.limits);
    } catch (encodeError) {
      this.report(encodeError);
    }
    const sent = frame ? conn.writer.write(frame, () => overflow(this.maxQueued)) : Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FINAL_FRAME_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const closing = Promise.race([sent.catch(() => undefined), timeout]).then(() => {
      clearTimeout(timer);
      conn.writer.fail(new Error("connection closed"));
      this.closeTransport(conn);
    });
    this.tasks.add(closing);
    void closing.finally(() => this.tasks.delete(closing));
  }

  private drop(conn: Conn, error?: Error): void {
    if (conn.state === "closed") return;
    this.stop(conn);
    if (error) this.report(error);
    conn.writer.fail(error ?? new Error("connection closed"));
    this.closeTransport(conn);
  }

  /** Ends routing for the connection: aborts calls, closes sinks and forgets the attachment without publishing. */
  private stop(conn: Conn): void {
    conn.state = "closed";
    clearTimeout(conn.timer);
    this.connections.delete(conn);
    const reason = new DOMException("connection closed", "AbortError");
    for (const active of conn.active.values()) active.controller.abort(reason);
    for (const sink of [...conn.sinks.values()]) sink.close();
    const lease = conn.lease;
    conn.attachment = null;
    conn.lease = null;
    if (lease) void this.settleLease(lease).catch((error: unknown) => this.report(error));
  }

  private closeTransport(conn: Conn): void {
    try {
      conn.transport.close();
    } catch (error) {
      this.report(error);
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => this.report(error));
    this.tasks.add(tracked);
    void tracked.finally(() => {
      this.tasks.delete(tracked);
    });
  }

  private errorFor(error: unknown, signal: AbortSignal): ErrorBody {
    if (error instanceof ServiceError && CODE.test(error.code) && error.code.length <= 64) return errorBody(error.code, error.message);
    if (signal.aborted) return errorBody("cancelled", "the request was cancelled");
    this.report(error);
    return errorBody("internal", "internal server error");
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(toError(error));
    } catch {
      // Diagnostics cannot change routing state.
    }
  }
}

interface SinkPort {
  send(update: JsonValue): Promise<boolean>;
  remove(): void;
}

class Sink implements SubscriptionSink {
  readonly id: string;
  readonly route: Route;
  readonly connectionId: string;
  private readonly port: SinkPort;
  private readonly controller = new AbortController();
  readonly ready: Promise<boolean>;
  private settleReady!: (active: boolean) => void;
  private state: "pending" | "active" | "closed" = "pending";

  constructor(connectionId: string, id: string, route: Route, port: SinkPort) {
    this.connectionId = connectionId;
    this.id = id;
    this.route = route;
    this.port = port;
    this.ready = new Promise((resolve) => { this.settleReady = resolve; });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get closed(): boolean {
    return this.state === "closed";
  }

  async send(update: JsonValue): Promise<boolean> {
    if (this.closed) return false;
    return this.port.send(update);
  }

  activate(): void {
    if (this.state !== "pending") return;
    this.state = "active";
    this.settleReady(true);
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.settleReady(false);
    this.port.remove();
    this.controller.abort();
  }
}

function closed(conn: Conn): boolean {
  return conn.state === "closed";
}

function isOpen(slot: RuntimeSlot): boolean {
  return slot.state === "open";
}

function overflow(max: number): Error {
  return new Error(`more than ${max} bytes are waiting to be sent`);
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function aborted(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Rejects when `signal` aborts without aborting `work`. Settles once and always removes the listener. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
