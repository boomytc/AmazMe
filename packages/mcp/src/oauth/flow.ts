/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove SDK dependencies, use WebCrypto for PKCE, set application_type on
 * dynamic registration (SEP-837), and refuse credentials issued by another authorization server (SEP-2352).
 */

import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.ts";
import { authorizationChallengeKey } from "../auth-challenge.ts";
import { isObject } from "../protocol/jsonrpc.ts";
import {
  discoverOAuthServerInfo,
  parseWwwAuthenticate,
  sameIssuer,
  selectResource,
} from "./discovery.ts";
import {
  McpOAuthAuthorizationRequiredError,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
} from "./errors.ts";
import { abortable, callFetch, checkAbort, secureEndpoint } from "./http.ts";
import {
  type AuthorizationServerMetadata,
  type OAuthClientInformation,
  type OAuthClientInformationFull,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type OAuthServerInfo,
  type OAuthTokens,
  parseClientInformation,
  parseAuthorizationServerMetadata,
  parseOAuthTokens,
} from "./types.ts";

export type AddClientAuthentication = (
  headers: Headers,
  params: URLSearchParams,
  url: string | URL,
  metadata?: AuthorizationServerMetadata,
) => void | Promise<void>;

/** A Client ID Metadata Document: an https URL used as `client_id`, and a redirect URI it lists. */
export interface OAuthClientMetadataDocument {
  url: string;
  redirectUrl: string;
}

/** Snapshot of one authorization redirect, kept with its PKCE verifier until redemption. */
export interface OAuthAuthorizationState {
  serverUrl: string;
  discovery: OAuthDiscoveryState & { authorizationServerMetadata: AuthorizationServerMetadata };
  clientInformation: OAuthClientInformationMixed;
  redirectUrl: string;
  codeVerifier: string;
  state: string;
  scope?: string;
}

export interface OAuthClientProvider {
  readonly redirectUrl: string | URL;
  /** Validate a caller-selected MCP URL before exposing any stored credentials. */
  assertServerUrl?(serverUrl: string | URL): void;
  assertClientIssuer?(issuer: string): void | Promise<void>;
  /** Providers sharing persisted state use one key for flow ordering and rotating refresh tokens. */
  coordinationKey?(): object;
  requestedScope(): string | undefined | Promise<string | undefined>;
  /** Access token suitable for an HTTP header; expired grants remain available through tokens(). */
  accessToken?(): string | undefined | Promise<string | undefined>;
  readonly clientMetadata: OAuthClientMetadata;
  /**
   * Client ID Metadata Document to identify as instead of registering dynamically, or `undefined` to
   * register. Called when no client information is stored; the document is not stored. `metadata` is
   * `undefined` when the authorization server has none; check `client_id_metadata_document_supported`.
   */
  clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined;
  state(): string | Promise<string>;
  clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
  saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
  tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): void | Promise<void>;
  redirectToAuthorization(url: URL): void | Promise<void>;
  saveCodeVerifier(verifier: string): void | Promise<void>;
  codeVerifier(): string | Promise<string>;
  addClientAuthentication?: AddClientAuthentication;
  invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
  saveDiscoveryState(state: OAuthDiscoveryState): void | Promise<void>;
  discoveryState(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
  saveAuthorizationState(authorization: OAuthAuthorizationState): void | Promise<void>;
  authorizationState(): OAuthAuthorizationState | undefined | Promise<OAuthAuthorizationState | undefined>;
}

