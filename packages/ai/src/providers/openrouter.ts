import { openRouterOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function openrouterProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: {
      apiKey: { env: "OPENROUTER_API_KEY", name: "OpenRouter API key" },
      oauth: openRouterOAuth(options.fetch),
    },
    models: catalogModels("openrouter"),
    api: wires(["anthropic-messages", "openai-completions"], options),
  });
}
