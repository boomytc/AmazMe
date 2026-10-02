import { baseAssistant, createAssistantEventStream, type AssistantEventStream, type ProviderStreams } from "../models.ts";
import type { AssistantMessage, Context, Message, Model, OpenAICompletionsOptions, ToolCall } from "../types.ts";
import { emptyUsage, messageText, transformMessages } from "../transform.ts";

export const OPENAI_COMPLETIONS_API = "openai-completions";

export interface OpenAICompletionsApiOptions {
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function openaiCompletionsApi(options: OpenAICompletionsApiOptions = {}): ProviderStreams<"openai-completions"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"openai-completions"> = {
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
  request: OpenAICompletionsOptions,
  stream: AssistantEventStream,
): Promise<void> {
  try {
    if (!request.baseUrl || !request.apiKey) {
      const failed = baseAssistant(model, [{ type: "text", text: "" }], "error");
      failed.errorMessage = "OpenAI completions request requires baseUrl and apiKey";
      stream.push({ type: "error", error: failed });
      return;
    }
    const wire: Context = { ...context, messages: transformMessages(context.messages, model) };
    const response = await fetchImpl(`${request.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        ...request.headers,
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        stream: true,
        messages: toChatMessages(wire),
        ...(context.tools && context.tools.length > 0
          ? {
              tools: context.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
            }
          : {}),
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      const failed = baseAssistant(model, [{ type: "text", text: "" }], "error");
      failed.errorMessage = `OpenAI completions ${response.status}: ${body.slice(0, 400)}`;
      stream.push({ type: "error", error: failed });
      return;
    }
    await emitSse(model, response, stream);
  } catch (error) {
    const failed = baseAssistant(model, [{ type: "text", text: "" }], request.signal?.aborted ? "aborted" : "error");
    failed.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", error: failed });
  }
}

function toChatMessages(context: Context): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const prompt = context.systemPrompt ?? "";
  const leading = context.messages[0];
  const alreadyThere = leading?.role === "system" && leading.content === prompt;
  if (prompt && !alreadyThere) messages.push({ role: "system", content: prompt });
  for (const message of context.messages) messages.push(convertMessage(message));
  return messages;
}

function convertMessage(message: Message): ChatMessage {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "user") return { role: "user", content: messageText(message) };
  if (message.role === "toolResult") {
    return { role: "tool", content: messageText(message), tool_call_id: message.toolCallId };
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content.filter((block) => block.type === "toolCall");
  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((block) => ({
            id: block.id,
            type: "function" as const,
            function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
          })),
        }
      : {}),
  };
}

async function emitSse(model: Model, response: Response, stream: AssistantEventStream): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OpenAI completions response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish = "";
  let started = false;
  let closed = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const partial = baseAssistant(model, [], "pending");

  const snapshot = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => {
    const content: AssistantMessage["content"] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const index of [...calls.keys()].sort((left, right) => left - right)) {
      const call = calls.get(index);
      if (!call) continue;
      content.push({
        type: "toolCall",
        id: call.id || `call_${call.name || index}`,
        name: call.name,
        arguments: parseArgs(call.arguments),
      });
    }
    return { ...partial, content: content.length > 0 ? content : [{ type: "text", text: "" }], stopReason, usage: emptyUsage() };
  };
  const contentIndex = (index: number): number => {
    const earlier = [...calls.keys()].filter((key) => key < index).length;
    return (text.length > 0 ? 1 : 0) + earlier;
  };
  const begin = () => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: snapshot("pending") });
  };
  const finishMessage = () => {
    if (closed) return;
    if (!finish) {
      closed = true;
      begin();
      const failed = snapshot("error");
      failed.errorMessage = "OpenAI completions stream ended without a finish reason";
      stream.push({ type: "error", error: failed });
      return;
    }
    closed = true;
    begin();
    const stopReason = finish === "length" ? "length" : calls.size > 0 || finish === "tool_calls" ? "toolUse" : "stop";
    for (const index of [...calls.keys()].sort((left, right) => left - right)) {
      const call = calls.get(index);
      if (!call) continue;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: call.id || `call_${call.name || index}`,
        name: call.name,
        arguments: parseArgs(call.arguments),
      };
      stream.push({ type: "toolcall_end", contentIndex: contentIndex(index), toolCall, partial: snapshot(stopReason) });
    }
    const message = snapshot(stopReason);
    stream.push({ type: "done", reason: stopReason, message });
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        finishMessage();
        continue;
      }
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
      };
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        begin();
        text += choice.delta.content;
        stream.push({ type: "text_delta", delta: choice.delta.content, partial: snapshot("pending") });
      }
      for (const call of choice.delta?.tool_calls ?? []) {
        begin();
        const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
        const isNew = !calls.has(call.index);
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        calls.set(call.index, current);
        if (isNew) stream.push({ type: "toolcall_start", contentIndex: contentIndex(call.index), partial: snapshot("pending") });
        if (call.function?.arguments) {
          current.arguments += call.function.arguments;
          stream.push({
            type: "toolcall_delta",
            contentIndex: contentIndex(call.index),
            delta: call.function.arguments,
            partial: snapshot("pending"),
          });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  finishMessage();
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
}