export interface OAuthFlowOptions {
  serverUrl: string | URL;
  authorizationCode?: string;
  /** State returned by the callback, checked against the concrete provider's pending redirect. */
  state?: string;
  /** `iss` parameter of the authorization response that delivered `authorizationCode` (RFC 9207). */
  iss?: string;
  scope?: string;
  resourceMetadataUrl?: URL;
  /**
   * Authorization server metadata document to use instead of discovery, for servers that advertise a
   * wrong authorization server or none. It is trusted as configured. Must use https, except on loopback.
   */
  authorizationServerMetadataUrl?: URL;
  fetch?: McpFetch;
  skipIssuerValidation?: boolean;
  /**
   * Go straight to the authorization redirect instead of refreshing stored tokens, for example when the
   * server asks for scopes the current grant lacks. A refresh keeps the old scope.
   */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";
type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

export interface TokenRequestOptions {
  metadata?: AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
  resource?: string;
  addClientAuthentication?: AddClientAuthentication;
  fetch?: McpFetch;
  signal?: AbortSignal;
}

function selectClientAuthMethod(information: OAuthClientInformationMixed, supported: string[]): ClientAuthMethod {
  const hinted = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
  if (
    hinted &&
    ["client_secret_basic", "client_secret_post", "none"].includes(hinted) &&
    (supported.length === 0 || supported.includes(hinted))
  ) {
    return hinted as ClientAuthMethod;
  }
  if (supported.length === 0) return information.client_secret ? "client_secret_basic" : "none";
  if (information.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
  if (information.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
  if (supported.includes("none")) return "none";
  throw new Error("No supported OAuth client authentication method");
}

function applyClientAuthentication(
  method: ClientAuthMethod,
  information: OAuthClientInformation,
  headers: Headers,
  params: URLSearchParams,
): void {
  if (method === "client_secret_basic") {
    if (!information.client_secret) throw new Error("client_secret_basic requires a client secret");
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${formEncode(information.client_id)}:${formEncode(information.client_secret)}`).toString("base64")}`,
    );
  } else {
    params.set("client_id", information.client_id);
    if (method === "client_secret_post" && information.client_secret) params.set("client_secret", information.client_secret);
  }
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function sanitizedOAuthText(value: string, params: URLSearchParams, response: Record<string, unknown>, headers: Headers): string {
  const names = ["client_secret", "code", "code_verifier", "refresh_token", "access_token", "id_token"];
  const authentication = headers.get("authorization");
  const secrets = [...names.flatMap((name) => [params.get(name), typeof response[name] === "string" ? response[name] as string : undefined]),
    authentication, authentication?.split(/\s+/, 2)[1]]
    .filter((secret): secret is string => Boolean(secret));
  for (const secret of secrets) {
    for (const encoded of [secret, encodeURIComponent(secret), formEncode(secret)]) value = value.split(encoded).join("[REDACTED]");
  }
  return value;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = Buffer.from(bytes).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export async function startAuthorization(
  authorizationServerUrl: string | URL,
  options: {
    metadata?: AuthorizationServerMetadata;
    clientInformation: OAuthClientInformationMixed;
    redirectUrl: string | URL;
    scope?: string;
    state?: string;
    resource?: string;
    signal?: AbortSignal;
  },
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
  checkAbort(options.signal);
  const metadata = options.metadata;
  if (metadata && !metadata.response_types_supported.includes("code")) {
    throw new Error("Authorization server does not support authorization codes");
  }
  if (!metadata?.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Authorization server does not support PKCE S256");
  }
  const url = secureEndpoint(metadata?.authorization_endpoint ?? new URL("/authorize", authorizationServerUrl));
  secureEndpoint(options.redirectUrl);
  const { verifier, challenge } = await abortable(pkce(), options.signal);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientInformation.client_id);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", String(options.redirectUrl));
  if (options.state) url.searchParams.set("state", options.state);
  if (options.scope) url.searchParams.set("scope", options.scope);
  if (options.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
  if (options.resource) url.searchParams.set("resource", options.resource);
  return { authorizationUrl: url, codeVerifier: verifier };
}

async function tokenRequest(
  authorizationServerUrl: string | URL,
  options: TokenRequestOptions,
  params: URLSearchParams,
): Promise<OAuthTokens> {
  const url = secureEndpoint(options.metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
  const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
  if (options.resource) params.set("resource", options.resource);
  if (options.addClientAuthentication) {
    await abortable(Promise.resolve(options.addClientAuthentication(headers, params, url, options.metadata)), options.signal);
  } else {
    applyClientAuthentication(
      selectClientAuthMethod(options.clientInformation, options.metadata?.token_endpoint_auth_methods_supported ?? []),
      options.clientInformation,
      headers,
      params,
    );
  }
  const response = await callFetch(options.fetch ?? globalThis.fetch, url, { method: "POST", headers, body: params, signal: options.signal });
  const text = await abortable(response.text(), options.signal);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  // Servers may report OAuth errors with any status, so check the body before the status.
  if (isObject(value) && typeof value.error === "string") {
    const sensitive = new URLSearchParams(params);
    if (options.clientInformation.client_secret) sensitive.set("client_secret", options.clientInformation.client_secret);
    throw new OAuthError(
      sanitizedOAuthText(value.error, sensitive, value, headers),
      sanitizedOAuthText(typeof value.error_description === "string" ? value.error_description : value.error, sensitive, value, headers),
      typeof value.error_uri === "string" ? sanitizedOAuthText(value.error_uri, sensitive, value, headers) : undefined,
    );
  }
  if (!response.ok) throw new OAuthError("server_error", `HTTP ${response.status} requesting OAuth tokens`);
  return parseOAuthTokens(value);
}

export async function registerClient(
  authorizationServerUrl: string | URL,
  options: {
    metadata?: AuthorizationServerMetadata;
    clientMetadata: OAuthClientMetadata;
    scope?: string;
    fetch?: McpFetch;
    signal?: AbortSignal;
  },
): Promise<OAuthClientInformationFull> {
  const endpoint = options.metadata?.registration_endpoint;
  if (options.metadata && !endpoint) throw new Error("Authorization server does not support dynamic client registration");
  // SEP-837: omitting application_type makes an OpenID provider treat the client as `web` and reject loopback redirects.
  const applicationType = options.clientMetadata.application_type ?? "native";
  const response = await callFetch(
    options.fetch ?? globalThis.fetch,
    new URL(endpoint ?? new URL("/register", authorizationServerUrl)),
    {
      method: "POST",
      signal: options.signal,
      headers: { Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        ...options.clientMetadata,
        application_type: applicationType,
        ...(options.scope ? { scope: options.scope } : {}),
      }),
    },
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new OAuthRegistrationError(response.status, "Response body omitted because it may contain credentials");
  }
  return parseClientInformation(await abortable(response.json(), options.signal));
}

export async function exchangeAuthorizationCode(
  authorizationServerUrl: string | URL,
  options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Promise<OAuthTokens> {
  return tokenRequest(
    authorizationServerUrl,
    options,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: String(options.redirectUrl),
    }),
  );
}

export async function refreshAuthorization(
  authorizationServerUrl: string | URL,
  options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
  const tokens = await tokenRequest(
    authorizationServerUrl,
    options,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
  );
  return { refresh_token: options.refreshToken, ...tokens };
}

function withScope(tokens: OAuthTokens, scope: string | undefined): OAuthTokens {
  return tokens.scope === undefined && scope ? { ...tokens, scope } : tokens;
}

/**
 * Scopes for a step-up authorization: the challenged scopes plus the ones granted so far.
 * A challenge may list only the missing scopes, and a token with just those would lose access the old
 * one had (SEP-2350). Keep the previous set even when this challenge omits scopes.
 */
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
  const scopes = [granted, challenged].flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []);
  return scopes.length ? [...new Set(scopes)].join(" ") : undefined;
}

function serverInfo(state: OAuthDiscoveryState): OAuthServerInfo {
  return {
    authorizationServerUrl: state.authorizationServerUrl,
    authorizationServerMetadata: state.authorizationServerMetadata,
    resourceMetadata: state.resourceMetadata,
  };
}

async function discoverForFlow(
  provider: OAuthClientProvider,
  options: OAuthFlowOptions,
  metadataUrl: URL | undefined,
  authorization?: OAuthAuthorizationState,
): Promise<{
  discovered: OAuthServerInfo;
  /** The authorization server changed. Issued client credentials and tokens must not be sent to it. */
  issuerChanged: boolean;
  /** False when this attempt learned nothing reliable and the recorded discovery must stay. */
  persistDiscovery: boolean;
}> {
  const cached = authorization?.discovery ?? await abortable(Promise.resolve(provider.discoveryState()), options.signal);
  // Redeem only against the complete snapshot recorded with this verifier.
  if (authorization) {
    return {
      discovered: serverInfo(authorization.discovery),
      issuerChanged: false,
      persistDiscovery: true,
    };
  }
  const discovered = await discoverOAuthServerInfo(options.serverUrl, {
    resourceMetadataUrl: options.resourceMetadataUrl,
    authorizationServerMetadataUrl: metadataUrl,
    fetch: options.fetch,
    skipIssuerValidation: options.skipIssuerValidation,
    signal: options.signal,
  });
  const previousIssuer = cached?.authorizationServerMetadata?.issuer ?? cached?.authorizationServerUrl;
  const nextIssuer = discovered.authorizationServerMetadata?.issuer ?? discovered.authorizationServerUrl;
  // A missing protected-resource document falls back to the MCP origin. That is not a new authorization server.
  if (
    cached &&
    previousIssuer &&
    (!nextIssuer || !sameIssuer(previousIssuer, nextIssuer)) &&
    !discovered.resourceMetadata &&
    !metadataUrl
  ) {
    return { discovered: serverInfo(cached), issuerChanged: false, persistDiscovery: false };
  }
  const issuerChanged = Boolean(previousIssuer && nextIssuer && !sameIssuer(previousIssuer, nextIssuer));
  return { discovered, issuerChanged, persistDiscovery: true };
}

async function runFlow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  checkAbort(options.signal);
  if (options.authorizationCode !== undefined && (typeof options.authorizationCode !== "string" || options.authorizationCode.length === 0)) {
    throw new Error("OAuth authorization code must not be empty");
  }
  provider.assertServerUrl?.(options.serverUrl);
  const authorization = options.authorizationCode
    ? structuredClone(await abortable(Promise.resolve(provider.authorizationState()), options.signal))
    : undefined;
  if (options.authorizationCode) {
    const strings = [authorization?.serverUrl, authorization?.state, authorization?.codeVerifier, authorization?.redirectUrl,
      authorization?.clientInformation?.client_id, authorization?.discovery?.authorizationServerUrl,
      authorization?.discovery?.authorizationServerMetadata?.issuer];
    if (strings.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("No complete pending OAuth authorization is stored");
    }
    if (options.state !== authorization!.state) throw new Error("Invalid OAuth callback state");
    if (String(new URL(options.serverUrl)) !== authorization!.serverUrl) throw new Error("Pending OAuth authorization belongs to another MCP server URL");
    authorization!.discovery.authorizationServerMetadata = parseAuthorizationServerMetadata(authorization!.discovery.authorizationServerMetadata);
  }
  const metadataUrl = options.authorizationServerMetadataUrl && secureEndpoint(options.authorizationServerMetadataUrl);
  const { discovered, issuerChanged, persistDiscovery } = await discoverForFlow(provider, options, metadataUrl, authorization);
  await abortable(Promise.resolve(provider.assertClientIssuer?.(
    discovered.authorizationServerMetadata?.issuer ?? discovered.authorizationServerUrl,
  )), options.signal);
  // SEP-2352: a grant is bound to the authorization server that issued it. Drop it before any request to the new one.
  if (issuerChanged) {
    await abortable(Promise.resolve(provider.invalidateCredentials("all")), options.signal);
  }
  if (persistDiscovery) {
    await abortable(Promise.resolve(provider.saveDiscoveryState({
      ...discovered,
      ...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl.href } : {}),
    })), options.signal);
  }
  const metadata = discovered.authorizationServerMetadata;
  const resource = selectResource(options.serverUrl, discovered.resourceMetadata);
  // `||`, not `??`: an empty scope (for example from `scopes_supported: []`) falls through to the next source.
  const scope = authorization ? authorization.scope : (options.scope || discovered.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope);
  // Issued client credentials were cleared above. A caller-configured client id is not an issued grant and stays.
  const stored = authorization ? authorization.clientInformation : await abortable(Promise.resolve(provider.clientInformation()), options.signal);
  const clientDocument = stored ? undefined : provider.clientMetadataDocument?.(metadata);
  if (clientDocument) {
    const url = new URL(clientDocument.url);
    if (url.protocol !== "https:" || url.pathname === "/") throw new Error("Invalid OAuth client metadata URL");
  }
  let client = stored ?? (clientDocument && { client_id: clientDocument.url });
  if (!client) {
    if (options.authorizationCode) throw new Error("OAuth client information is missing during code exchange");
    if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
    client = await registerClient(discovered.authorizationServerUrl, {
      metadata,
      clientMetadata: provider.clientMetadata,
      scope,
      fetch: options.fetch,
      signal: options.signal,
    });
    await abortable(Promise.resolve(provider.saveClientInformation(client)), options.signal);
  }
  // The document's redirect URI may differ from the provider's, for example by a server-specific path.
  const redirectUrl = authorization ? authorization.redirectUrl : clientDocument?.redirectUrl ?? provider.redirectUrl;
  const tokenOptions: TokenRequestOptions = {
    metadata,
    clientInformation: client,
    resource,
    addClientAuthentication: provider.addClientAuthentication,
    fetch: options.fetch,
    signal: options.signal,
  };
  if (options.authorizationCode) {
    // RFC 9207: never send a code from another authorization server to this one.
    const iss = options.iss;
    if (metadata && (iss !== undefined || metadata.authorization_response_iss_parameter_supported)) {
      if (iss !== metadata.issuer) throw new OAuthIssuerMismatchError(metadata.issuer, iss);
    }
    const tokens = await exchangeAuthorizationCode(discovered.authorizationServerUrl, {
      ...tokenOptions,
      code: options.authorizationCode,
      codeVerifier: authorization!.codeVerifier,
      redirectUrl,
    });
    // A response without `scope` grants the requested scope (RFC 6749 §5.1).
    checkAbort(options.signal);
    await abortable(Promise.resolve(provider.saveTokens(withScope(tokens, scope))), options.signal);
    await abortable(Promise.resolve(provider.invalidateCredentials("verifier")), options.signal);
    return "AUTHORIZED";
  }
  const existing = options.skipRefresh || issuerChanged ? undefined : await abortable(Promise.resolve(provider.tokens()), options.signal);
  if (existing?.refresh_token) {
    try {
      const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
        ...tokenOptions,
        refreshToken: existing.refresh_token,
      });
      // A refresh without `scope` keeps the scope of the grant (RFC 6749 §6).
      checkAbort(options.signal);
      await abortable(Promise.resolve(provider.saveTokens(withScope(tokens, existing.scope))), options.signal);
      return "AUTHORIZED";
    } catch (error) {
      checkAbort(options.signal);
      if (error instanceof OAuthInsecureEndpointError) throw error;
      if (error instanceof OAuthError && error.code !== "server_error") throw error;
    }
  }
  if (!metadata) throw new Error("Authorization server does not support PKCE S256");
  const state = await abortable(Promise.resolve(provider.state()), options.signal);
  if (typeof state !== "string" || state.length === 0) throw new Error("OAuth state must not be empty");
  const redirect = await startAuthorization(discovered.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl,
    scope,
    state,
    resource,
    signal: options.signal,
  });
  // Save the verifier before handing the URL to the caller, so a crash cannot lose it after the redirect starts.
  checkAbort(options.signal);
  await abortable(Promise.resolve(provider.saveAuthorizationState({
    serverUrl: String(new URL(options.serverUrl)),
    discovery: { ...discovered, authorizationServerMetadata: metadata },
    clientInformation: client,
    redirectUrl: String(redirectUrl),
    codeVerifier: redirect.codeVerifier,
    state,
    ...(scope === undefined ? {} : { scope }),
  })), options.signal);
  checkAbort(options.signal);
  await abortable(Promise.resolve(provider.redirectToAuthorization(redirect.authorizationUrl)), options.signal);
  return "REDIRECT";
}

