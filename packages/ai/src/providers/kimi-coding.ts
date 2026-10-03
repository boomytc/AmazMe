import { kimiOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function kimiCodingProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "kimi-coding",
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding",
    auth: {
      apiKey: { env: "KIMI_API_KEY", name: "Kimi API key" },
      oauth: kimiOAuth(options.fetch),
    },
    models: catalogModels("kimi-coding"),
    api: wires("anthropic-messages", options),
  });
}
