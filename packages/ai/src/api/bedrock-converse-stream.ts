import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { BedrockOptions, Context, Model } from "../types.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { bearerFromEnv, resolveAwsChain } from "./aws-chain.ts";
import { signAwsRequest } from "./aws-sigv4.ts";
import { createAccumulator, isAbort, usageFromCounts } from "./events.ts";
import { isRecord, prepareChat, readSse, terminal } from "./prepare.ts";

export const BEDROCK_CONVERSE_STREAM_API = "bedrock-converse-stream";

/**
 * Converse stream as JSON SSE, authenticated before the request is sent.
 * A bearer token is sent as Bearer. Otherwise the AWS chain is resolved and the
 * same request is signed with Signature V4. Resolution failure does not send it.
 */
export function bedrockConverseStreamApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"bedrock-converse-stream"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"bedrock-converse-stream"> = {
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
  request: BedrockOptions,
  stream: ReturnType<typeof createAssistantEventStream>,
): Promise<void> {
  const acc = createAccumulator(stream, model);
  let sent = false;
  try {
    const prepared = prepareChat(model, context, request, "Bedrock converse");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    const root = (request.baseUrl ?? "").replace(/\/$/, "");
    const url = new URL(`${root}/model/${encodeURIComponent(model.id)}/converse-stream`);
    const payload = JSON.stringify({
      messages: prepared.prepared.context.messages.filter((message) => message.role !== "system").map(bedrockMessage),
      inferenceConfig: { maxTokens: prepared.prepared.outputCap },
      ...(prepared.prepared.context.tools && prepared.prepared.context.tools.length > 0
        ? { toolConfig: { tools: prepared.prepared.context.tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } })) } }
        : {}),
    });
    const bearer = request.apiKey || bearerFromEnv(request.env ?? {});
    let headers: Record<string, string>;
    if (bearer) {
      headers = { ...request.headers, authorization: `Bearer ${bearer}`, "content-type": "application/json" };
    } else {
      const credentials = await resolveAwsChain({ env: request.env ?? {}, fetch: fetchImpl, ...(request.signal ? { signal: request.signal } : {}) });
      if (!credentials) {
        stream.push({ type: "error", error: terminal(model, "error", "Bedrock credentials could not be resolved") });
        return;
      }
      const signed = signAwsRequest({
        method: "POST",
        url,
        body: payload,
        region: bedrockRegion(url, request.region, credentials.region),
        service: "bedrock",
        credentials,
        headers: { ...request.headers, "content-type": "application/json" },
      });
      headers = signed.headers;
    }
    sent = true;
    const response = await fetchImpl(url, { method: "POST", headers, body: payload, signal: request.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail("error", `Bedrock converse ${response.status} ${classification.kind}: ${body.slice(0, 400)}`, classification.retryable, classification.overflow);
      return;
    }
    let stop = "";
    await readSse(response, request.signal, ({ data }) => {
      if (acc.closed || data === "[DONE]") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        acc.fail("error", "Bedrock converse stream: malformed event");
        return;
      }
      if (!isRecord(decoded)) return;
      applyBedrockEvent(model, acc, decoded, (reason) => { stop = reason; });
    });
    if (acc.closed) return;
    if (!stop) {
      acc.fail("error", "Bedrock converse stream ended without a stop reason");
      return;
    }
    acc.finish(stop === "max_tokens" || stop === "length" ? "length" : stop === "tool_use" || stop === "toolUse" ? "toolUse" : "stop");
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}

function applyBedrockEvent(
  model: Model,
  acc: ReturnType<typeof createAccumulator>,
  decoded: Record<string, unknown>,
  setStop: (reason: string) => void,
): void {
  const metadata = isRecord(decoded.metadata) ? decoded.metadata : undefined;
  const usage = metadata && isRecord(metadata.usage) ? metadata.usage : isRecord(decoded.usage) ? decoded.usage : undefined;
  if (usage) {
    const reported = usageFromCounts(model, numberOf(usage.inputTokens), numberOf(usage.outputTokens), numberOf(usage.totalTokens));
    if (reported) acc.usage(reported);
  }
  const index = typeof decoded.contentBlockIndex === "number" ? decoded.contentBlockIndex : 0;
  const start = isRecord(decoded.contentBlockStart) ? decoded.contentBlockStart : undefined;
  const startBody = start && isRecord(start.start) ? start.start : undefined;
  const toolStart = startBody && isRecord(startBody.toolUse) ? startBody.toolUse : undefined;
  if (toolStart) {
    acc.tool(`tool_${index}`, typeof toolStart.toolUseId === "string" ? toolStart.toolUseId : undefined, typeof toolStart.name === "string" ? toolStart.name : undefined, "");
  }
  const deltaWrap = isRecord(decoded.contentBlockDelta) ? decoded.contentBlockDelta : undefined;
  const delta = deltaWrap && isRecord(deltaWrap.delta) ? deltaWrap.delta : undefined;
  if (delta) {
    if (typeof delta.text === "string") acc.text(delta.text);
    const reasoning = isRecord(delta.reasoningContent) ? delta.reasoningContent : undefined;
    if (reasoning && typeof reasoning.text === "string") acc.thinking(reasoning.text);
    const toolDelta = isRecord(delta.toolUse) ? delta.toolUse : undefined;
    if (toolDelta && typeof toolDelta.input === "string") acc.tool(`tool_${index}`, undefined, undefined, toolDelta.input);
  }
  const messageStop = isRecord(decoded.messageStop) ? decoded.messageStop : undefined;
  const reason = typeof messageStop?.stopReason === "string"
    ? messageStop.stopReason
    : typeof decoded.stopReason === "string"
      ? decoded.stopReason
      : undefined;
  if (reason) setStop(reason);
}

function bedrockMessage(message: Context["messages"][number]): unknown {
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join("");
    return { role: "user", content: [{ text }] };
  }
  if (message.role === "assistant") {
    const content: unknown[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ text: block.text });
      else if (block.type === "thinking") content.push({ reasoningContent: { reasoningText: { text: block.thinking } } });
      else content.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.arguments ?? {} } });
    }
    return { role: "assistant", content };
  }
  if (message.role === "toolResult") {
    return { role: "user", content: [{ toolResult: { toolUseId: message.toolCallId, content: [{ text: message.content.map((block) => block.text).join("") }] } }] };
  }
  return { role: "user", content: [{ text: message.content }] };
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bedrockRegion(url: URL, requested: string | undefined, fromChain: string): string {
  const host = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/i.exec(url.hostname);
  return host?.[1] ?? requested ?? fromChain;
}