const flowTails = new WeakMap<object, Promise<void>>();

export function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  // One provider stores one pending PKCE redirect. Serialize its flows so simultaneous discovery,
  // refresh and code redemption cannot overwrite that record halfway through another flow.
  const key = provider.coordinationKey?.() ?? provider;
  const previous = flowTails.get(key) ?? Promise.resolve();
  const operation = previous.then(async () => {
    checkAbort(options.signal);
    try {
      return await runFlow(provider, options);
    } catch (error) {
      checkAbort(options.signal);
      // A code is single-use. Do not redeem it again after an OAuth rejection.
      if (options.authorizationCode) throw error;
      if (error instanceof OAuthError && ["invalid_client", "unauthorized_client"].includes(error.code)) {
        await abortable(Promise.resolve(provider.invalidateCredentials("all")), options.signal);
        return runFlow(provider, options);
      }
      if (error instanceof OAuthError && error.code === "invalid_grant" && !options.authorizationCode) {
        await abortable(Promise.resolve(provider.invalidateCredentials("tokens")), options.signal);
        return runFlow(provider, options);
      }
      throw error;
    }
  });
  flowTails.set(key, operation.then(() => undefined, () => undefined));
  return abortable(operation, options.signal);
}

interface OAuthRefreshGroup {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  challengeKey: string;
}

