import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { BedrockOptions, Context, Message, Model } from "../types.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { payloadText, readAwsEventStream } from "./aws-event-stream.ts";
import { claudeThinkingFields } from "./claude-thinking.ts";
import { bearerFromEnv, resolveAwsChain } from "./aws-chain.ts";
import { signAwsRequest } from "./aws-sigv4.ts";
import { createAccumulator, isAbort, usageFromCounts } from "./events.ts";
import { isRecord, prepareChat, terminal } from "./prepare.ts";

export const BEDROCK_CONVERSE_STREAM_API = "bedrock-converse-stream";
const BEDROCK_ACCEPT = "application/vnd.amazon.eventstream";
const RETRYABLE_BEDROCK_EXCEPTIONS = new Set([
  "internalServerException",
  "serviceUnavailableException",
  "throttlingException",
  "modelStreamErrorException",
]);

/**
 * ConverseStream returns AWS event stream frames, not JSON SSE.
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
    const thinking = bedrockThinkingFields(model, prepared.prepared.outputCap, prepared.prepared.effort, request.thinkingLevel);
    const built = bedrockPayload(prepared.prepared.context, prepared.prepared.outputCap);
    if (!built.ok) {
      stream.push({ type: "error", error: terminal(model, "error", built.message) });
      return;
    }
    if (thinking) built.body.additionalModelRequestFields = thinking;
    const payload = JSON.stringify(built.body);
    const bearer = request.apiKey || bearerFromEnv(request.env ?? {});
    let headers: Record<string, string>;
    if (bearer) {
      headers = {
        ...request.headers,
        authorization: `Bearer ${bearer}`,
        accept: BEDROCK_ACCEPT,
        "content-type": "application/json",
      };
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
        headers: { ...request.headers, accept: BEDROCK_ACCEPT, "content-type": "application/json" },
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
    await readAwsEventStream(response, request.signal, (event) => {
      if (acc.closed) return;
      const messageType = event.headers[":message-type"] ?? "event";
      if (messageType === "exception" || messageType === "error") {
        const name = event.headers[":exception-type"] || event.headers[":error-code"] || messageType;
        const retryable = RETRYABLE_BEDROCK_EXCEPTIONS.has(name) || event.headers[":error-code"] === "429";
        acc.fail("error", `Bedrock converse stream: ${name}: ${payloadText(event.payload).slice(0, 300)}`, retryable);
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(event.payload)) as unknown;
      } catch {
        acc.fail("error", "Bedrock converse stream: malformed event");
        return;
      }
      if (!isRecord(decoded)) {
        acc.fail("error", "Bedrock converse stream: malformed event");
        return;
      }
      const eventType = event.headers[":event-type"];
      if (!eventType) {
        acc.fail("error", "Bedrock converse stream: missing event type");
        return;
      }
      applyBedrockEvent(model, acc, { [eventType]: decoded }, (reason) => { stop = reason; });
    });
    if (acc.closed) return;
    if (!stop) {
      acc.fail("error", "Bedrock converse stream ended without a stop reason");
      return;
    }
    const mapped = bedrockStop(stop);
    if (mapped === "error") {
      acc.fail("error", `Bedrock converse stream: ${stop}`);
      return;
    }
    acc.finish(mapped, stop === "model_context_window_exceeded");
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
    // inputTokens is already the cache miss. The cache counts sit beside it.
    const reported = usageFromCounts(
      model,
      numberOf(usage.inputTokens),
      numberOf(usage.outputTokens),
      numberOf(usage.totalTokens),
      { cacheRead: numberOf(usage.cacheReadInputTokens), cacheWrite: numberOf(usage.cacheWriteInputTokens) },
    );
    if (reported) acc.usage(reported);
  }
  const start = isRecord(decoded.contentBlockStart) ? decoded.contentBlockStart : undefined;
  const deltaWrap = isRecord(decoded.contentBlockDelta) ? decoded.contentBlockDelta : undefined;
  const index = numberOf(deltaWrap?.contentBlockIndex) ?? numberOf(start?.contentBlockIndex) ?? numberOf(decoded.contentBlockIndex) ?? 0;
  const startBody = start && isRecord(start.start) ? start.start : undefined;
  const toolStart = startBody && isRecord(startBody.toolUse) ? startBody.toolUse : undefined;
  if (toolStart) {
    acc.tool(`tool_${index}`, typeof toolStart.toolUseId === "string" ? toolStart.toolUseId : undefined, typeof toolStart.name === "string" ? toolStart.name : undefined, "");
  }
  const delta = deltaWrap && isRecord(deltaWrap.delta) ? deltaWrap.delta : undefined;
  if (delta) {
    if (typeof delta.text === "string") acc.text(delta.text, { key: `block_${index}` });
    const reasoning = isRecord(delta.reasoningContent) ? delta.reasoningContent : undefined;
    const reasoningText = reasoning && isRecord(reasoning.reasoningText) ? reasoning.reasoningText : undefined;
    const thought = reasoning && typeof reasoning.text === "string"
      ? reasoning.text
      : reasoningText && typeof reasoningText.text === "string"
        ? reasoningText.text
        : undefined;
    const signature = reasoning && typeof reasoning.signature === "string" ? reasoning.signature : reasoningText && typeof reasoningText.signature === "string" ? reasoningText.signature : undefined;
    if (thought || signature !== undefined) acc.thinking(thought ?? "", { key: `block_${index}`, ...(signature !== undefined ? { signature, appendSignature: true } : {}) });
    if (reasoning && typeof reasoning.redactedContent === "string") acc.thinking("", { key: `block_${index}`, signature: reasoning.redactedContent, appendSignature: true, redacted: true });
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

function bedrockPayload(context: Context, outputCap: number): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    const next = bedrockMessage(message);
    if (!next.ok) return next;
    const last = messages[messages.length - 1];
    if (last && last.role === next.message.role) last.content.push(...next.message.content);
    else messages.push(next.message);
  }
  const system = systemText(context);
  return {
    ok: true,
    body: {
      messages,
      inferenceConfig: { maxTokens: outputCap },
      ...(system ? { system: [{ text: system }] } : {}),
      ...(context.tools && context.tools.length > 0
        ? { toolConfig: { tools: context.tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } })) } }
        : {}),
    },
  };
}

function systemText(context: Context): string {
  const prompt = context.systemPrompt ?? "";
  const parts: string[] = [];
  const leading = context.messages[0];
  if (prompt && !(leading?.role === "system" && leading.content === prompt)) parts.push(prompt);
  for (const message of context.messages) {
    if (message.role === "system") parts.push(message.content);
  }
  return parts.join("\n");
}

function bedrockMessage(message: Message):
  | { ok: true; message: { role: "user" | "assistant"; content: unknown[] } }
  | { ok: false; message: string } {
  if (message.role === "user") {
    if (typeof message.content === "string") return { ok: true, message: { role: "user", content: [{ text: message.content }] } };
    const content: unknown[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ text: block.text });
        continue;
      }
      const format = bedrockImageFormat(block.mimeType);
      if (!format) return { ok: false, message: "Bedrock converse does not accept this image format" };
      content.push({ image: { format, source: { bytes: block.data } } });
    }
    return { ok: true, message: { role: "user", content } };
  }
  if (message.role === "assistant") {
    const content: unknown[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ text: block.text });
      else if (block.type === "thinking") {
        if (block.redacted && block.thinkingSignature) content.push({ reasoningContent: { redactedContent: block.thinkingSignature } });
        else if (block.thinkingSignature) content.push({ reasoningContent: { reasoningText: { text: block.thinking, signature: block.thinkingSignature } } });
        else if (block.thinking) content.push({ text: block.thinking });
      }
      else content.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.arguments ?? {} } });
    }
    return { ok: true, message: { role: "assistant", content } };
  }
  if (message.role === "toolResult") {
    const content: unknown[] = [];
    if (message.content.some((block) => block.type === "image")) {
      for (const block of message.content) {
        if (block.type === "text") {
          content.push({ text: block.text });
          continue;
        }
        const format = bedrockImageFormat(block.mimeType);
        if (!format) return { ok: false, message: "Bedrock converse does not accept this image format" };
        content.push({ image: { format, source: { bytes: block.data } } });
      }
    } else {
      content.push({ text: message.content.map((block) => block.type === "text" ? block.text : "").join("") });
    }
    return {
      ok: true,
      message: {
        role: "user",
        content: [{
          toolResult: {
            toolUseId: message.toolCallId,
            content,
            ...(message.isError ? { status: "error" } : {}),
          },
        }],
      },
    };
  }
  return { ok: true, message: { role: "user", content: [{ text: message.content }] } };
}

function bedrockImageFormat(mimeType: string): "png" | "jpeg" | "gif" | "webp" | undefined {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpeg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return undefined;
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_MessageStopEvent.html */
function bedrockStop(reason: string): "stop" | "length" | "toolUse" | "error" {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens" || reason === "length" || reason === "model_context_window_exceeded") return "length";
  if (reason === "tool_use" || reason === "toolUse") return "toolUse";
  return "error";
}

function bedrockRegion(url: URL, requested: string | undefined, fromChain: string): string {
  const host = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/i.exec(url.hostname);
  return host?.[1] ?? requested ?? fromChain;
}

/** Bedrock requires model-specific fields; a reasoning flag alone cannot select a wire. */
function bedrockThinkingFields(model: Model, outputCap: number, effort: string | undefined, requested: BedrockOptions["thinkingLevel"]): Record<string, unknown> | undefined {
  if (requested === undefined && effort === undefined) return undefined;
  if (!model.reasoning) return undefined;
  const id = model.id.toLowerCase();
  if (id.includes("anthropic.claude")) return claudeThinkingFields(model, outputCap, effort, requested);
  if (id.includes("amazon.nova-2-lite")) {
    if (requested === "off") return { reasoningConfig: { type: "disabled" } };
    const level = effort?.toLowerCase();
    if (level === "high") throw new Error("Nova high thinking does not support a bounded output cap");
    if (level !== "low" && level !== "medium") throw new Error(`Unsupported Nova thinking level ${effort}`);
    return { reasoningConfig: { type: "enabled", maxReasoningEffort: level } };
  }
  throw new Error(`Bedrock thinking control is not implemented for ${model.id}`);
}
