import type { ApiKeyAuth } from "../auth.ts";
import { anthropicOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

function anthropicApiKey(): ApiKeyAuth {
  return {
    env: "ANTHROPIC_API_KEY",
    name: "Anthropic API key",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      if (credential?.key) return { apiKey: credential.key, source: "store", ...(credential.env ? { env: credential.env } : {}) };
      const authToken = env.ANTHROPIC_AUTH_TOKEN;
      if (authToken) return { source: "env", headers: { Authorization: `Bearer ${authToken}` } };
      for (const name of ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const) {
        const key = env[name];
        if (key) return { apiKey: key, source: "env" };
      }
      const federation: Record<string, string> = {};
      for (const name of ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE"] as const) {
        const value = env[name];
        if (!value) return undefined;
        federation[name] = value;
      }
      for (const name of ["ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID"] as const) {
        const value = env[name];
        if (value) federation[name] = value;
      }
      return { source: "env", env: federation };
    },
  };
}

export function anthropicProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: { apiKey: anthropicApiKey(), oauth: anthropicOAuth(options.fetch) },
    models: catalogModels("anthropic"),
    api: wires("anthropic-messages", options),
  });
}