const refreshGroups = new WeakMap<object, OAuthRefreshGroup>();

async function waitForRefresh(group: OAuthRefreshGroup, key: object, signal?: AbortSignal): Promise<void> {
  group.waiters += 1;
  try {
    await abortable(group.promise, signal);
  } finally {
    group.waiters -= 1;
    if (group.waiters === 0 && refreshGroups.get(key) === group) group.controller.abort();
  }
}

/**
 * Auth provider for `StreamableHttpTransport`. Concurrent 401s share one rotating refresh.
 * Cancellation releases one waiter; cancellation of every waiter stops the authorization attempt.
 */
export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
  const key = provider.coordinationKey?.() ?? provider;
  return {
    token: async (serverUrl?: URL) => {
      if (serverUrl) provider.assertServerUrl?.(serverUrl);
      return provider.accessToken ? provider.accessToken() : (await provider.tokens())?.access_token;
    },
    onUnauthorized: async (context: UnauthorizedContext) => {
      checkAbort(context.signal);
      provider.assertServerUrl?.(context.serverUrl);
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      const insufficientScope = challenge.error === "insufficient_scope";
      const challengeKey = authorizationChallengeKey(context.response.status, challenge);
      let group = refreshGroups.get(key);
      if (group?.controller.signal.aborted) group = undefined;
      let waitedForDifferentChallenge = false;
      // A token refresh does not grant new scopes. Different scope challenges need their own flow,
      // after the current group completes, with the requested scopes it recorded included.
      while (group && group.challengeKey !== challengeKey) {
        waitedForDifferentChallenge = true;
        try {
          await waitForRefresh(group, key, context.signal);
        } catch (error) {
          if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
        }
        checkAbort(context.signal);
        group = refreshGroups.get(key);
        if (group?.controller.signal.aborted) group = undefined;
      }
      if (!insufficientScope && !group && !waitedForDifferentChallenge && context.token !== undefined) {
        const current = (await abortable(Promise.resolve(provider.tokens()), context.signal))?.access_token;
        const recorded = challenge.resourceMetadataUrl
          ? await abortable(Promise.resolve(provider.discoveryState()), context.signal)
          : undefined;
        const sameResourceDocument = !challenge.resourceMetadataUrl || challenge.resourceMetadataUrl.href === recorded?.resourceMetadataUrl;
        if (current !== undefined && current !== context.token && sameResourceDocument) return;
        // Another waiter can create the group while tokens() is resolving.
        group = refreshGroups.get(key);
        if (group?.controller.signal.aborted) group = undefined;
      }
      if (!group) {
        const controller = new AbortController();
        const next: OAuthRefreshGroup = { controller, promise: Promise.resolve(), waiters: 0, challengeKey };
        next.promise = abortable(Promise.resolve(insufficientScope ? provider.tokens() : undefined), controller.signal)
          .then(async (granted) => {
            const requested = insufficientScope
              ? await abortable(Promise.resolve(provider.requestedScope()), controller.signal)
              : undefined;
            return authorizeMcp(provider, {
              serverUrl: context.serverUrl,
              resourceMetadataUrl: challenge.resourceMetadataUrl,
              scope: insufficientScope ? stepUpScope(stepUpScope(requested, granted?.scope), challenge.scope) : challenge.scope,
              fetch: context.fetch,
              skipRefresh: insufficientScope,
              signal: controller.signal,
            });
          })
          .then((result) => {
            if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
          })
          .finally(() => {
            if (refreshGroups.get(key) === next) refreshGroups.delete(key);
          });
        group = next;
        refreshGroups.set(key, group);
      }
      await waitForRefresh(group, key, context.signal);
    },
  };
}
