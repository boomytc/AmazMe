import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function vercelAIGatewayProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    auth: { apiKey: { env: "AI_GATEWAY_API_KEY", name: "Vercel AI Gateway API key" } },
    models: catalogModels("vercel-ai-gateway"),
    api: wires("anthropic-messages", options),
  });
}
