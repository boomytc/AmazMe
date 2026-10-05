/**
 * Model-request idle deadline and the single retry wait.
 * `@amazme/ai` only marks `retryable`. This module is the only resend policy.
 * The delay is computed here and stored as `notBefore`. It is not `Date.now() + 10`.
 * A failed assistant's `retryAfterMs` can only lengthen that wait.
 * Tool execution has its own limit and does not use this deadline.
 * The deadline is idle time since the last received frame. There is no wall-clock cap.
 */

export interface RetryWait {
  /** First retry waits this long. Later retries double it, then cap at `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RequestDeadline {
  signal: AbortSignal;
  /** True only when this deadline fired and the caller signal did not. */
  timedOut(): boolean;
  /** Restart the idle timer. A received frame or chunk calls this. */
  touch(): void;
  dispose(): void;
}

export interface DeadlineFacts {
  timedOut: boolean;
  cancelRequested: boolean;
  /** Persisted assistant output frames. A terminal stop frame does not count. */
  contentFrames: number;
}

export type DeadlineAction =
  | { kind: "unchanged" }
  | { kind: "retryable_timeout" }
  | { kind: "interrupted" };

/** Idle time with no received frame before one model request is cut off. Not a wall-clock cap. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRY_WAIT: RetryWait = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export function resolveRequestPolicy(input: {
  requestTimeoutMs?: number;
  retry?: RetryWait;
}): { requestTimeoutMs: number; retry: RetryWait } {
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retry = input.retry ?? DEFAULT_RETRY_WAIT;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("requestTimeoutMs must be a positive integer");
  }
  if (
    !Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0
    || !Number.isSafeInteger(retry.maxDelayMs) || retry.maxDelayMs < 0
  ) {
    throw new Error("retry delay must be a non-negative integer");
  }
  return {
    requestTimeoutMs,
    retry: { baseDelayMs: retry.baseDelayMs, maxDelayMs: retry.maxDelayMs },
  };
}

/** Fail closed when a stored lane config has no deadline. There is no fallback delay. */
export function storedRequestPolicy(config: {
  requestTimeoutMs?: number;
  retry?: RetryWait;
}): { requestTimeoutMs: number; retry: RetryWait } {
  if (config.requestTimeoutMs === undefined || config.retry === undefined) {
    throw new Error("lane config has no request deadline");
  }
  return resolveRequestPolicy(config);
}

/** Delay for a 1-based retry attempt: `baseDelayMs * 2^(attempt-1)`, capped. */
export function retryDelayMs(policy: RetryWait, attempt: number): number {
  const step = Math.max(0, Math.floor(attempt) - 1);
  const scaled = policy.baseDelayMs * 2 ** step;
  const safe = Number.isFinite(scaled) ? scaled : policy.maxDelayMs;
  return Math.min(safe, policy.maxDelayMs);
}

/**
 * Milliseconds stored in `retry_wait.notBefore` as `now +` this value.
 * The strategy backoff is `retryDelayMs`. When the failed assistant carries `retryAfterMs`,
 * the wait is the longer of the two. An absent hint leaves the strategy delay unchanged.
 */
export function retryNotBeforeDelayMs(policy: RetryWait, attempt: number, retryAfterMs?: number): number {
  const strategy = retryDelayMs(policy, attempt);
  if (retryAfterMs === undefined) return strategy;
  return Math.max(strategy, retryAfterMs);
}

/**
 * An idle deadline before any content frame is one retryable model error.
 * An idle deadline after content exists is terminal: do not resend, and do not run tool calls that exist only in frames.
 * Caller cancel wins over the deadline, so a user abort is not a retry.
 * Frames that keep arriving restart the idle timer, so a long stream is not cut off for total duration.
 */
export function classifyDeadline(facts: DeadlineFacts): DeadlineAction {
  if (!facts.timedOut || facts.cancelRequested) return { kind: "unchanged" };
  if (facts.contentFrames === 0) return { kind: "retryable_timeout" };
  return { kind: "interrupted" };
}

/** Own the idle timer. {@link RequestDeadline.touch} restarts it. A finished request must not leave one pending. */
export function armRequestDeadline(timeoutMs: number, parent: AbortSignal): RequestDeadline {
  const controller = new AbortController();
  let fired = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParent = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", onParent, { once: true });
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed || fired || parent.aborted || controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || parent.aborted) return;
      fired = true;
      controller.abort();
    }, timeoutMs);
    // Leave the timer referenced. A stream that is only waiting on this deadline
    // has no other handle, and unref would let the loop exit before it fires.
    // dispose() clears it when the request ends.
  };
  arm();
  return {
    signal: controller.signal,
    timedOut: () => fired && !parent.aborted,
    touch() {
      arm();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      parent.removeEventListener("abort", onParent);
    },
  };
}
