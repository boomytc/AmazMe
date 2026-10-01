import type { AuthResult, Credential, CredentialStore } from "./types.ts";

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, Credential>();

  async get(providerId: string): Promise<Credential | undefined> {
    return this.values.get(providerId);
  }

  async set(providerId: string, credential: Credential): Promise<void> {
    this.values.set(providerId, credential);
  }

  async delete(providerId: string): Promise<void> {
    this.values.delete(providerId);
  }
}

export interface ApiKeyAuth {
  env: string;
  /** When true, the provider is configured even without a key. Faux uses this. */
  ambient?: string;
}

/**
 * Request key, then a stored credential, then the environment.
 * A stored credential owns the provider: the environment is not a fallback.
 */
export async function resolveApiKey(input: {
  providerId: string;
  auth: ApiKeyAuth;
  store: CredentialStore;
  env: NodeJS.ProcessEnv;
  apiKey?: string;
}): Promise<AuthResult | undefined> {
  if (input.apiKey !== undefined && input.apiKey !== "") {
    return { apiKey: input.apiKey, source: "request" };
  }
  const stored = await input.store.get(input.providerId);
  if (stored) {
    if (stored.type !== "api_key" || stored.key === "") return undefined;
    return { apiKey: stored.key, source: "store" };
  }
  const fromEnv = input.env[input.auth.env];
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  if (input.auth.ambient !== undefined) return { apiKey: input.auth.ambient, source: "ambient" };
  return undefined;
}
