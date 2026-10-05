import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Context, GoogleVertexOptions, Model } from "../types.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { createAccumulator, isAbort } from "./events.ts";
import { resolveAdcAccessToken } from "./google-adc.ts";
import { applyGoogleChunk, finishGoogle, googleBody } from "./google-shared.ts";
import { isRecord, postJson, prepareChat, readSse, terminal } from "./prepare.ts";

export const GOOGLE_VERTEX_API = "google-vertex";

export function googleVertexApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"google-vertex"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"google-vertex"> = {
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
  request: GoogleVertexOptions,
  stream: ReturnType<typeof createAssistantEventStream>,
): Promise<void> {
  const acc = createAccumulator(stream, model);
  let sent = false;
  try {
    const prepared = prepareChat(model, context, request, "Google Vertex");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    const payload = googleBody(model, prepared.prepared.context, prepared.prepared.outputCap, prepared.prepared.effort, request.thinkingLevel);
    const project = request.project || request.env?.GOOGLE_CLOUD_PROJECT || request.env?.GCLOUD_PROJECT;
    const location = request.location || request.env?.GOOGLE_CLOUD_LOCATION || "us-central1";
    const host = (request.baseUrl || `https://${location}-aiplatform.googleapis.com`).replace("{location}", location).replace(/\/$/, "");
    if (!project) {
      stream.push({ type: "error", error: terminal(model, "error", "Google Vertex request requires a project") });
      return;
    }
    const headers: Record<string, string> = { ...request.headers, "content-type": "application/json" };
    if (request.apiKey) headers["x-goog-api-key"] = request.apiKey;
    else {
      const path = request.env?.GOOGLE_APPLICATION_CREDENTIALS;
      const bearer = path ? await resolveAdcAccessToken({ path, fetch: fetchImpl, ...(request.signal ? { signal: request.signal } : {}) }) : undefined;
      if (!bearer) {
        stream.push({ type: "error", error: terminal(model, "error", "Google Vertex credentials could not be resolved") });
        return;
      }
      headers.authorization = `Bearer ${bearer}`;
    }
    const url = `${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;
    sent = true;
    const response = await postJson(
      fetchImpl,
      url,
      headers,
      payload,
      request.signal,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail("error", `Google Vertex ${response.status} ${classification.kind}: ${body.slice(0, 400)}`, classification.retryable, classification.overflow);
      return;
    }
    const finish = { reason: "", tools: 0 };
    await readSse(response, request.signal, ({ data }) => {
      if (acc.closed) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        acc.fail("error", "Google Vertex stream: malformed event");
        return;
      }
      if (!isRecord(decoded)) return;
      applyGoogleChunk(model, acc, decoded, finish);
    }, request.onActivity);
    if (acc.closed) return;
    finishGoogle(acc, finish.reason, "Google Vertex");
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}

