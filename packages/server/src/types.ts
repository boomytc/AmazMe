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
 * response of the call that opened the sink was queued, and stop when the sink, its route or the connection closes.
 */
export interface SubscriptionSink {
  readonly id: string;
  readonly route: Route;
  readonly connectionId: string;
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

/** Controlled routing capability for server-route calls. Business results should not carry the route. */
export interface ServerCallContext extends CallContext {
  readonly route: ServerRoute;
  readonly attachment: RuntimeRoute | null;
  /**
   * Installs a fresh attachment of a registered runtime on this connection and queues the `attachment`
   * envelope before this call's response. Attaching the current runtime again keeps its attachment.
   * Only valid while the call runs; afterwards it throws `call_settled`.
   */
  attach(runtimeId: string): RuntimeRoute;
  /** Clears the attachment, closes its subscriptions and queues `attachment: null`. Only valid while the call runs. */
  detach(): void;
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
