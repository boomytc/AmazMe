import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function xiaomiTokenPlanAmsProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "xiaomi-token-plan-ams",
    name: "Xiaomi Token Plan AMS",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    auth: { apiKey: { env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", name: "Xiaomi Token Plan AMS API key" } },
    models: catalogModels("xiaomi-token-plan-ams"),
    api: wires("openai-completions", options),
  });
}
