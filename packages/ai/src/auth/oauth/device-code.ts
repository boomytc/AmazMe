const CANCEL_MESSAGE = "Login cancelled";
const MINIMUM_INTERVAL_MS = 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

export type DevicePollResult<T> =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds?: number }
  | { status: "failed"; message: string }
  | { status: "complete"; value: T };

export async function pollDeviceCode<T>(options: {
  intervalSeconds?: number;
  expiresInSeconds?: number;
  waitBeforeFirstPoll?: boolean;
  signal: AbortSignal;
  poll: () => Promise<DevicePollResult<T>>;
}): Promise<NonNullable<T>> {
  const deadline = typeof options.expiresInSeconds === "number" ? Date.now() + options.expiresInSeconds * 1000 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000));
  if (options.waitBeforeFirstPoll && Date.now() < deadline) {
    await abortableSleep(Math.min(intervalMs, deadline - Date.now()), options.signal);
  }
  while (Date.now() < deadline) {
    if (options.signal.aborted) throw new Error(CANCEL_MESSAGE);
    let result: DevicePollResult<T>;
    try {
      result = await options.poll();
    } catch (error) {
      if (options.signal.aborted) throw new Error(CANCEL_MESSAGE);
      throw error;
    }
    if (options.signal.aborted) throw new Error(CANCEL_MESSAGE);
    if (result.status === "complete") {
      if (result.value === undefined || result.value === null) throw new Error("Device flow returned no value");
      return result.value as NonNullable<T>;
    }
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") {
      intervalMs = typeof result.intervalSeconds === "number" && result.intervalSeconds > 0
        ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
        : intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await abortableSleep(Math.min(intervalMs, remaining), options.signal);
  }
  throw new Error("Device flow timed out");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(CANCEL_MESSAGE));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error(CANCEL_MESSAGE));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
