import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Model, OpenAICodexResponsesOptions } from "../types.ts";
import { pumpResponses } from "./openai-responses.ts";

export const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** Codex speaks the responses event stream at `{base}/codex/responses`. Subscription OAuth only. */
export function openAICodexResponsesApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"openai-codex-responses"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"openai-codex-responses"> = {
    stream(model, context, request) {
      const stream = createAssistantEventStream();
      void pumpResponses(fetchImpl, model, context, request ?? {}, stream, codexUrl, codexHeaders);
      return stream;
    },
    streamSimple(model, context, request) {
      return streams.stream(model, context, request);
    },
  };
  return streams;
}

export function codexUrl(model: Model, request: OpenAICodexResponsesOptions): string {
  void model;
  const base = (request.baseUrl || CODEX_BASE_URL).replace(/\/$/, "");
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

function codexHeaders(request: OpenAICodexResponsesOptions): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.apiKey}`,
    "OpenAI-Beta": "responses=experimental",
  };
  const account = request.env?.CHATGPT_ACCOUNT_ID;
  if (account) headers["chatgpt-account-id"] = account;
  return headers;
}
