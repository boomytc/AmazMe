import { createServer, type ServerResponse } from "node:http";

export interface CallbackServer {
  redirectUri: string;
  wait(): Promise<URL>;
  close(): void;
}

/**
 * Loopback listener for a PKCE login. The response is plain text.
 * This does not open a browser and does not build a TUI.
 */
export async function startCallbackServer(options: {
  port: number;
  path: string;
  host?: string;
  redirectHost?: string;
  state?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CallbackServer> {
  if (options.signal?.aborted) throw new Error("Login cancelled");
  let resolveWait: (url: URL) => void = () => undefined;
  let rejectWait: (error: Error) => void = () => undefined;
  const waitPromise = new Promise<URL>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  waitPromise.catch(() => undefined);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: { url: URL } | { error: Error }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if ("error" in result) rejectWait(result.error);
    else resolveWait(result.url);
  };
  const send = (response: ServerResponse, status: number, text: string) => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(text);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== options.path) {
      send(response, 404, "callback route not found");
      return;
    }
    if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
      send(response, 400, "state mismatch");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      send(response, 400, error);
      finish({ error: new Error(url.searchParams.get("error_description") ?? error) });
      return;
    }
    if (!url.searchParams.get("code")) {
      send(response, 400, "missing authorization code");
      return;
    }
    if (settled) {
      send(response, 409, "already handled");
      return;
    }
    send(response, 200, "signed in");
    finish({ url });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("OAuth callback server did not bind");
  }
  const onAbort = () => finish({ error: new Error("Login cancelled") });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => finish({ error: new Error("OAuth sign-in timed out") }), options.timeoutMs);
  }
  const redirectHost = options.redirectHost ?? options.host ?? "127.0.0.1";
  return {
    redirectUri: `http://${redirectHost}:${address.port}${options.path}`,
    wait: () => waitPromise,
    close: () => {
      finish({ error: new Error("OAuth callback server closed") });
      server.close();
    },
  };
}
