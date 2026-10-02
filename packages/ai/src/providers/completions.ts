import { OPENAI_COMPLETIONS_API, openaiCompletionsApi } from "../api/openai-completions.ts";
import { createProvider, ModelsError, type Provider } from "../models.ts";
import type { CompletionsOutputTokenField, Model, ThinkingLevel } from "../types.ts";
import { modelLimitProblem } from "../utils/budget.ts";

export interface CompletionsModelSpec {
  contextWindow: number;
  maxTokens: number;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number };
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface CompletionsProviderOptions {
  id: string;
  name: string;
  baseUrl: string;
  env: string;
  modelIds?: string[];
  /** Per-id limits. Ids without an entry use the provider-level contextWindow and maxTokens. */
  models?: Record<string, CompletionsModelSpec>;
  fetch?: typeof fetch;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number };
  /**
   * Compatible endpoints send `max_tokens`. Official OpenAI is `openaiProvider`, which sends
   * `max_completion_tokens`. A request can still override this field.
   */
  outputTokenField?: CompletionsOutputTokenField;
}

/**
 * A provider that speaks Chat Completions. The wire lives in `api/openai-completions`;
 * this only binds a catalog, an auth env var, and a base URL to that wire.
 * Every model needs an explicit context window and output cap. There is no inherited default.
 */
export function completionsProvider(options: CompletionsProviderOptions): Provider<"openai-completions"> {
  const field = options.outputTokenField ?? "max_tokens";
  const ids = options.modelIds ?? Object.keys(options.models ?? {});
  if (ids.length === 0) throw new ModelsError("model", `completions provider ${options.id} requires modelIds or models`);
  const models: Model<"openai-completions">[] = ids.map((id) => catalogModel(options, id));
  return createProvider({
    id: options.id,
    name: options.name,
    baseUrl: options.baseUrl,
    auth: { env: options.env },
    models,
    api: openaiCompletionsApi({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      outputTokenField: field,
    }),
  });
}

function catalogModel(options: CompletionsProviderOptions, id: string): Model<"openai-completions"> {
  const spec = options.models?.[id];
  const contextWindow = spec?.contextWindow ?? options.contextWindow;
  const maxTokens = spec?.maxTokens ?? options.maxTokens;
  if (contextWindow === undefined || maxTokens === undefined) {
    throw new ModelsError(
      "model",
      `Model "${id}" needs contextWindow and maxTokens. Completions models do not inherit a default window.`,
    );
  }
  const problem = modelLimitProblem(contextWindow, maxTokens, `Model "${id}"`);
  if (problem) throw new ModelsError("model", problem);
  return {
    id,
    name: id,
    provider: options.id,
    api: OPENAI_COMPLETIONS_API,
    input: spec?.input ?? options.input ?? ["text"],
    contextWindow,
    maxTokens,
    cost: spec?.cost ?? options.cost ?? { input: 0, output: 0 },
    ...(spec?.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
    ...(spec?.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
  };
}
