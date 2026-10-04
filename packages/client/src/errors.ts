export type ClientErrorCode =
  | "not_connected"
  | "already_connected"
  | "disconnected"
  | "detached"
  | "disposed"
  | "server_mismatch"
  | "handshake_timeout"
  | "protocol_error"
  | "transport_error"
  | "too_many_requests"
  | "too_many_subscriptions"
  | "subscription_overflow"
  | "send_overflow";

/** A local failure of the client or its connection. */
export class ClientError extends Error {
  readonly code: ClientErrorCode;

  constructor(code: ClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClientError";
    this.code = code;
  }
}

/** An error body sent by the server: a failed response, or a terminal `hello_error`. */
export class RemoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
  }
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
