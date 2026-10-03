import { OPENAI_COMPLETIONS_API, openaiCompletionsApi } from "../api/openai-completions.ts";
import { openAIResponsesApi } from "../api/openai-responses.ts";
import { chatgptOAuth } from "../auth/oauth/flows.ts";
import { createProvider, ModelsError, type Provider } from "../models.ts";
import type { Model, ThinkingLevel } from "../types.ts";
import { modelLimitProblem } from "../utils/budget.ts";
import { catalogModels } from "./catalog.ts";

export interface OpenAIModelSpec {
  contextWindow: number;
  maxTokens: number;
  input?: Array<"text" | "image">;
  /** Omitted cost stays 0 for a custom id. A verified id keeps its known rate unless this is set. */
  cost?: { input: number; output: number };
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface OpenAIProviderOptions {
  modelIds?: string[];
  /** Explicit limits for ids that are not in the verified catalog, or overrides for ids that are. */
  models?: Record<string, OpenAIModelSpec>;
  fetch?: typeof fetch;
}

const VERIFIED: Record<string, { contextWindow: number; maxTokens: number; input: Array<"text" | "image">; cost: { input: number; output: number } }> = {
  "gpt-4o-mini": {
    contextWindow: 128_000,
    maxTokens: 16_384,
    input: ["text"],
    cost: { input: 0.15, output: 0.6 },
  },
};

/**
 * OpenAI preset.
 * `gpt-4o-mini` stays on `openai-completions` with text-only input so the verified completions
 * fixtures keep their wire. The rest of the chat catalog uses `openai-responses`.
 * Passing `modelIds` or `models` keeps the completions-only constructor those fixtures call.
 */
export function openaiProvider(options: OpenAIProviderOptions = {}): Provider {
  const fetch = options.fetch ? { fetch: options.fetch } : {};
  const explicit = options.modelIds !== undefined || options.models !== undefined;
  if (explicit) {
    const listed = options.modelIds ?? Object.keys(options.models ?? {});
    const ids = listed.length > 0 ? listed : ["gpt-4o-mini"];
    return createProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { env: "OPENAI_API_KEY" },
      models: ids.map((id) => completionsModel(id, options.models?.[id])),
      api: openaiCompletionsApi({ ...fetch, outputTokenField: "max_completion_tokens" }),
    });
  }
  const responses = catalogModels("openai").filter((model) => model.id !== "gpt-4o-mini");
  return createProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: {
      apiKey: { env: "OPENAI_API_KEY", name: "OpenAI API key" },
      oauth: chatgptOAuth(options.fetch),
    },
    models: [completionsModel("gpt-4o-mini"), ...responses],
    api: {
      "openai-completions": openaiCompletionsApi({ ...fetch, outputTokenField: "max_completion_tokens" }),
      "openai-responses": openAIResponsesApi(fetch),
    },
  });
}

function completionsModel(id: string, spec?: OpenAIModelSpec): Model<"openai-completions"> {
  const verified = VERIFIED[id];
  if (!spec && !verified) {
    throw new ModelsError(
      "model",
      `Model "${id}" needs contextWindow and maxTokens. Unknown OpenAI models do not inherit gpt-4o-mini limits.`,
    );
  }
  const contextWindow = spec?.contextWindow ?? verified?.contextWindow ?? 0;
  const maxTokens = spec?.maxTokens ?? verified?.maxTokens ?? 0;
  const problem = modelLimitProblem(contextWindow, maxTokens, `Model "${id}"`);
  if (problem) throw new ModelsError("model", problem);
  return {
    id,
    name: id,
    provider: "openai",
    api: OPENAI_COMPLETIONS_API,
    input: spec?.input ?? verified?.input ?? ["text"],
    contextWindow,
    maxTokens,
    cost: spec?.cost ?? verified?.cost ?? { input: 0, output: 0 },
    ...(spec?.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
    ...(spec?.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
  };
}
