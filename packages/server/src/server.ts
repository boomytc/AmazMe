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
  ByteConnection,
  ByteConnectionHandlers,
  CallContext,
  RuntimeService,
  ServerCallContext,
  ServerService,
  SubscriptionSink,
} from "./types.ts";
import { FrameWriter } from "./writer.ts";

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
}

interface Conn {
  readonly id: string;
  readonly transport: ByteConnection;
  readonly decoder: ClientMessageDecoder;
  readonly writer: FrameWriter;
  readonly active: Map<string, Active>;
  readonly sinks: Map<string, Sink>;
  readonly tasks: Set<Promise<void>>;
  state: "awaiting_hello" | "ready" | "closed";
  attachment: RuntimeRoute | null;
  timer?: ReturnType<typeof setTimeout>;
  updates: Promise<unknown>;
  updateBytes: number;
}

/**
 * Routes protocol envelopes of accepted connections to the server service and to explicitly registered
 * runtimes. It interprets no business payload. Closing the server releases connections only; the host keeps
 * owning its runtimes and whatever they wrap.
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
  private readonly runtimes = new Map<string, { readonly service: RuntimeService }>();
  private readonly connections = new Set<Conn>();
  private readonly tasks = new Set<Promise<void>>();
  private sequence = 0;
  private closing: Promise<void> | undefined;

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
    return this.closing !== undefined;
  }

  /**
   * Makes a runtime routable under `runtimeId`. The returned function unregisters it and detaches every
   * connection attached to it; calls already admitted keep running.
   */
  registerRuntime(runtimeId: string, service: RuntimeService): () => void {
    if (this.closing) throw new Error("server is closed");
    encodeServerMessage({ type: "attachment", attachment: { serverId: this.serverId, runtimeId, attachmentId: "probe" } }, this.limits);
    if (this.runtimes.has(runtimeId)) throw new Error(`runtime ${runtimeId} is already registered`);
    const registration = { service };
    this.runtimes.set(runtimeId, registration);
    return () => {
      if (this.runtimes.get(runtimeId) !== registration) return;
      this.runtimes.delete(runtimeId);
      for (const conn of this.connections) {
        if (conn.attachment?.runtimeId === runtimeId) this.setAttachment(conn, null);
      }
    };
  }

  accept(transport: ByteConnection): ByteConnectionHandlers {
    const conn: Conn = {
      id: `c${++this.sequence}`,
      transport,
      decoder: new ClientMessageDecoder(this.limits),
      writer: new FrameWriter((chunk) => transport.send(chunk), this.maxQueued, (error) => this.drop(conn, error)),
      active: new Map(),
      sinks: new Map(),
      tasks: new Set(),
      state: "awaiting_hello",
      attachment: null,
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
    if (this.closing) {
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
   * Stops accepting, closes every connection, aborts their calls and waits until those calls settled.
   * Repeated calls return the same promise. Registered runtimes are not closed.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const conn of [...this.connections]) this.drop(conn);
      while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
    })();
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
    let invoke: (context: CallContext) => ReturnType<ServerService["call"]>;
    if (isRuntimeRoute(route)) {
      const attached = conn.attachment;
      const runtime = this.runtimes.get(route.runtimeId);
      if (!attached || attached.runtimeId !== route.runtimeId || !runtime) {
        this.respond(conn, request.id, errorBody("not_attached", `runtime ${route.runtimeId} is not attached to this connection`));
        return;
      }
      if (attached.attachmentId !== route.attachmentId) {
        this.respond(conn, request.id, errorBody("stale_attachment", "the attachment was replaced or released"));
        return;
      }
      invoke = (context) => runtime.service.call(request.call, context as Parameters<RuntimeService["call"]>[1]);
    } else {
      invoke = (context) => this.options.service.call(request.call, context as ServerCallContext);
    }
    const controller = new AbortController();
    conn.active.set(request.id, { controller, route });
    const opened: Opened = { sinks: [], settled: false };
    const context = this.context(conn, route, controller.signal, opened);
    const task = (async () => {
      let response: ResponseEnvelope;
      try {
        const result = await invoke(context);
        response = result === undefined ? { type: "response", id: request.id, ok: true } : { type: "response", id: request.id, ok: true, result };
      } catch (error) {
        response = { type: "response", id: request.id, ok: false, error: this.errorFor(error, controller.signal) };
      }
      opened.settled = true;
      if (conn.active.get(request.id)?.controller === controller) conn.active.delete(request.id);
      if (conn.state === "closed") {
        for (const sink of opened.sinks) sink.close();
        return;
      }
      let succeeded = response.ok;
      if (!this.write(conn, response, true)) {
        succeeded = false;
        if (response.ok) this.respond(conn, request.id, errorBody("internal", "the result could not be encoded"));
      }
      for (const sink of opened.sinks) {
        if (succeeded) sink.activate();
        else sink.close();
      }
    })();
    this.track(conn, task);
  }

  private context(conn: Conn, route: Route, signal: AbortSignal, opened: Opened): CallContext | ServerCallContext {
    const base: CallContext = {
      connectionId: conn.id,
      route,
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
      attach(runtimeId: string): RuntimeRoute {
        if (opened.settled) throw new ServiceError("call_settled", "attachment changes only while their call runs");
        if (conn.state === "closed" || server.closing) throw new ServiceError("connection_closed", "the connection is closed");
        if (!server.runtimes.has(runtimeId)) throw new ServiceError("unknown_runtime", `runtime ${runtimeId} is not registered`);
        if (conn.attachment?.runtimeId !== runtimeId) {
          server.setAttachment(conn, { serverId: server.serverId, runtimeId, attachmentId: globalThis.crypto.randomUUID() });
        }
        const attached = conn.attachment;
        if (closed(conn) || !attached) throw new ServiceError("connection_closed", "the connection closed while attaching");
        return { ...attached };
      },
      detach(): void {
        if (opened.settled) throw new ServiceError("call_settled", "attachment changes only while their call runs");
        if (conn.state !== "closed" && conn.attachment) server.setAttachment(conn, null);
      },
    } satisfies ServerCallContext;
  }

  private setAttachment(conn: Conn, attachment: RuntimeRoute | null): void {
    for (const sink of [...conn.sinks.values()]) {
      if (isRuntimeRoute(sink.route) && !sameRoute(sink.route, attachment)) sink.close();
    }
    conn.attachment = attachment;
    this.write(conn, { type: "attachment", attachment });
  }

  /**
   * Serializes the updates of one connection so at most one sits in its send queue. Updates waiting for
   * their turn are bounded by `maxQueuedBytes` too; going over closes the connection.
   */
  private sendUpdate(conn: Conn, sink: Sink, update: JsonValue): Promise<boolean> {
    const frame = encodeServerMessage({ type: "service_update", subscriptionId: sink.id, update }, this.limits);
    if (conn.state === "closed") return Promise.resolve(false);
    if (conn.updateBytes + frame.byteLength > this.maxQueued) {
      this.drop(conn, new Error(`more than ${this.maxQueued} update bytes are waiting to be sent`));
      return Promise.resolve(false);
    }
    conn.updateBytes += frame.byteLength;
    const turn = conn.updates.then(async () => {
      try {
        if (sink.closed || conn.state === "closed") return false;
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
    return this.write(conn, { type: "response", id, ok: false, error });
  }

  private write(conn: Conn, message: ServerMessage, quiet = false): boolean {
    if (conn.state === "closed") return false;
    let frame: Uint8Array;
    try {
      frame = encodeServerMessage(message, this.limits);
    } catch (error) {
      if (!quiet) this.drop(conn, toError(error));
      else this.report(error);
      return false;
    }
    void conn.writer.write(frame, () => overflow(this.maxQueued)).catch(() => undefined);
    return true;
  }

  /** Queues a final `hello_error`, stops the connection and closes the transport once it was sent or timed out. */
  private fatal(conn: Conn, error: ErrorBody): void {
    if (conn.state === "closed") return;
    let frame: Uint8Array | undefined;
    try {
      frame = encodeServerMessage({ type: "hello_error", error }, this.limits);
    } catch (encodeError) {
      this.report(encodeError);
    }
    const sent = frame ? conn.writer.write(frame, () => overflow(this.maxQueued)) : Promise.resolve();
    this.stop(conn);
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
    if (error) this.report(error);
    this.stop(conn);
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
    conn.attachment = null;
  }

  private closeTransport(conn: Conn): void {
    try {
      conn.transport.close();
    } catch (error) {
      this.report(error);
    }
  }

  private track(conn: Conn, task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => this.report(error));
    conn.tasks.add(tracked);
    this.tasks.add(tracked);
    void tracked.finally(() => {
      conn.tasks.delete(tracked);
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
  private readonly ready: Promise<boolean>;
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
    if (!(await this.ready) || this.closed) return false;
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

function overflow(max: number): Error {
  return new Error(`more than ${max} bytes are waiting to be sent`);
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
