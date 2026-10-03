import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function basetenProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "baseten",
    name: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    auth: { apiKey: { env: "BASETEN_API_KEY", name: "Baseten API key" } },
    models: catalogModels("baseten"),
    api: wires("openai-completions", options),
  });
}
