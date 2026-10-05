import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

// Models & Pricing, Model Details, deepseek-flash, CONTEXT LENGTH: 1M.
// https://api-docs.deepseek.com/quick_start/pricing
// The same window is written as 1000000 in the agent example, not 1048576.
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
const FLASH_CONTEXT_WINDOW = 1_000_000;

// Chat Completions, Request, max_tokens: between 1 and 384K (393216).
// https://api-docs.deepseek.com/api/create-chat-completion
// Models & Pricing, Model Details, deepseek-flash, MAX OUTPUT: MAXIMUM 384K.
// https://api-docs.deepseek.com/quick_start/pricing
const FLASH_MAX_OUTPUT = 393_216;

export function deepseekProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    auth: { apiKey: { env: "DEEPSEEK_API_KEY", name: "DeepSeek API key" } },
    models: catalogModels("deepseek").map((model) => model.id === "deepseek-flash"
      ? { ...model, contextWindow: FLASH_CONTEXT_WINDOW, maxTokens: FLASH_MAX_OUTPUT }
      : model),
    api: wires("openai-completions", options),
  });
}
