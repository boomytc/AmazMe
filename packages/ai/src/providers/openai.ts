import type { Provider } from "../models.ts";
import { completionsProvider } from "./completions.ts";

export interface OpenAIProviderOptions {
  modelIds?: string[];
  fetch?: typeof fetch;
}

/** OpenAI's catalog and auth. The request format is `api/openai-completions`. */
export function openaiProvider(options: OpenAIProviderOptions = {}): Provider {
  return completionsProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
    modelIds: options.modelIds ?? ["gpt-4o-mini"],
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
