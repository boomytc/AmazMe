import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function moonshotaiCnProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "moonshotai-cn",
    name: "Moonshot AI CN",
    baseUrl: "https://api.moonshot.cn/v1",
    auth: { apiKey: { env: "MOONSHOT_API_KEY", name: "Moonshot AI API key" } },
    models: catalogModels("moonshotai-cn"),
    api: wires("openai-completions", options),
  });
}
