import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function minimaxCnProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "minimax-cn",
    name: "MiniMax CN",
    baseUrl: "https://api.minimaxi.com/anthropic",
    auth: { apiKey: { env: "MINIMAX_CN_API_KEY", name: "MiniMax CN API key" } },
    models: catalogModels("minimax-cn"),
    api: wires("anthropic-messages", options),
  });
}
