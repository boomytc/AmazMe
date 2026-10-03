import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function zaiCodingCnProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "zai-coding-cn",
    name: "Z.AI Coding CN",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    auth: { apiKey: { env: "ZAI_CODING_CN_API_KEY", name: "Z.AI Coding CN API key" } },
    models: catalogModels("zai-coding-cn"),
    api: wires("openai-completions", options),
  });
}
