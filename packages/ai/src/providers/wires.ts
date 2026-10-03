import { anthropicMessagesApi } from "../api/anthropic-messages.ts";
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.ts";
import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.ts";
import { googleVertexApi } from "../api/google-vertex.ts";
import { mistralConversationsApi } from "../api/mistral-conversations.ts";
import { openaiCompletionsApi } from "../api/openai-completions.ts";
import { openAICodexResponsesApi } from "../api/openai-codex-responses.ts";
import { openAIResponsesApi } from "../api/openai-responses.ts";
import { piMessagesApi } from "../api/pi-messages.ts";
import type { ProviderStreams } from "../models.ts";
import type { KnownApi } from "../types.ts";

export interface WireOptions {
  fetch?: typeof fetch;
  /** Compatible endpoints send `max_tokens`. Official OpenAI completions stays on `max_completion_tokens`. */
  completionsField?: "max_tokens" | "max_completion_tokens";
  wrap?: (streams: ProviderStreams) => ProviderStreams;
}

export function wires(api: KnownApi, options?: WireOptions): ProviderStreams;
export function wires(apis: readonly KnownApi[], options?: WireOptions): Partial<Record<KnownApi, ProviderStreams>>;
export function wires(apiOrApis: KnownApi | readonly KnownApi[], options: WireOptions = {}): ProviderStreams | Partial<Record<KnownApi, ProviderStreams>> {
  const apis = typeof apiOrApis === "string" ? [apiOrApis] : apiOrApis;
  const table: Partial<Record<KnownApi, ProviderStreams>> = {};
  for (const api of apis) {
    const created = createApi(api, options);
    table[api] = options.wrap ? options.wrap(created) : created;
  }
  if (typeof apiOrApis === "string") {
    const single = table[apiOrApis];
    if (!single) throw new Error(`No wire for ${apiOrApis}`);
    return single;
  }
  return table;
}

function createApi(api: KnownApi, options: WireOptions): ProviderStreams {
  const fetch = options.fetch ? { fetch: options.fetch } : {};
  switch (api) {
    case "openai-completions":
      return openaiCompletionsApi({ ...fetch, outputTokenField: options.completionsField ?? "max_tokens" });
    case "openai-responses":
      return openAIResponsesApi(fetch);
    case "azure-openai-responses":
      return azureOpenAIResponsesApi(fetch);
    case "openai-codex-responses":
      return openAICodexResponsesApi(fetch);
    case "anthropic-messages":
      return anthropicMessagesApi(fetch);
    case "google-generative-ai":
      return googleGenerativeAIApi(fetch);
    case "google-vertex":
      return googleVertexApi(fetch);
    case "bedrock-converse-stream":
      return bedrockConverseStreamApi(fetch);
    case "mistral-conversations":
      return mistralConversationsApi(fetch);
    case "pi-messages":
      return piMessagesApi(fetch);
    default:
      throw new Error(`No wire for ${api}`);
  }
}
