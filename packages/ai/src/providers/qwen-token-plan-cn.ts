import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function qwenTokenPlanCnProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "qwen-token-plan-cn",
    name: "Qwen Token Plan CN",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    auth: { apiKey: { env: "QWEN_TOKEN_PLAN_CN_API_KEY", name: "Qwen Token Plan CN API key" } },
    models: catalogModels("qwen-token-plan-cn"),
    api: wires("openai-completions", options),
  });
}
