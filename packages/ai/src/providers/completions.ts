import { OPENAI_COMPLETIONS_API, openaiCompletionsApi } from "../api/openai-completions.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

export interface CompletionsProviderOptions {
  id: string;
  name: string;
  baseUrl: string;
  env: string;
  modelIds: string[];
  fetch?: typeof fetch;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number };
}

/**
 * A provider that speaks Chat Completions. The wire lives in `api/openai-completions`;
 * this only binds a catalog, an auth env var, and a base URL to that wire.
 */
export function completionsProvider(options: CompletionsProviderOptions): Provider<"openai-completions"> {
  const api = openaiCompletionsApi(options.fetch ? { fetch: options.fetch } : {});
  const models: Model<"openai-completions">[] = options.modelIds.map((modelId) => ({
    id: modelId,
    name: modelId,
    provider: options.id,
    api: OPENAI_COMPLETIONS_API,
    input: ["text"],
    contextWindow: options.contextWindow ?? 128_000,
    maxTokens: options.maxTokens ?? 16_384,
    cost: options.cost ?? { input: 0.15, output: 0.6 },
  }));
  return createProvider({
    id: options.id,
    name: options.name,
    baseUrl: options.baseUrl,
    auth: { env: options.env },
    models,
    api,
  });
}
