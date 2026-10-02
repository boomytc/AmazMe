import { OPENAI_COMPLETIONS_API, openaiCompletionsApi } from "../api/openai-completions.ts";
import { createProvider, ModelsError, type Provider } from "../models.ts";
import type { Model, ThinkingLevel } from "../types.ts";
import { modelLimitProblem } from "../utils/budget.ts";

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

/** OpenAI's catalog and auth. The request format is `api/openai-completions`, and the output cap is `max_completion_tokens`. */
export function openaiProvider(options: OpenAIProviderOptions = {}): Provider<"openai-completions"> {
  const listed = options.modelIds ?? Object.keys(options.models ?? {});
  const ids = listed.length > 0 ? listed : ["gpt-4o-mini"];
  const models: Model<"openai-completions">[] = ids.map((id) => catalogModel(id, options.models?.[id]));
  return createProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { env: "OPENAI_API_KEY" },
    models,
    api: openaiCompletionsApi({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      outputTokenField: "max_completion_tokens",
    }),
  });
}

function catalogModel(id: string, spec: OpenAIModelSpec | undefined): Model<"openai-completions"> {
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
