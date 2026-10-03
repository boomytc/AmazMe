import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Context, Message, Model, StreamOptions } from "../types.ts";
import { messageText } from "../transform.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { createAccumulator, isAbort, usageFromCounts } from "./events.ts";
import { isRecord, postJson, prepareChat, readSse, terminal } from "./prepare.ts";

export const MISTRAL_CONVERSATIONS_API = "mistral-conversations";

/** Mistral's catalog id is `mistral-conversations`. The chat wire is still `{base}/v1/chat/completions`. */
export function mistralConversationsApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"mistral-conversations"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"mistral-conversations"> = {
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
    const prepared = prepareChat(model, context, request, "Mistral conversations");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    if (!request.apiKey) {
      stream.push({ type: "error", error: terminal(model, "error", "Mistral conversations request requires apiKey") });
      return;
    }
    const payload: Record<string, unknown> = {
      model: model.id,
      messages: toMessages(prepared.prepared.context),
      stream: true,
      max_tokens: prepared.prepared.outputCap,
    };
    if (prepared.prepared.effort) payload.prompt_mode = prepared.prepared.effort;
    if (prepared.prepared.context.tools && prepared.prepared.context.tools.length > 0) {
      payload.tools = prepared.prepared.context.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    const headers = {
      ...request.headers,
      authorization: `Bearer ${request.apiKey}`,
      accept: "text/event-stream",
      "content-type": "application/json",
    };
    sent = true;
    const response = await postJson(fetchImpl, mistralUrl(request.baseUrl ?? ""), headers, payload, request.signal);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail("error", `Mistral conversations ${response.status} ${classification.kind}: ${body.slice(0, 400)}`, classification.retryable, classification.overflow);
      return;
    }
    let stop = "";
    await readSse(response, request.signal, ({ data }) => {
      if (acc.closed || data === "[DONE]") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        acc.fail("error", "Mistral conversations stream: malformed event");
        return;
      }
      if (!isRecord(decoded)) return;
      const usage = isRecord(decoded.usage) ? decoded.usage : undefined;
      if (usage) {
        const reported = usageFromCounts(model, numberOf(usage.prompt_tokens), numberOf(usage.completion_tokens), numberOf(usage.total_tokens));
        if (reported) acc.usage(reported);
      }
      const choices = Array.isArray(decoded.choices) ? decoded.choices : [];
      const choice = choices[0];
      if (!isRecord(choice)) return;
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) stop = choice.finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (!delta) return;
      applyContent(acc, delta.content);
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const index = typeof call.index === "number" ? call.index : 0;
        const fn = isRecord(call.function) ? call.function : undefined;
        acc.tool(
          `tool_${index}`,
          typeof call.id === "string" ? call.id : undefined,
          typeof fn?.name === "string" ? fn.name : undefined,
          typeof fn?.arguments === "string" ? fn.arguments : "",
        );
      }
    });
    if (acc.closed) return;
    if (!stop) {
      acc.fail("error", "Mistral conversations stream ended without a finish reason");
      return;
    }
    const mapped = mistralStop(stop);
    if (mapped === "error") {
      acc.fail("error", `Mistral conversations stream: ${stop}`);
      return;
    }
    acc.finish(mapped);
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}

export function mistralUrl(baseUrl: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return new URL("v1/chat/completions", base).toString();
}

function applyContent(acc: ReturnType<typeof createAccumulator>, content: unknown): void {
  if (typeof content === "string") {
    acc.text(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const chunk of content) {
    if (!isRecord(chunk)) continue;
    const text = typeof chunk.text === "string" ? chunk.text : typeof chunk.content === "string" ? chunk.content : undefined;
    if (chunk.type === "thinking" && text) acc.thinking(text);
    else if (text) acc.text(text);
  }
}

function toMessages(context: Context): unknown[] {
  const messages: unknown[] = [];
  const prompt = context.systemPrompt ?? "";
  const leading = context.messages[0];
  if (prompt && !(leading?.role === "system" && leading.content === prompt)) {
    messages.push({ role: "system", content: prompt });
  }
  for (const message of context.messages) messages.push(convert(message));
  return messages;
}

function convert(message: Message): unknown {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "user") {
    if (typeof message.content === "string") return { role: "user", content: message.content };
    return {
      role: "user",
      content: message.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "image_url", image_url: `data:${block.mimeType};base64,${block.data}` }),
    };
  }
  if (message.role === "toolResult") return { role: "tool", tool_call_id: message.toolCallId, content: messageText(message) };
  return {
    role: "assistant",
    content: message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(""),
    tool_calls: message.content.filter((block) => block.type === "toolCall").map((block) => block.type === "toolCall" ? {
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
    } : undefined),
  };
}

function mistralStop(reason: string): "stop" | "length" | "toolUse" | "error" {
  if (reason === "stop") return "stop";
  if (reason === "length" || reason === "model_length") return "length";
  if (reason === "tool_calls") return "toolUse";
  return "error";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
