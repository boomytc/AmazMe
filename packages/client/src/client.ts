import {
  assertJsonValue,
  encodeClientMessage,
  isRuntimeRoute,
  PROTOCOL_VERSION,
  resolveLimits,
  sameRoute,
  ServerMessageDecoder,
  type ClientMessage,
  type JsonValue,
  type ProtocolLimits,
  type ResponseEnvelope,
  type Route,
  type RuntimeRoute,
  type ServerHello,
  type ServerMessage,
  type ServerRoute,
} from "@amazme/protocol";
import { ClientError, RemoteError, toError } from "./errors.ts";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
import { FrameWriter } from "@amazme/protocol/writer";

export interface ClientOptions {
  /** The logical server identity the handshake must report. Unrelated to the physical address. */
  serverId: string;
  transport: ByteTransportFactory;
  limits?: Partial<ProtocolLimits>;
  /** Requests awaiting a response, including locally cancelled ones the server has not answered. Default 128. */
  maxPendingRequests?: number;
  /** Open subscriptions on one connection. Default 32. */
  maxSubscriptions?: number;
  /** Updates held before `start()` or during reentrant callbacks. Going over fails the connection. Default 64. */
  maxBufferedUpdates?: number;
  /** Encoded bytes waiting for the transport. Going over fails the connection. Default two frames. */
  maxQueuedBytes?: number;
  handshakeTimeoutMs?: number;
  /** Receives errors thrown by state, attachment and update listeners. Its own errors are ignored. */
  onListenerError?: (error: Error) => void;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface RequestOptions {
  /** Aborting rejects locally and sends `cancel`. It cancels this RPC, not any business operation. */
  signal?: AbortSignal;
}

export interface SubscribeOptions extends RequestOptions {
  /** The call that closes this subscription on the service. `close()` sends it while the route is current. */
  unsubscribe?: (subscriptionId: string) => JsonValue;
}

export type SubscriptionEnd =
  | { reason: "closed" }
  | { reason: "detached" }
  | { reason: "disconnected"; error: Error };

export interface Subscription {
  readonly id: string;
  readonly route: Route;
  /** The result of the subscribe call. Install it before calling `start()`. */
  readonly initial: JsonValue | undefined;
  /** Delivers the updates held since the subscribe call, in order, and then live updates. */
  start(): void;
  /** Stops delivery at once and resolves after the unsubscribe call, if any, settled. Repeatable. */
  close(): Promise<void>;
  /** Resolves once; never rejects. */
  readonly ended: Promise<SubscriptionEnd>;
}

interface Pending {
  settled: boolean;
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
}

interface Sub {
  readonly id: string;
  readonly route: Route;
  readonly onUpdate: (update: JsonValue) => void;
  readonly buffer: JsonValue[];
  started: boolean;
  delivering: boolean;
  end?: SubscriptionEnd;
  finish(end: SubscriptionEnd): void;
}

interface Live {
  readonly id: number;
  state: "connecting" | "connected" | "closed";
  readonly decoder: ServerMessageDecoder;
  readonly pending: Map<string, Pending>;
  readonly subscriptions: Map<string, Sub>;
  readonly handshake: { resolve(hello: ServerHello): void; reject(error: Error): void };
  transport?: ByteTransport;
  writer?: FrameWriter;
  timer?: ReturnType<typeof setTimeout>;
  attachment: RuntimeRoute | null;
  requests: number;
  subscriptionsOpened: number;
  earlyData: boolean;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Speaks the protocol over one connection at a time. Never reconnects or resends: after a disconnect,
 * call `connect()` again, attach again, and repeat only the operations known to be safe.
 */
export class Client {
  private readonly options: ClientOptions;
  private readonly limits: ProtocolLimits;
  private readonly maxPending: number;
  private readonly maxSubscriptions: number;
  private readonly maxBuffered: number;
  private readonly maxQueued: number;
  private readonly stateListeners = new Set<(state: ConnectionState, error?: Error) => void>();
  private readonly attachmentListeners = new Set<(attachment: RuntimeRoute | null) => void>();
  private live: Live | undefined;
  private connectionsOpened = 0;
  private disposed = false;

  constructor(options: ClientOptions) {
    this.options = options;
    this.limits = resolveLimits(options.limits);
    this.maxPending = positive("maxPendingRequests", options.maxPendingRequests ?? 128);
    this.maxSubscriptions = positive("maxSubscriptions", options.maxSubscriptions ?? 32);
    this.maxBuffered = positive("maxBufferedUpdates", options.maxBufferedUpdates ?? 64);
    this.maxQueued = positive("maxQueuedBytes", options.maxQueuedBytes ?? 2 * (this.limits.maxFrameBytes + 4));
    const timeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (positive("handshakeTimeoutMs", timeout) > MAX_TIMER_MS) throw new RangeError(`handshakeTimeoutMs must be at most ${MAX_TIMER_MS}`);
  }

