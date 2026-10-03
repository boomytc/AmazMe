import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Context, Model, StreamOptions } from "../types.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { createAccumulator, isAbort } from "./events.ts";
import { applyGoogleChunk, googleBody, googleStop } from "./google-shared.ts";
import { isRecord, postJson, prepareChat, readSse, terminal } from "./prepare.ts";

export const GOOGLE_GENERATIVE_AI_API = "google-generative-ai";

export function googleGenerativeAIApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"google-generative-ai"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"google-generative-ai"> = {
    stream(model, context, request) {
      const stream = createAssistantEventStream();
      void pump(fetchImpl, model, context, request ?? {}, stream);
      return stream;
    },
    streamSimple(model, context, request) {
      return streams.stream(model, context, request);
    },
  };
  return streams;
}

async function pump(
  fetchImpl: typeof fetch,
  model: Model,
  context: Context,
  request: StreamOptions,
  stream: ReturnType<typeof createAssistantEventStream>,
): Promise<void> {
  const acc = createAccumulator(stream, model);
  let sent = false;
  try {
    const prepared = prepareChat(model, context, request, "Google generative AI");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    if (!request.apiKey) {
      stream.push({ type: "error", error: terminal(model, "error", "Google generative AI request requires apiKey") });
      return;
    }
    const url = `${request.baseUrl?.replace(/\/$/, "")}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;
    const headers = {
      ...request.headers,
      "x-goog-api-key": request.apiKey,
      "content-type": "application/json",
    };
    sent = true;
    const response = await postJson(
      fetchImpl,
      url,
      headers,
      googleBody(model, prepared.prepared.context, prepared.prepared.outputCap, prepared.prepared.effort),
      request.signal,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail("error", `Google generative AI ${response.status} ${classification.kind}: ${body.slice(0, 400)}`, classification.retryable, classification.overflow);
      return;
    }
    const finish = { reason: "" };
    await readSse(response, request.signal, ({ data }) => {
      if (acc.closed) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        acc.fail("error", "Google generative AI stream: malformed event");
        return;
      }
      if (!isRecord(decoded)) {
        acc.fail("error", "Google generative AI stream: malformed event");
        return;
      }
      applyGoogleChunk(model, acc, decoded, finish);
    });
    if (acc.closed) return;
    if (!finish.reason) {
      acc.fail("error", "Google generative AI stream ended without a finish reason");
      return;
    }
    acc.finish(googleStop(finish.reason));
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}
