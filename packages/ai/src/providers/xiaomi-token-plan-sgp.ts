import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function xiaomiTokenPlanSgpProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "xiaomi-token-plan-sgp",
    name: "Xiaomi Token Plan SGP",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    auth: { apiKey: { env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", name: "Xiaomi Token Plan SGP API key" } },
    models: catalogModels("xiaomi-token-plan-sgp"),
    api: wires("openai-completions", options),
  });
}
