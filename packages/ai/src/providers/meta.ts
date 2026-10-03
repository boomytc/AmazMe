import { metaOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function metaProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "meta",
    name: "Meta",
    baseUrl: "https://api.meta.ai/v1",
    auth: {
      apiKey: { env: "META_API_KEY", name: "Meta Model API key" },
      oauth: metaOAuth(options.fetch),
    },
    models: catalogModels("meta"),
    api: wires("openai-responses", options),
  });
}
