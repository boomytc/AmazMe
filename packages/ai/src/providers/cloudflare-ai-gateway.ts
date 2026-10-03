import type { ApiKeyAuth } from "../auth.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { withCloudflarePlaceholders } from "./request-headers.ts";
import { wires } from "./wires.ts";

function cloudflareAuth(): ApiKeyAuth {
  return {
    env: "CLOUDFLARE_API_KEY",
    name: "Cloudflare API key",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      const key = credential?.key ?? env.CLOUDFLARE_API_KEY;
      const account = credential?.env?.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
      const gateway = credential?.env?.CLOUDFLARE_GATEWAY_ID ?? env.CLOUDFLARE_GATEWAY_ID;
      if (!key || !account || !gateway) return undefined;
      return {
        apiKey: key,
        source: credential?.key ? "store" : "env",
        headers: { "cf-aig-authorization": `Bearer ${key}` },
        env: { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_GATEWAY_ID: gateway },
      };
    },
  };
}

export function cloudflareAIGatewayProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    auth: { apiKey: cloudflareAuth() },
    models: catalogModels("cloudflare-ai-gateway"),
    api: wires(["anthropic-messages", "openai-completions", "openai-responses"], {
      ...options,
      wrap: withCloudflarePlaceholders,
    }),
  });
}
