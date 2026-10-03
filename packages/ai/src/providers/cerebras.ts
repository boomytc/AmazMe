import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function cerebrasProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    auth: { apiKey: { env: "CEREBRAS_API_KEY", name: "Cerebras API key" } },
    models: catalogModels("cerebras"),
    api: wires("openai-completions", options),
  });
}
