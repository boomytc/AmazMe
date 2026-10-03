import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function zaiProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    auth: { apiKey: { env: "ZAI_API_KEY", name: "Z.AI API key" } },
    models: catalogModels("zai"),
    api: wires("openai-completions", options),
  });
}
