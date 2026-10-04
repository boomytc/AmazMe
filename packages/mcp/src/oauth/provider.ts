/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 */

import type { OAuthAuthorizationState, OAuthClientMetadataDocument, OAuthClientProvider } from "./flow.ts";
import {
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type OAuthTokens,
  parseOAuthTokens,
} from "./types.ts";

export interface McpOAuthState {
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the access token expires, in milliseconds since the epoch, from `expires_in` at the time it was saved. */
  tokensExpireAt?: number;
  codeVerifier?: string;
  oauthState?: string;
  discovery?: OAuthDiscoveryState;
  authorization?: OAuthAuthorizationState;
  /** Retained when grants are invalidated: configured secrets are bound to their original issuer. */
  configuredClientIssuer?: string;
  requestedScope?: string;
}

export interface McpOAuthStateStore {
  load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
  save(state: McpOAuthState): void | Promise<void>;
}

const storeWrites = new WeakMap<McpOAuthStateStore, Promise<void>>();
const storeCoordination = new WeakMap<McpOAuthStateStore, Map<string, object>>();

export interface McpOAuthProviderOptions {
  serverUrl: string | URL;
  redirectUrl: string | URL;
  clientMetadata: Omit<OAuthClientMetadata, "redirect_uris"> & { redirect_uris?: string[] };
  /** See `OAuthClientProvider.clientMetadataDocument`. */
  clientMetadataDocument?: (metadata: AuthorizationServerMetadata | undefined) => OAuthClientMetadataDocument | undefined;
  clientId?: string;
  clientSecret?: string;
  store?: McpOAuthStateStore;
  onRedirect(url: URL): void | Promise<void>;
}

export class MemoryOAuthStateStore implements McpOAuthStateStore {
  private value: McpOAuthState | undefined;

  load(): McpOAuthState | undefined {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }

  save(state: McpOAuthState): void {
    this.value = structuredClone(state);
  }
}

/**
 * Stateful provider for one exact MCP server URL.
 * Credentials discovered for a different authorization server issuer are not reused.
 * The caller owns the store. This package does not choose a credential file.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  readonly clientMetadataDocument?: (
    metadata: AuthorizationServerMetadata | undefined,
  ) => OAuthClientMetadataDocument | undefined;
  private serverUrl: string;
  private configuredClient: OAuthClientInformationMixed | undefined;
  private store: McpOAuthStateStore;
  private onRedirect: (url: URL) => void | Promise<void>;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = String(new URL(options.serverUrl));
    this.redirectUrl = String(options.redirectUrl);
    this.clientMetadata = {
      ...options.clientMetadata,
      redirect_uris: options.clientMetadata.redirect_uris ?? [this.redirectUrl],
      grant_types: options.clientMetadata.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: options.clientMetadata.response_types ?? ["code"],
      token_endpoint_auth_method:
        options.clientMetadata.token_endpoint_auth_method ?? (options.clientSecret ? "client_secret_post" : "none"),
    };
    this.clientMetadataDocument = options.clientMetadataDocument;
    this.configuredClient = options.clientId
      ? { client_id: options.clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) }
      : undefined;
    this.store = options.store ?? new MemoryOAuthStateStore();
    this.onRedirect = options.onRedirect;
  }

  async state(): Promise<string> {
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    await this.update((value) => ({ ...value, oauthState: state }));
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return structuredClone(this.configuredClient ?? (await this.load()).clientInformation);
  }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    if (this.configuredClient) return;
    const snapshot = structuredClone(information);
    await this.update((value) => ({ ...value, clientInformation: snapshot }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  assertServerUrl(serverUrl: string | URL): void {
    if (String(new URL(serverUrl)) !== this.serverUrl) throw new Error("OAuth provider belongs to another MCP server URL");
  }

  async accessToken(): Promise<string | undefined> {
    const state = await this.load();
    if (state.tokensExpireAt !== undefined && state.tokensExpireAt <= Date.now()) return undefined;
    return state.tokens?.access_token;
  }

  coordinationKey(): object {
    let servers = storeCoordination.get(this.store);
    if (!servers) { servers = new Map(); storeCoordination.set(this.store, servers); }
    let key = servers.get(this.serverUrl);
    if (!key) { key = {}; servers.set(this.serverUrl, key); }
    return key;
  }

  async requestedScope(): Promise<string | undefined> {
    return (await this.load()).requestedScope;
  }

  async assertClientIssuer(issuer: string): Promise<void> {
    if (!this.configuredClient?.client_secret) return;
    const state = await this.load();
    const previous = state.configuredClientIssuer ?? state.discovery?.authorizationServerMetadata?.issuer ?? state.discovery?.authorizationServerUrl;
    if (previous !== undefined && previous !== issuer) {
      throw new Error("Configured OAuth client secret belongs to another authorization server issuer");
    }
  }

  async saveAuthorizationState(authorization: OAuthAuthorizationState): Promise<void> {
    const snapshot = structuredClone(authorization);
    await this.update((value) => ({
      ...value,
      authorization: snapshot,
      codeVerifier: snapshot.codeVerifier,
      oauthState: snapshot.state,
      requestedScope: snapshot.scope,
    }));
  }

  async authorizationState(): Promise<OAuthAuthorizationState | undefined> {
    return (await this.load()).authorization;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    tokens = parseOAuthTokens(tokens);
    const expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    await this.update((value) => {
      const next: McpOAuthState = { ...value, tokens };
      if (expiresAt === undefined) delete next.tokensExpireAt;
      else next.tokensExpireAt = expiresAt;
      return next;
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onRedirect(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.update((value) => ({ ...value, codeVerifier: verifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) throw new Error("No OAuth PKCE code verifier is stored");
    return verifier;
  }

  async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.update((value) => {
      const next = { ...value };
      if (kind === "all" || kind === "client") delete next.clientInformation;
      if (kind === "all" || kind === "tokens") {
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      if (kind === "all") delete next.requestedScope;
      if (kind === "all" || kind === "verifier") {
        delete next.codeVerifier;
        delete next.oauthState;
        delete next.authorization;
      }
      if (kind === "all" || kind === "discovery") delete next.discovery;
      if (kind === "all") delete next.oauthState;
      return next;
    });
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    const snapshot = structuredClone(discovery);
    await this.update((value) => ({
      ...value,
      discovery: snapshot,
      ...(this.configuredClient?.client_secret
        ? { configuredClientIssuer: value.configuredClientIssuer ?? snapshot.authorizationServerMetadata?.issuer ?? snapshot.authorizationServerUrl }
        : {}),
    }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discovery;
  }

  private async load(): Promise<McpOAuthState> {
    await storeWrites.get(this.store);
    return this.own(await this.store.load());
  }

  private async update(update: (state: McpOAuthState) => McpOAuthState): Promise<void> {
    const operation = (storeWrites.get(this.store) ?? Promise.resolve()).then(async () => {
      await this.store.save(update(this.own(await this.store.load())));
    });
    storeWrites.set(this.store, operation.catch(() => undefined));
    await operation;
  }

  /** Stored state for another server URL is ignored, so credentials never leak across MCP servers. */
  private own(state: McpOAuthState | undefined): McpOAuthState {
    return state?.serverUrl === this.serverUrl ? structuredClone(state) : { serverUrl: this.serverUrl };
  }
}
