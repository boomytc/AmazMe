import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function togetherProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "together",
    name: "Together",
    baseUrl: "https://api.together.ai/v1",
    auth: { apiKey: { env: "TOGETHER_API_KEY", name: "Together API key" } },
    models: catalogModels("together"),
    api: wires("openai-completions", options),
  });
}
