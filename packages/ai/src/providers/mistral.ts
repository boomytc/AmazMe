import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function mistralProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai",
    auth: { apiKey: { env: "MISTRAL_API_KEY", name: "Mistral API key" } },
    models: catalogModels("mistral"),
    api: wires("mistral-conversations", options),
  });
}
