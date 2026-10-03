import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function xiaomiTokenPlanCnProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "xiaomi-token-plan-cn",
    name: "Xiaomi Token Plan CN",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    auth: { apiKey: { env: "XIAOMI_TOKEN_PLAN_CN_API_KEY", name: "Xiaomi Token Plan CN API key" } },
    models: catalogModels("xiaomi-token-plan-cn"),
    api: wires("openai-completions", options),
  });
}
