import { baseAssistant, createAssistantEventStream, type Provider } from "../models.ts";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  StreamOptions,
  ToolCall,
} from "../types.ts";
import { emptyUsage, messageText, transformMessages } from "../transform.ts";

export interface OpenAICompletionsOptions {
  api?: string;
  providerId?: string;
  name?: string;
  baseUrl?: string;
  modelIds?: string[];
  fetch?: typeof fetch;
  env?: string;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * OpenAI Chat Completions wire protocol. Other vendors that speak this API
 * share the implementation and differ only by provider id, base URL, and catalog.
 */
export function openaiCompletionsProvider(options: OpenAICompletionsOptions = {}): Provider {
  const id = options.providerId ?? "openai";
  const api = options.api ?? "openai-completions";
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  const modelIds = options.modelIds ?? ["gpt-4o-mini"];
  const fetchImpl = options.fetch ?? fetch;
  const models: Model[] = modelIds.map((modelId) => ({
    id: modelId,
    name: modelId,
    provider: id,
    api,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0.15, output: 0.6 },
  }));

  return {
    id,
    name: options.name ?? "OpenAI",
    auth: { env: options.env ?? "OPENAI_API_KEY" },
    getModels: () => models,
    streamSimple(model, context, streamOptions) {
      const stream = createAssistantEventStream();
      void readCompletions(fetchImpl, baseUrl, model, context, streamOptions)
        .then((message) => {
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          for (const block of message.content) {
            if (block.type === "text" && block.text.length > 0) {
              stream.push({ type: "text_delta", delta: block.text, partial: message });
            } else if (block.type === "toolCall") {
              const index = message.content.indexOf(block);
              stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
            }
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        })
        .catch((error: unknown) => {
          const failed = baseAssistant(model, [{ type: "text", text: "" }], streamOptions.signal?.aborted ? "aborted" : "error");
          failed.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", error: failed });
        });
      return stream;
    },
  };
}

async function readCompletions(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: Model,
  context: Context,
  options: StreamOptions & { apiKey: string },
): Promise<AssistantMessage> {
  const wire: Context = { ...context, messages: transformMessages(context.messages, model) };
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
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
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    const failed = baseAssistant(model, [{ type: "text", text: "" }], "error");
    failed.errorMessage = `OpenAI completions ${response.status}: ${body.slice(0, 400)}`;
    return failed;
  }
  return parseSse(model, response);
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

async function parseSse(model: Model, response: Response): Promise<AssistantMessage> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OpenAI completions response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  let finish = "stop";
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
      if (data === "[DONE]") continue;
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
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta?.content) text += choice.delta.content;
      for (const call of choice.delta?.tool_calls ?? []) {
        const current = tools.get(call.index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        tools.set(call.index, current);
      }
    }
  }
  const content: AssistantMessage["content"] = [];
  if (text.length > 0) content.push({ type: "text", text });
  const calls: ToolCall[] = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({
      type: "toolCall",
      id: call.id || `call_${call.name}`,
      name: call.name,
      arguments: parseArgs(call.arguments),
    }));
  content.push(...calls);
  const stopReason = calls.length > 0 || finish === "tool_calls" ? "toolUse" : finish === "length" ? "length" : "stop";
  const message = baseAssistant(model, content.length > 0 ? content : [{ type: "text", text: "" }], stopReason);
  message.usage = emptyUsage();
  return message;
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
}
