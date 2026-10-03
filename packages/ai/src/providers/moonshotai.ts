import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function moonshotaiProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "moonshotai",
    name: "Moonshot AI",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: { apiKey: { env: "MOONSHOT_API_KEY", name: "Moonshot AI API key" } },
    models: catalogModels("moonshotai"),
    api: wires("openai-completions", options),
  });
}
