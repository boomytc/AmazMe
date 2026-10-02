import { OPENAI_COMPLETIONS_API, openaiCompletionsApi } from "../api/openai-completions.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

export interface OpenAIProviderOptions {
  modelIds?: string[];
  fetch?: typeof fetch;
}

/** OpenAI's catalog and auth. The request format is `api/openai-completions`. */
export function openaiProvider(options: OpenAIProviderOptions = {}): Provider<"openai-completions"> {
  const models: Model<"openai-completions">[] = (options.modelIds ?? ["gpt-4o-mini"]).map((id) => ({
    id,
    name: id,
    provider: "openai",
    api: OPENAI_COMPLETIONS_API,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: id === "gpt-4o-mini" ? { input: 0.15, output: 0.6 } : { input: 0, output: 0 },
  }));
  return createProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { env: "OPENAI_API_KEY" },
    models,
    api: openaiCompletionsApi(options.fetch ? { fetch: options.fetch } : {}),
  });
}
