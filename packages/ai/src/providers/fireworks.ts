import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function fireworksProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "fireworks",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference",
    auth: { apiKey: { env: "FIREWORKS_API_KEY", name: "Fireworks API key" } },
    models: catalogModels("fireworks"),
    api: wires(["anthropic-messages", "openai-completions"], options),
  });
}
