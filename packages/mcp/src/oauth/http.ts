import type { McpFetch } from "../auth-provider.ts";

/** Call fetch with no receiver. A method call makes Cloudflare and Node reject it. */
export function callFetch(fetchImpl: McpFetch, input: string | URL, init?: RequestInit): Promise<Response> {
  return fetchImpl.call(undefined, input, init);
}