  get serverId(): string {
    return this.options.serverId;
  }

  get state(): ConnectionState {
    return this.live?.state === "connecting" ? "connecting" : this.live?.state === "connected" ? "connected" : "disconnected";
  }

  /** The runtime route the server attached to the current connection, or `null`. */
  get attachment(): RuntimeRoute | null {
    const attachment = this.live?.attachment;
    return attachment ? { ...attachment } : null;
  }

  serverRoute(): ServerRoute {
    return { serverId: this.options.serverId };
  }

  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onAttachmentChange(listener: (attachment: RuntimeRoute | null) => void): () => void {
    this.attachmentListeners.add(listener);
    return () => this.attachmentListeners.delete(listener);
  }

  /** Opens a fresh transport and completes the handshake. Requests are refused until it resolves. */
  connect(): Promise<ServerHello> {
    if (this.disposed) return Promise.reject(new ClientError("disposed", "client is disposed"));
    if (this.live) return Promise.reject(new ClientError("already_connected", `client is ${this.live.state}`));
    let handshake!: Live["handshake"];
    const hello = new Promise<ServerHello>((resolve, reject) => { handshake = { resolve, reject }; });
    const live: Live = {
      id: ++this.connectionsOpened,
      state: "connecting",
      decoder: new ServerMessageDecoder(this.limits),
      pending: new Map(),
      subscriptions: new Map(),
      handshake,
      attachment: null,
      requests: 0,
      subscriptionsOpened: 0,
      earlyData: false,
    };
    this.live = live;
    live.timer = setTimeout(
      () => this.fail(live, new ClientError("handshake_timeout", "server hello did not arrive in time")),
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    this.emitState(live, "connecting");
    void this.open(live);
    return hello;
  }

  /** Ends the current connection: pending requests reject, subscriptions end, the attachment clears. */
  disconnect(reason = "client disconnected"): Promise<void> {
    const live = this.live;
    if (live) this.fail(live, new ClientError("disconnected", reason));
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    const live = this.live;
    if (live) this.fail(live, new ClientError("disposed", "client is disposed"));
    this.stateListeners.clear();
    this.attachmentListeners.clear();
    return Promise.resolve();
  }

  request(route: Route, call: JsonValue, options: RequestOptions = {}): Promise<JsonValue | undefined> {
    return this.send(route, call, options);
  }

  private send(route: Route, call: JsonValue, options: RequestOptions, onLateSuccess?: () => void): Promise<JsonValue | undefined> {
    const live = this.connected();
    if (live instanceof Error) return Promise.reject(live);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (live.pending.size >= this.maxPending) {
      return Promise.reject(new ClientError("too_many_requests", `more than ${this.maxPending} pending requests`));
    }
    const id = `r${++live.requests}`;
    let frame: Uint8Array;
    try {
      frame = encodeClientMessage({ type: "request", id, route, call }, this.limits);
    } catch (error) {
      return Promise.reject(error);
    }
    route = { ...route };
    return new Promise<JsonValue | undefined>((resolve, reject) => {
      const onAbort = () => {
        if (pending.settled) return;
        pending.reject(abortReason(signal!));
        if (this.live === live && live.state === "connected") this.write(live, { type: "cancel", id, route });
      };
      const pending: Pending = {
        settled: false,
        resolve: (value) => {
          if (settle()) resolve(value);
          else onLateSuccess?.();
        },
        reject: (error) => { if (settle()) reject(error); },
      };
      const settle = () => {
        if (pending.settled) return false;
        pending.settled = true;
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      live.pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.writeFrame(live, frame);
    });
  }

  /**
   * Registers the subscription before sending `call(subscriptionId)`, so updates that arrive before the
   * result are held. They stay held until `start()`, letting the caller install `initial` first.
   */
  async subscribe(
    route: Route,
    call: (subscriptionId: string) => JsonValue,
    onUpdate: (update: JsonValue) => void,
    options: SubscribeOptions = {},
  ): Promise<Subscription> {
    const live = this.connected();
    if (live instanceof Error) throw live;
    if (live.subscriptions.size >= this.maxSubscriptions) {
      throw new ClientError("too_many_subscriptions", `more than ${this.maxSubscriptions} subscriptions`);
    }
    assertJsonValue(route, this.limits);
    route = { ...route };
    const id = `s${++live.subscriptionsOpened}`;
    let finish!: (end: SubscriptionEnd) => void;
    const ended = new Promise<SubscriptionEnd>((resolve) => { finish = resolve; });
    const sub: Sub = { id, route, onUpdate, buffer: [], started: false, delivering: false, finish: (end) => finish(end) };
    live.subscriptions.set(id, sub);
    const unsubscribe = options.unsubscribe;
    const sendUnsubscribe = async (): Promise<void> => {
      if (!unsubscribe || this.live !== live || live.state !== "connected") return;
      let call: JsonValue;
      try {
        call = unsubscribe(id);
      } catch (error) {
        this.reportListenerError(error);
        return;
      }
      await this.send(route, call, {}).then(() => undefined, () => undefined);
    };
    const lateSuccess = unsubscribe ? () => void sendUnsubscribe() : undefined;
    let initial: JsonValue | undefined;
    try {
      initial = await this.send(route, call(id), options, lateSuccess);
    } catch (error) {
      this.endSubscription(live, sub, { reason: "closed" });
      throw error;
    }
    if (sub.end) throw sub.end.reason === "disconnected" ? sub.end.error : new ClientError("detached", "subscription route was detached");
    let closing: Promise<void> | undefined;
    return {
      id,
      get route() { return { ...route }; },
      initial,
      ended,
      start: () => {
        if (sub.started || sub.end) return;
        sub.started = true;
        this.drain(sub);
      },
      close: () => {
        closing ??= (async () => {
          const wasOpen = !sub.end;
          this.endSubscription(live, sub, { reason: "closed" });
          const current = !isRuntimeRoute(route) || sameRoute(route, live.attachment);
          if (wasOpen && current) await sendUnsubscribe();
        })();
        return closing;
      },
    };
  }

  private async open(live: Live): Promise<void> {
    if (this.live !== live) return;
    let transport: ByteTransport;
    try {
      transport = await this.options.transport(this.handlers(live));
    } catch (error) {
      this.fail(live, new ClientError("transport_error", `transport failed to open: ${toError(error).message}`, { cause: error }));
      return;
    }
    if (this.live !== live || live.state === "closed") {
      this.closeTransport(transport);
      return;
    }
    live.transport = transport;
    const send = async (chunk: Uint8Array) => {
      try {
        await transport.send(chunk);
      } catch (cause) {
        throw new ClientError("transport_error", `transport failed to send: ${toError(cause).message}`, { cause });
      }
    };
    live.writer = new FrameWriter(send, this.maxQueued, (error) => this.fail(live, error));
    this.write(live, { type: "hello", version: PROTOCOL_VERSION });
  }

  private handlers(live: Live): ByteTransportHandlers {
    return {
      onData: (chunk) => {
        if (this.live !== live) return;
        if (!live.writer && chunk.byteLength > 0) live.earlyData = true;
        let messages: ServerMessage[];
        try {
          messages = live.decoder.push(chunk);
        } catch (error) {
          this.fail(live, new ClientError("protocol_error", toError(error).message, { cause: error }));
          return;
        }
        for (const message of messages) {
          if (this.live !== live) return;
          try {
            this.handle(live, message);
          } catch (error) {
            this.reportListenerError(error);
            this.fail(live, new ClientError("protocol_error", `handling ${message.type} failed: ${toError(error).message}`, { cause: error }));
            return;
          }
        }
      },
      onClose: () => {
        if (this.live !== live) return;
        let error = new ClientError("disconnected", "server closed the connection");
        try {
          live.decoder.end();
        } catch (cause) {
          error = new ClientError("protocol_error", toError(cause).message, { cause });
        }
        this.fail(live, error);
      },
      onError: (cause) => {
        if (this.live !== live) return;
        this.fail(live, new ClientError("transport_error", cause.message, { cause }));
      },
    };
  }

  private handle(live: Live, message: ServerMessage): void {
    if (message.type === "hello_error") {
      this.fail(live, new RemoteError(message.error.code, message.error.message));
      return;
    }
    if (live.state === "connecting") {
      if (message.type !== "hello") {
        this.fail(live, new ClientError("protocol_error", `expected server hello, received ${message.type}`));
        return;
      }
      if (live.earlyData) {
        this.fail(live, new ClientError("protocol_error", "server hello arrived before the client hello could be sent"));
        return;
      }
      if (message.serverId !== this.options.serverId) {
        this.fail(live, new ClientError("server_mismatch", `connected to server ${message.serverId}, expected ${this.options.serverId}`));
        return;
      }
      live.state = "connected";
      clearTimeout(live.timer);
      this.emitState(live, "connected");
      if (this.live === live) live.handshake.resolve(message);
      return;
    }
    if (message.type === "hello") {
      this.fail(live, new ClientError("protocol_error", "unexpected server hello"));
      return;
    }
    if (message.type === "response") {
      const pending = live.pending.get(message.id);
      if (!pending) {
        this.fail(live, new ClientError("protocol_error", `response ${message.id} has no request`));
        return;
      }
      live.pending.delete(message.id);
      settleResponse(pending, message);
      return;
    }
    if (message.type === "service_update") {
      const sub = live.subscriptions.get(message.subscriptionId);
      if (!sub) return;
      if (sub.buffer.length >= this.maxBuffered) {
        this.fail(live, new ClientError("subscription_overflow", `subscription ${sub.id} held more than ${this.maxBuffered} updates`));
        return;
      }
      sub.buffer.push(message.update);
      if (sub.started) this.drain(sub);
      return;
    }
    if (message.attachment && message.attachment.serverId !== this.options.serverId) {
      this.fail(live, new ClientError("protocol_error", "attachment belongs to another server"));
      return;
    }
    this.setAttachment(live, message.attachment);
  }

  private setAttachment(live: Live, attachment: RuntimeRoute | null): void {
    if (sameRoute(live.attachment, attachment)) return;
    live.attachment = attachment;
    for (const sub of [...live.subscriptions.values()]) {
      if (isRuntimeRoute(sub.route) && !sameRoute(sub.route, attachment)) this.endSubscription(live, sub, { reason: "detached" });
    }
    for (const listener of [...this.attachmentListeners]) {
      if (live.id !== this.connectionsOpened || live.attachment !== attachment) return;
      try {
        listener(attachment ? { ...attachment } : null);
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  private fail(live: Live, error: Error): void {
    if (live.state === "closed") return;
    const wasConnected = live.state === "connected";
    live.state = "closed";
    if (this.live === live) this.live = undefined;
    clearTimeout(live.timer);
    live.handshake.reject(error);
    for (const pending of live.pending.values()) pending.reject(error);
    live.pending.clear();
    for (const sub of [...live.subscriptions.values()]) this.endSubscription(live, sub, { reason: "disconnected", error });
    live.writer?.fail(error);
    if (live.transport) this.closeTransport(live.transport);
    if (wasConnected) this.setAttachment(live, null);
    this.emitState(live, "disconnected", error);
  }

  private closeTransport(transport: ByteTransport): void {
    try {
      transport.close();
    } catch (error) {
      this.reportListenerError(error);
    }
  }

  private endSubscription(live: Live, sub: Sub, end: SubscriptionEnd): void {
    if (sub.end) return;
    sub.end = end;
    sub.buffer.length = 0;
    if (live.subscriptions.get(sub.id) === sub) live.subscriptions.delete(sub.id);
    sub.finish(end);
  }

  private drain(sub: Sub): void {
    if (sub.delivering) return;
    sub.delivering = true;
    try {
      while (!sub.end && sub.buffer.length > 0) {
        const update = sub.buffer.shift()!;
        try {
          sub.onUpdate(update);
        } catch (error) {
          this.reportListenerError(error);
        }
      }
    } finally {
      sub.delivering = false;
    }
  }

  private connected(): Live | Error {
    if (this.disposed) return new ClientError("disposed", "client is disposed");
    const live = this.live;
    if (!live || live.state !== "connected") return new ClientError("not_connected", "client is not connected");
    return live;
  }

  private write(live: Live, message: ClientMessage): void {
    let frame: Uint8Array;
    try {
      frame = encodeClientMessage(message, this.limits);
    } catch (error) {
      this.fail(live, new ClientError("protocol_error", toError(error).message, { cause: error }));
      return;
    }
    this.writeFrame(live, frame);
  }

  private writeFrame(live: Live, frame: Uint8Array): void {
    const writer = live.writer;
    if (!writer) {
      this.fail(live, new ClientError("protocol_error", "client transport is not initialized"));
      return;
    }
    void writer.write(frame, () => new ClientError("send_overflow", `more than ${this.maxQueued} bytes are waiting to be sent`)).catch(() => undefined);
  }

  private emitState(live: Live, state: ConnectionState, error?: Error): void {
    for (const listener of [...this.stateListeners]) {
      if (live.id !== this.connectionsOpened || this.state !== state) return;
      try {
        listener(state, error);
      } catch (listenerError) {
        this.reportListenerError(listenerError);
      }
    }
  }

  private reportListenerError(error: unknown): void {
    try {
      this.options.onListenerError?.(toError(error));
    } catch {
      // Diagnostics cannot change connection state.
    }
  }
}

function settleResponse(pending: Pending, message: ResponseEnvelope): void {
  if (message.ok) pending.resolve(message.result);
  else pending.reject(new RemoteError(message.error.code, message.error.message));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted", "AbortError");
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
