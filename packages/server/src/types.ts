import type { JsonValue, Route, RuntimeRoute, ServerRoute } from "@amazme/protocol";

/** An accepted, ordered byte stream. The server owns it from `accept()` until it calls `close()`. */
export interface ByteConnection {
  /** Sends bytes in call order. Resolution is backpressure: the server waits before sending more. */
  send(chunk: Uint8Array): Promise<void>;
  /** Releases the stream. Must tolerate repeated calls; no handler is expected afterwards. */
  close(): void;
}

export interface ByteConnectionHandlers {
  onData(chunk: Uint8Array): void;
  /** The peer ended the stream. Terminal. */
  onClose(): void;
  /** The stream failed. Terminal. */
  onError(error: Error): void;
}

/**
 * Delivers `service_update` envelopes for one subscription ID of one connection. Updates wait until the
 * response of the call that opened the sink was accepted by the transport, and stop when the sink, its route or the connection closes.
 */
export interface SubscriptionSink {
  readonly id: string;
  readonly route: Route;
  readonly connectionId: string;
  /** Resolves `true` when the opening call's successful response was accepted by the transport, or `false` if the sink closes first. */
  readonly ready: Promise<boolean>;
  /** Aborts when the sink closes for any reason. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  /**
   * Resolves `true` once the transport accepted the update and `false` if the sink closed first.
   * Updates of one connection are sent one at a time, so awaiting this is backpressure. Updates waiting
   * for their turn count against `maxQueuedBytes`; going over closes the connection.
   * Rejects only when the update is not strict JSON or exceeds the frame limit. Nothing is sent and the sink
   * stays open, so the service can still send a smaller notice or close it.
   */
  send(update: JsonValue): Promise<boolean>;
  close(): void;
}

export interface CallContext {
  readonly connectionId: string;
  readonly route: Route;
  /** Aborts on `cancel`, disconnect or server close. It ends this call only, never business work by itself. */
  readonly signal: AbortSignal;
  /**
   * Opens a sink under this call's route while the call runs. Throws a `ServiceError` after the call settled,
   * for a duplicate ID, or at the subscription limit.
   */
  openSubscription(subscriptionId: string): SubscriptionSink;
  /** A sink this connection opened under the same route. */
  subscription(subscriptionId: string): SubscriptionSink | undefined;
}

export interface RuntimeCallContext extends CallContext {
  readonly route: RuntimeRoute;
}

/**
 * One connection's right to call a runtime. `release` is idempotent and is invoked by the server only after
 * every call admitted on this lease has finished. It does not cancel that work.
 */
export interface AttachmentLease {
  readonly service: RuntimeService;
  release(): void | Promise<void>;
}

/**
 * An opened runtime owned by the server's lifecycle. The server acquires one lease per attachment.
 * `close` stops host work and closes storage. It does not delete data.
 * When `release` or `remove` is present, `close` keeps exclusive ownership: after it succeeds the server
 * calls `remove` to delete data, or `release` to drop ownership without deleting. When both are absent,
 * `close` is the whole shutdown.
 */
export interface RuntimeHandle {
  /** Grants one attachment. It either returns a lease or leaves no extra hold. */
  acquire(): AttachmentLease;
  /**
   * Drain waits for admitted host work. Abort asks the host to stop.
   * Repeated calls share one operation; a later abort upgrades a drain. A later drain does not undo an abort.
   * Must be idempotent: a failed shutdown can be called again.
   */
  close(mode: "drain" | "abort"): Promise<void>;
  /** True when the host has no producer or storage work. A persisted retry wait is not producer work. Attachments are counted by the server. */
  idle(): boolean;
  /** Fires when `idle()` may have changed. It is not required to fire for the state at registration. The return value unsubscribes. */
  watchIdle?(listener: () => void): () => void;
  /** Releases exclusive ownership without deleting data. Idempotent. */
  release?(): Promise<void>;
  /** Deletes host data and then releases exclusive ownership. Idempotent. Must not drop ownership before the delete finishes. */
  remove?(): Promise<void>;
}

/** Controlled routing capability for server-route calls. Business results should not carry the route. */
export interface ServerCallContext extends CallContext {
  readonly route: ServerRoute;
  readonly attachment: RuntimeRoute | null;
  /**
   * Attaches this connection to a runtime the host's `openRuntime` allows. Queues the `attachment` envelope
   * before this call's response. Attaching the current runtime again keeps its attachment and does not take
   * another lease. A failed open leaves the previous attachment in place. Only valid while the call runs;
   * afterwards it throws `call_settled`.
   */
  attach(runtimeId: string): Promise<RuntimeRoute>;
  /** Clears the attachment, closes its subscriptions and queues `attachment: null`. The lease is released after this call's response. */
  detach(): Promise<void>;
}

export type MaybePromise<T> = T | Promise<T>;

/** Handles calls addressed to the logical server, such as attachment management. */
export interface ServerService {
  call(call: JsonValue, context: ServerCallContext): MaybePromise<JsonValue | undefined>;
}

/** Handles calls addressed to one registered runtime through a current attachment. */
export interface RuntimeService {
  call(call: JsonValue, context: RuntimeCallContext): MaybePromise<JsonValue | undefined>;
}
