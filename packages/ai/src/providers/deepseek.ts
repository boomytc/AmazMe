import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function deepseekProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    auth: { apiKey: { env: "DEEPSEEK_API_KEY", name: "DeepSeek API key" } },
    models: catalogModels("deepseek"),
    api: wires("openai-completions", options),
  });
}
