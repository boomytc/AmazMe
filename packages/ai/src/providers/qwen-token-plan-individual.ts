import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function qwenTokenPlanIndividualProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "qwen-token-plan-individual",
    name: "Qwen Token Plan Individual",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    auth: { apiKey: { env: "QWEN_TOKEN_PLAN_API_KEY", name: "Qwen Token Plan Individual API key" } },
    models: catalogModels("qwen-token-plan-individual"),
    api: wires("openai-completions", options),
  });
}
