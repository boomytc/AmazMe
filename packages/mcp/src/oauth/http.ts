import type { McpFetch } from "../auth-provider.ts";
import { OAuthInsecureEndpointError } from "./errors.ts";

export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** A caller's cancellation also works with injected callbacks that ignore the signal. */
export async function abortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    void Promise.resolve(operation).catch(() => undefined);
    checkAbort(signal);
  }
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

export function secureEndpoint(value: string | URL): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new OAuthInsecureEndpointError(url.origin + url.pathname);
  }
  return url;
}

/** Call fetch with no receiver. A method call makes Cloudflare and Node reject it. */
export async function callFetch(fetchImpl: McpFetch, input: string | URL, init?: RequestInit): Promise<Response> {
  checkAbort(init?.signal ?? undefined);
  const operation = fetchImpl.call(undefined, secureEndpoint(input), { ...init, redirect: "error" });
  const signal = init?.signal ?? undefined;
  void operation.then((response) => {
    if (signal?.aborted) void response.body?.cancel().catch(() => undefined);
  }, () => undefined);
  return abortable(operation, signal);
}
