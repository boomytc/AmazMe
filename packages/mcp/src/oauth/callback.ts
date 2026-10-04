/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 *
 * Listens for the loopback redirect. Does not open a browser.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { OAuthIssuerMismatchError } from "./errors.ts";

export interface OAuthCallback {
  code: string;
  state: string;
  iss?: string;
}

/** Outcome shown on the browser page after the redirect. */
export type OAuthCallbackPage = { ok: true } | { ok: false; message: string; details?: string };

export interface OAuthCallbackServerOptions {
  /** Address to listen on. Default: `127.0.0.1`. */
  host?: string;
  /**
   * Host name in `redirectUrl`, for example `localhost` for a client registered with it while
   * listening on `127.0.0.1`. Default: `host`.
   */
  redirectHost?: string;
  port?: number;
  path?: string;
  /** More paths that receive the callback, for example a server-specific path of a redirect URI. */
  extraPaths?: string[];
  timeoutMs?: number;
  /** Render the browser page as HTML. Default: a plain-text message. */
  renderPage?: (page: OAuthCallbackPage) => string;
}

export interface OAuthCallbackWaitOptions {
  path?: string;
  signal?: AbortSignal;
  /** Issuer recorded with the PKCE verifier before redirecting. */
  issuer?: string;
  requireIss?: boolean;
}

function plainText(page: OAuthCallbackPage): string {
  if (page.ok) return "Authorization complete. You may close this window.";
  return page.details ? `${page.message}\n\n${page.details}` : page.message;
}

export class OAuthCallbackServer {
  readonly redirectUrl: string;
  private server: Server;
  private paths: string[];
  private timeoutMs: number;
  private renderPage: ((page: OAuthCallbackPage) => string) | undefined;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve: (callback: OAuthCallback) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      path: string | undefined;
      issuer?: string;
      requireIss?: boolean;
      cleanup: () => void;
    }
  >();

  private constructor(
    server: Server,
    redirectUrl: string,
    paths: string[],
    timeoutMs: number,
    renderPage: ((page: OAuthCallbackPage) => string) | undefined,
  ) {
    this.server = server;
    this.redirectUrl = redirectUrl;
    this.paths = paths;
    this.timeoutMs = timeoutMs;
    this.renderPage = renderPage;
  }

  static async listen(options: OAuthCallbackServerOptions = {}): Promise<OAuthCallbackServer> {
    const host = options.host ?? "127.0.0.1";
    const redirectHost = options.redirectHost ?? host;
    if (!["127.0.0.1", "localhost", "::1"].includes(host) || !["127.0.0.1", "localhost", "::1"].includes(redirectHost)) {
      throw new Error("OAuth callback listener must use a loopback address");
    }
    const path = options.path ?? "/callback";
    const paths = [path, ...(options.extraPaths ?? [])];
    if (paths.some((value) => !value.startsWith("/") || value.includes("?") || value.includes("#"))) {
      throw new Error("OAuth callback paths must be absolute paths without query or fragment");
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2_147_483_647)) {
      throw new Error("Invalid OAuth callback timeout");
    }
    let instance: OAuthCallbackServer | undefined;
    const server = createServer((request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
        return;
      }
      instance?.handle(request.url ?? "/", response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth callback server did not bind to TCP");
    instance = new OAuthCallbackServer(
      server,
      `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${path}`,
      paths,
      options.timeoutMs ?? 5 * 60_000,
      options.renderPage,
    );
    return instance;
  }

  /**
   * Wait for the authorization response with `state`. With `path`, a response on another path fails, so
   * a server-specific redirect URI can tell authorization servers apart (RFC 9700 section 4.4.2.2).
   */
  waitForCallback(state: string, pathOrOptions?: string | OAuthCallbackWaitOptions): Promise<OAuthCallback> {
    if (this.closed) return Promise.reject(new Error("OAuth callback server closed"));
    const options = typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions ?? {};
    if (options.requireIss && options.issuer === undefined) return Promise.reject(new Error("An expected issuer is required"));
    if (options.path !== undefined && !this.paths.includes(options.path)) return Promise.reject(new Error("OAuth callback path is not registered"));
    if (!state) return Promise.reject(new Error("OAuth state must not be empty"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.pending.has(state)) throw new Error("OAuth state is already pending");
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        this.pending.delete(state);
      };
      const aborted = () => {
        cleanup();
        reject(options.signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("OAuth callback timed out"));
      }, this.timeoutMs);
      this.pending.set(state, { resolve, reject, timer, cleanup, path: options.path, issuer: options.issuer, requireIss: options.requireIss });
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("OAuth callback server closed"));
    }
    this.pending.clear();
    this.closing = new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    await this.closing;
  }

  private reply(response: ServerResponse, status: number, page: OAuthCallbackPage): void {
    if (this.renderPage) {
      let html: string;
      try { html = this.renderPage(page); } catch {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Unable to render the authorization page");
        return;
      }
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    } else {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(plainText(page));
    }
  }

  private handle(rawUrl: string, response: ServerResponse): void {
    let url: URL;
    try { url = new URL(rawUrl, this.redirectUrl); } catch {
      this.reply(response, 400, { ok: false, message: "Invalid callback URL" });
      return;
    }
    if (!this.paths.includes(url.pathname)) {
      this.reply(response, 404, { ok: false, message: "Not found" });
      return;
    }
    const state = url.searchParams.get("state");
    const pending = state ? this.pending.get(state) : undefined;
    if (!state || !pending) {
      this.reply(response, 400, { ok: false, message: "Invalid or expired OAuth state" });
      return;
    }
    pending.cleanup();
    if (pending.path !== undefined && url.pathname !== pending.path) {
      pending.reject(new Error("The authorization response arrived on another redirect URI"));
      this.reply(response, 400, { ok: false, message: "Unexpected redirect URI" });
      return;
    }
    const iss = url.searchParams.get("iss");
    if (pending.issuer !== undefined && (iss !== null || pending.requireIss) && iss !== pending.issuer) {
      pending.reject(new OAuthIssuerMismatchError(pending.issuer, iss ?? undefined));
      this.reply(response, 400, { ok: false, message: "Unexpected authorization server issuer" });
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      pending.reject(new Error(description));
      this.reply(response, 200, {
        ok: false,
        message: "Authorization failed. You may close this window.",
        details: description,
      });
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      pending.reject(new Error("OAuth callback did not include an authorization code"));
      this.reply(response, 400, { ok: false, message: "Missing authorization code" });
      return;
    }
    pending.resolve({ code, state, ...(iss !== null ? { iss } : {}) });
    this.reply(response, 200, { ok: true });
  }
}
