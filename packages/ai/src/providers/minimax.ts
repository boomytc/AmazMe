import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function minimaxProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.io/anthropic",
    auth: { apiKey: { env: "MINIMAX_API_KEY", name: "MiniMax API key" } },
    models: catalogModels("minimax"),
    api: wires("anthropic-messages", options),
  });
}
