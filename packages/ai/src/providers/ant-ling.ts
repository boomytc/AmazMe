import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function antLingProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "ant-ling",
    name: "Ant Ling",
    baseUrl: "https://api.ant-ling.com/v1",
    auth: { apiKey: { env: "ANT_LING_API_KEY", name: "Ant Ling API key" } },
    models: catalogModels("ant-ling"),
    api: wires("openai-completions", options),
  });
}
