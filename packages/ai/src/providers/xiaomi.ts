import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function xiaomiProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "xiaomi",
    name: "Xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    auth: { apiKey: { env: "XIAOMI_API_KEY", name: "Xiaomi API key" } },
    models: catalogModels("xiaomi"),
    api: wires("openai-completions", options),
  });
}
