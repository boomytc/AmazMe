import type { AuthResult, Credential, CredentialStore, OAuthCredential, ProviderHeaders } from "./types.ts";

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, Credential>();
  private readonly chains = new Map<string, Promise<unknown>>();

  /** One chain per provider so refresh and set cannot interleave. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return run;
  }

  async get(providerId: string): Promise<Credential | undefined> {
    return this.values.get(providerId);
  }

  set(providerId: string, credential: Credential): Promise<void> {
    return this.enqueue(providerId, async () => {
      this.values.set(providerId, credential);
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      this.values.delete(providerId);
    });
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = this.values.get(providerId);
      const next = await fn(current);
      if (next !== undefined) this.values.set(providerId, next);
      return next ?? current;
    });
  }
}

export interface ApiKeyAuth {
  env: string;
  /** When true, the provider is configured even without a key. Faux uses this. */
  ambient?: string;
  name?: string;
  /**
   * Provider-specific resolution. Used for Bedrock, Vertex, Anthropic workload identity,
   * and Cloudflare account ids. A stored credential still owns the provider: this is not
   * an environment fallback after a stored key.
   */
  resolve?(input: {
    credential?: Extract<Credential, { type: "api_key" }>;
    env: Record<string, string | undefined>;
  }): Promise<AuthResult | undefined>;
}

export interface OAuthLoginHandback {
  auth_url?: string;
  device_code?: {
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  };
}

export interface LoginResult extends OAuthLoginHandback {
  credential: OAuthCredential;
}

export interface LoginInteraction {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** `device_code` is the default for flows that have one. `pkce` uses the callback listener. */
  method?: "pkce" | "device_code";
  /** Stable installation id for OpenAI ChatGPT. Not a secret. */
  deviceId?: string;
  /** Called as soon as the URL or device code exists, before the token exchange finishes. */
  onHandback?: (handback: OAuthLoginHandback) => void;
  /** Callback listen port. `0` picks an ephemeral port. ChatGPT defaults to Pi's 1455. */
  callbackPort?: number;
}

export interface OAuthAuth {
  name: string;
  isSubscription?: boolean;
  login(interaction: LoginInteraction): Promise<LoginResult>;
  /** Exchange the refresh token. Throw on failure. Do not return a partial credential. */
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<{
    apiKey?: string;
    headers?: ProviderHeaders;
    baseUrl?: string;
    env?: Record<string, string>;
  }>;
}

/** A preset may carry an API key, OAuth, or both. */
export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
}

export function providerAuth(auth: ApiKeyAuth | ProviderAuth): ProviderAuth {
  if ("apiKey" in auth || "oauth" in auth) return auth as ProviderAuth;
  return { apiKey: auth as ApiKeyAuth };
}

/** Refresh this long before the reported expiry so a request does not start on a dying token. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;

export class AuthRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRefreshError";
  }
}

/**
 * Request key, then a stored credential, then the environment.
 * A stored credential owns the provider: the environment is not a fallback.
 */
export async function resolveApiKey(input: {
  providerId: string;
  auth: ApiKeyAuth;
  store: CredentialStore;
  env: Record<string, string | undefined>;
  apiKey?: string;
}): Promise<AuthResult | undefined> {
  if (input.apiKey !== undefined && input.apiKey !== "") {
    return { apiKey: input.apiKey, source: "request" };
  }
  const stored = await input.store.get(input.providerId);
  if (stored) {
    if (stored.type !== "api_key" || !stored.key) return undefined;
    return { apiKey: stored.key, source: "store" };
  }
  const fromEnv = input.env[input.auth.env];
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  if (input.auth.ambient !== undefined) return { apiKey: input.auth.ambient, source: "ambient" };
  return undefined;
}

export async function resolveModelAuth(input: {
  providerId: string;
  auth: ProviderAuth;
  store: CredentialStore;
  env: Record<string, string | undefined>;
  apiKey?: string;
  signal?: AbortSignal;
  /** Stream requests refresh. Status reads do not. */
  refresh?: boolean;
}): Promise<AuthResult | undefined> {
  if (input.apiKey !== undefined && input.apiKey !== "") {
    return { apiKey: input.apiKey, source: "request" };
  }
  const stored = await input.store.get(input.providerId);
  if (stored?.type === "oauth") {
    if (!input.auth.oauth) return undefined;
    const credential = input.refresh === false ? stored : await refreshOAuth(input, stored);
    const derived = await input.auth.oauth.toAuth(credential);
    return {
      ...(derived.apiKey ? { apiKey: derived.apiKey } : {}),
      ...(derived.headers ? { headers: derived.headers } : {}),
      ...(derived.baseUrl ? { baseUrl: derived.baseUrl } : {}),
      ...(derived.env ? { env: derived.env } : {}),
      source: "oauth",
    };
  }
  if (stored?.type === "api_key") {
    if (input.auth.apiKey?.resolve) return input.auth.apiKey.resolve({ credential: stored, env: input.env });
    if (stored.key) return { apiKey: stored.key, source: "store", ...(stored.env ? { env: stored.env } : {}) };
    return undefined;
  }
  if (input.auth.apiKey?.resolve) return input.auth.apiKey.resolve({ env: input.env });
  const apiKey = input.auth.apiKey;
  if (!apiKey) return undefined;
  const fromEnv = input.env[apiKey.env];
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  if (apiKey.ambient !== undefined) return { apiKey: apiKey.ambient, source: "ambient" };
  return undefined;
}

async function refreshOAuth(
  input: {
    providerId: string;
    auth: ProviderAuth;
    store: CredentialStore;
    signal?: AbortSignal;
  },
  stored: OAuthCredential,
): Promise<OAuthCredential> {
  const oauth = input.auth.oauth;
  if (!oauth) throw new AuthRefreshError("Provider has no OAuth login");
  if (stored.expires > Date.now() + OAUTH_REFRESH_SKEW_MS) return stored;
  const signal = input.signal ?? new AbortController().signal;
  try {
    const next = await input.store.modify(input.providerId, async (current) => {
      if (!current || current.type !== "oauth") throw new AuthRefreshError("OAuth credential disappeared");
      if (current.expires > Date.now() + OAUTH_REFRESH_SKEW_MS) return current;
      const refreshed = await oauth.refresh(current, signal);
      if (!refreshed || refreshed.type !== "oauth" || !refreshed.access) {
        throw new AuthRefreshError("OAuth refresh did not return a credential");
      }
      return refreshed;
    });
    if (!next || next.type !== "oauth" || !next.access) {
      throw new AuthRefreshError("OAuth refresh did not return a credential");
    }
    return next;
  } catch (error) {
    if (error instanceof AuthRefreshError) throw error;
    throw new AuthRefreshError(error instanceof Error ? error.message : String(error));
  }
}
