import { claudeThinkingFields } from "./claude-thinking.ts";
import { readFile } from "node:fs/promises";
import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Context, Message, Model } from "../types.ts";
import { messageText } from "../transform.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { createAccumulator, isAbort, usageFromCounts } from "./events.ts";
import { isRecord, postJson, prepareChat, readSse, terminal } from "./prepare.ts";

export const ANTHROPIC_MESSAGES_API = "anthropic-messages";

export function anthropicMessagesApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"anthropic-messages"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"anthropic-messages"> = {
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
  request: import("../types.ts").StreamOptions,
  stream: ReturnType<typeof createAssistantEventStream>,
): Promise<void> {
  const acc = createAccumulator(stream, model);
  let sent = false;
  try {
    const prepared = prepareChat(model, context, request, "Anthropic messages");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    const headers: Record<string, string> = {
      ...request.headers,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    const key = await anthropicKey(request);
    if (!key && !hasAuthorization(headers)) {
      stream.push({ type: "error", error: terminal(model, "error", "Anthropic messages request requires apiKey") });
      return;
    }
    if (key && !hasAuthorization(headers)) headers["x-api-key"] = key;
    const system = systemText(prepared.prepared.context);
    const thinking = claudeThinkingFields(model, prepared.prepared.outputCap, prepared.prepared.effort, request.thinkingLevel);
    const payload: Record<string, unknown> = {
      model: model.id,
      max_tokens: prepared.prepared.outputCap,
      stream: true,
      messages: toAnthropicMessages(prepared.prepared.context),
    };
    if (system) payload.system = system;
    if (thinking) Object.assign(payload, thinking);
    if (prepared.prepared.context.tools && prepared.prepared.context.tools.length > 0) {
      payload.tools = prepared.prepared.context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    sent = true;
    const response = await postJson(
      fetchImpl,
      `${request.baseUrl?.replace(/\/$/, "")}/v1/messages`,
      headers,
      payload,
      request.signal,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail("error", `Anthropic messages ${response.status} ${classification.kind}: ${body.slice(0, 400)}`, classification.retryable, classification.overflow);
      return;
    }
    let stop = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const toolKeys = new Map<number, string>();
    const reportUsage = () => {
      const reported = usageFromCounts(model, inputTokens, outputTokens, undefined);
      if (reported) acc.usage(reported);
    };
    await readSse(response, request.signal, ({ data }) => {
      if (acc.closed) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        acc.fail("error", "Anthropic messages stream: malformed event");
        return;
      }
      if (!isRecord(decoded)) return;
      if (decoded.type === "content_block_start" && isRecord(decoded.content_block)) {
        const index = typeof decoded.index === "number" ? decoded.index : toolKeys.size;
        const block = decoded.content_block;
        if (block.type === "text" && typeof block.text === "string") acc.text(block.text, { key: `block_${index}` });
        if (block.type === "thinking") acc.thinking(typeof block.thinking === "string" ? block.thinking : "", { key: `block_${index}`, signature: typeof block.signature === "string" ? block.signature : "" });
        if (block.type === "redacted_thinking" && typeof block.data === "string") acc.thinking("", { key: `block_${index}`, signature: block.data, redacted: true });
        if (block.type === "tool_use") {
          const key = `tool_${index}`;
          toolKeys.set(index, key);
          acc.tool(key, typeof block.id === "string" ? block.id : undefined, typeof block.name === "string" ? block.name : undefined, "");
        }
      }
      if (decoded.type === "content_block_delta" && isRecord(decoded.delta)) {
        const delta = decoded.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") acc.text(delta.text, { key: `block_${typeof decoded.index === "number" ? decoded.index : 0}` });
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") acc.thinking(delta.thinking, { key: `block_${typeof decoded.index === "number" ? decoded.index : 0}` });
        if (delta.type === "signature_delta" && typeof delta.signature === "string") acc.thinking("", { key: `block_${typeof decoded.index === "number" ? decoded.index : 0}`, signature: delta.signature, appendSignature: true });
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const index = typeof decoded.index === "number" ? decoded.index : 0;
          const key = toolKeys.get(index) ?? `tool_${index}`;
          acc.tool(key, undefined, undefined, delta.partial_json);
        }
      }
      if (decoded.type === "message_delta" && isRecord(decoded.delta)) {
        if (typeof decoded.delta.stop_reason === "string") stop = decoded.delta.stop_reason;
        const usage = isRecord(decoded.usage) ? decoded.usage : undefined;
        const output = numberOf(usage?.output_tokens);
        if (output !== undefined) {
          outputTokens = output;
          reportUsage();
        }
      }
      if (decoded.type === "message_start" && isRecord(decoded.message) && isRecord(decoded.message.usage)) {
        const input = numberOf(decoded.message.usage.input_tokens);
        const output = numberOf(decoded.message.usage.output_tokens);
        if (input !== undefined) inputTokens = input;
        if (output !== undefined) outputTokens = output;
        if (input !== undefined || output !== undefined) reportUsage();
      }
      if (decoded.type === "error") {
        acc.fail("error", `Anthropic messages stream: ${JSON.stringify(decoded.error ?? decoded).slice(0, 400)}`);
      }
    });
    if (acc.closed) return;
    if (!stop) {
      acc.fail("error", "Anthropic messages stream ended without a stop reason");
      return;
    }
    const mapped = anthropicStop(stop);
    if (mapped === "error") {
      acc.fail("error", `Anthropic messages stream: ${stop}`);
      return;
    }
    acc.finish(mapped, stop === "model_context_window_exceeded");
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}

/** https://docs.anthropic.com/en/api/messages — stop_reason */
function anthropicStop(reason: string): "stop" | "length" | "toolUse" | "error" {
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "stop";
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "tool_use") return "toolUse";
  return "error";
}

async function anthropicKey(request: import("../types.ts").StreamOptions): Promise<string | undefined> {
  if (request.apiKey) return request.apiKey;
  const file = request.env?.ANTHROPIC_IDENTITY_TOKEN_FILE;
  if (!file) return undefined;
  try {
    const text = (await readFile(file, "utf8")).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function systemText(context: Context): string {
  const prompt = context.systemPrompt ?? "";
  const leading = context.messages[0];
  const parts: string[] = [];
  if (prompt && !(leading?.role === "system" && leading.content === prompt)) parts.push(prompt);
  for (const message of context.messages) {
    if (message.role === "system") parts.push(message.content);
  }
  return parts.join("\n");
}

function toAnthropicMessages(context: Context): unknown[] {
  const messages: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    messages.push(convert(message));
  }
  return messages;
}

function convert(message: Message): unknown {
  if (message.role === "user") {
    if (typeof message.content === "string") return { role: "user", content: [{ type: "text", text: message.content }] };
    return {
      role: "user",
      content: message.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: messageText(message), is_error: message.isError }],
    };
  }
  if (message.role !== "assistant") return { role: "user", content: [{ type: "text", text: message.content }] };
  const content: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "thinking") {
      if (block.redacted && block.thinkingSignature) content.push({ type: "redacted_thinking", data: block.thinkingSignature });
      else if (block.thinkingSignature) content.push({ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature });
      else if (block.thinking) content.push({ type: "text", text: block.thinking });
    }
    else content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} });
  }
  return { role: "assistant", content };
}

function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
