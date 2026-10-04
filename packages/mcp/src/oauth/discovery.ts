/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove Zod and to check the authorization server issuer.
 */

import type { McpFetch } from "../auth-provider.ts";
export { parseWwwAuthenticate } from "../auth-challenge.ts";
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import { OAuthIssuerMismatchError } from "./errors.ts";
import { abortable, callFetch, checkAbort } from "./http.ts";
import {
  type AuthorizationServerMetadata,
  type OAuthProtectedResourceMetadata,
  type OAuthServerInfo,
  parseAuthorizationServerMetadata,
  parseProtectedResourceMetadata,
} from "./types.ts";

function discard(response: Response | undefined): void {
  void response?.body?.cancel().catch(() => undefined);
}

/** 4xx and 502 mean "not here", so discovery tries the next candidate URL. */
function isDiscoveryMiss(status: number): boolean {
  return (status >= 400 && status < 500) || status === 502;
}

/** Path suffix for `/.well-known/<kind><path>`; empty for the root path. */
function pathSuffix(pathname: string): string {
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

async function fetchMetadata(url: URL, fetchImpl: McpFetch, protocolVersion: string, signal?: AbortSignal): Promise<Response> {
  return callFetch(fetchImpl, url, {
    headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
    signal,
  });
}

export async function discoverProtectedResourceMetadata(
  serverUrl: string | URL,
  options: { resourceMetadataUrl?: string | URL; protocolVersion?: string; fetch?: McpFetch; signal?: AbortSignal } = {},
): Promise<OAuthProtectedResourceMetadata> {
  const server = new URL(serverUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
  let response = await fetchMetadata(
    options.resourceMetadataUrl
      ? new URL(options.resourceMetadataUrl)
      : new URL(`/.well-known/oauth-protected-resource${pathSuffix(server.pathname)}`, server.origin),
    fetchImpl,
    version,
    options.signal,
  );
  if (!options.resourceMetadataUrl && server.pathname !== "/" && isDiscoveryMiss(response.status)) {
    discard(response);
    response = await fetchMetadata(new URL("/.well-known/oauth-protected-resource", server.origin), fetchImpl, version, options.signal);
  }
  if (!response.ok) {
    discard(response);
    throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
  }
  return parseProtectedResourceMetadata(await abortable(response.json(), options.signal));
}

export function buildAuthorizationServerDiscoveryUrls(
  authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
  const issuer = new URL(authorizationServerUrl);
  const path = pathSuffix(issuer.pathname);
  const urls: { url: URL; type: "oauth" | "oidc" }[] = [
    { url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin), type: "oauth" },
    { url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin), type: "oidc" },
  ];
  if (path) urls.push({ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin), type: "oidc" });
  return urls;
}

/** Issuer identifiers use exact comparison (RFC 8414 section 3.3). */
export function sameIssuer(left: string, right: string): boolean {
  return left === right;
}

export async function discoverAuthorizationServerMetadata(
  authorizationServerUrl: string | URL,
  options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean; signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
    const response = await fetchMetadata(url, fetchImpl, options.protocolVersion ?? LATEST_PROTOCOL_VERSION, options.signal);
    if (!response.ok) {
      discard(response);
      if (isDiscoveryMiss(response.status)) continue;
      throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
    }
    const metadata = parseAuthorizationServerMetadata(await abortable(response.json(), options.signal));
    if (!options.skipIssuerValidation) {
      const expected = String(authorizationServerUrl);
      if (!sameIssuer(metadata.issuer, expected)) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
    }
    return metadata;
  }
  return undefined;
}

export async function discoverOAuthServerInfo(
  serverUrl: string | URL,
  options: {
    resourceMetadataUrl?: URL;
    /** Metadata document to use instead of discovery. It is trusted as configured, so its issuer is not checked. */
    authorizationServerMetadataUrl?: URL;
    fetch?: McpFetch;
    skipIssuerValidation?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<OAuthServerInfo> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
      resourceMetadataUrl: options.resourceMetadataUrl,
      fetch: options.fetch,
      signal: options.signal,
    });
  } catch (error) {
    checkAbort(options.signal);
    if (error instanceof TypeError) throw error;
  }
  if (options.authorizationServerMetadataUrl) {
    const url = options.authorizationServerMetadataUrl;
    const response = await fetchMetadata(url, options.fetch ?? globalThis.fetch, LATEST_PROTOCOL_VERSION, options.signal);
    if (!response.ok) {
      discard(response);
      throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
    }
    const metadata = parseAuthorizationServerMetadata(await abortable(response.json(), options.signal));
    return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
  }
  const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  return {
    authorizationServerUrl,
    authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      fetch: options.fetch,
      skipIssuerValidation: options.skipIssuerValidation,
      signal: options.signal,
    }),
    resourceMetadata,
  };
}

export function resourceUrlFromServerUrl(value: string | URL): URL {
  const url = new URL(value);
  url.hash = "";
  return url;
}

export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
  if (!metadata) return resourceUrlFromServerUrl(serverUrl).href;
  const requested = resourceUrlFromServerUrl(serverUrl);
  const configured = new URL(metadata.resource);
  if (requested.origin !== configured.origin) {
    throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
  }
  const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
  const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
  if (!requestedPath.startsWith(configuredPath)) {
    throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
  }
  return metadata.resource;
}
