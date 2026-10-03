import { xaiOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function xaiProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    auth: {
      apiKey: { env: "XAI_API_KEY", name: "xAI API key" },
      oauth: xaiOAuth(options.fetch),
    },
    models: catalogModels("xai"),
    api: wires("openai-responses", options),
  });
}
