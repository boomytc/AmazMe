import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function azureOpenAIResponsesProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "azure-openai-responses",
    name: "Azure OpenAI Responses",
    auth: { apiKey: {
      env: "AZURE_OPENAI_API_KEY", name: "Azure OpenAI API key",
      async resolve({ credential, env }): Promise<AuthResult | undefined> {
        if (credential) return credential.key
          ? { apiKey: credential.key, source: "store", ...(credential.env ? { env: credential.env } : {}) }
          : undefined;
        if (!env.AZURE_OPENAI_API_KEY) return undefined;
        const config: Record<string, string> = {};
        for (const name of ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_DEPLOYMENT_NAME", "AZURE_OPENAI_API_VERSION"]) {
          const value = env[name];
          if (value) config[name] = value;
        }
        return { apiKey: env.AZURE_OPENAI_API_KEY, source: "env", env: config };
      },
    } },
    models: catalogModels("azure-openai-responses"),
    api: wires("azure-openai-responses", options),
  });
}
