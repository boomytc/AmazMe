import { baseAssistant, createAssistantEventStream, type AssistantEventStream, type ProviderStreams } from "../models.ts";
import { resolveThinkingLevel } from "../thinking.ts";
import type { AssistantMessage, CompletionsOutputTokenField, Context, Message, Model, OpenAICompletionsOptions, ToolCall, Usage } from "../types.ts";
import { emptyUsage, messageText, transformMessages } from "../transform.ts";
import { resolveOutputBudget } from "../utils/budget.ts";
import { classifyTransportFailure, isFilledWindowLength, transportErrorDetail } from "../utils/overflow.ts";

export const OPENAI_COMPLETIONS_API = "openai-completions";

export interface OpenAICompletionsApiOptions {
  fetch?: typeof fetch;
  /** Used when a request does not set `outputTokenField`. Official calls pass `max_completion_tokens`. */
  outputTokenField?: CompletionsOutputTokenField;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function openaiCompletionsApi(options: OpenAICompletionsApiOptions = {}): ProviderStreams<"openai-completions"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const outputTokenField = options.outputTokenField ?? "max_completion_tokens";
  const streams: ProviderStreams<"openai-completions"> = {
    stream(model, context, request) {
      const stream = createAssistantEventStream();
      void pump(fetchImpl, model, context, request ?? {}, stream, outputTokenField);
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
  outputTokenField: CompletionsOutputTokenField,
): Promise<void> {
  let requestPrepared = false;
  try {
    if (request.signal?.aborted) {
      stream.push({ type: "error", error: terminalMessage(model, [], "aborted", "aborted") });
      return;
    }
    const resolution = resolveThinkingLevel(model, request.thinkingLevel);
    if (!resolution.ok) {
      const failed = terminalMessage(model, [], "error", `Thinking level "${resolution.level}" is not supported by ${model.id}`);
      stream.push({ type: "error", error: failed });
      return;
    }
    if (!request.baseUrl || !request.apiKey) {
      const failed = terminalMessage(model, [], "error", "OpenAI completions request requires baseUrl and apiKey");
      stream.push({ type: "error", error: failed });
      return;
    }
    // An explicit protocol option wins over the mapped unified level. Neither is sent when absent.
    const effort = request.reasoningEffort ?? resolution.parameter;
    const field = request.outputTokenField ?? outputTokenField;
    if (field !== "max_completion_tokens" && field !== "max_tokens") {
      stream.push({
        type: "error",
        error: terminalMessage(model, [], "error", "OpenAI completions outputTokenField must be max_completion_tokens or max_tokens"),
      });
      return;
    }
    const wire: Context = { ...context, messages: transformMessages(context.messages, model) };
    const budget = resolveOutputBudget(model, wire, request.maxTokens);
    if (budget.status !== "ok" || budget.outputCap === undefined) {
      stream.push({
        type: "error",
        error: terminalMessage(
          model,
          [],
          "error",
          budget.message ?? "Context budget rejected the request",
          false,
          budget.status === "cannot_fit",
        ),
      });
      return;
    }
    const payload: Record<string, unknown> = {
      model: model.id,
      stream: true,
      stream_options: { include_usage: true },
      messages: toChatMessages(wire),
      [field]: budget.outputCap,
    };
    if (effort) payload.reasoning_effort = effort;
    if (wire.tools && wire.tools.length > 0) {
      payload.tools = wire.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    const url = `${request.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        ...request.headers,
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: request.signal,
    };
    requestPrepared = true;
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch (error) {
        if (isAbort(error, request.signal)) throw error;
      }
      const classification = classifyTransportFailure(response.status, body);
      const failed = terminalMessage(
        model,
        [],
        "error",
        `OpenAI completions ${response.status} ${classification.kind}: ${body.slice(0, 400)}`,
        classification.retryable,
        classification.overflow,
      );
      stream.push({ type: "error", error: failed });
      return;
    }
    await emitSse(model, response, stream, request.signal);
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    const failed = terminalMessage(
      model,
      [],
      aborted ? "aborted" : "error",
      error instanceof Error ? error.message : String(error),
      requestPrepared && !aborted,
    );
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

async function emitSse(model: Model, response: Response, stream: AssistantEventStream, signal: AbortSignal | undefined): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    stream.push({ type: "error", error: terminalMessage(model, [], "error", "OpenAI completions stream: response has no body") });
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish = "";
  let started = false;
  let closed = false;
  let usage = emptyUsage();
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
    return {
      ...partial,
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      stopReason,
      usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: { ...usage.cost } },
    };
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
      fail("error", "OpenAI completions stream ended without a finish reason", false);
      return;
    }
    if (finish === "content_filter") {
      fail("error", "OpenAI completions stream ended with content_filter", false);
      return;
    }
    const stopReason = finish === "length" ? "length" : calls.size > 0 || finish === "tool_calls" ? "toolUse" : "stop";
    if (stopReason === "toolUse") {
      for (const call of calls.values()) {
        try {
          if (call.arguments) JSON.parse(call.arguments);
        } catch {
          fail("error", `OpenAI completions stream: malformed tool arguments for ${call.name}`, false);
          return;
        }
      }
    }
    closed = true;
    begin();
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
    if (isFilledWindowLength(message, model.contextWindow)) message.overflow = true;
    stream.push({ type: "done", reason: stopReason, message });
  };
  const fail = (stopReason: "error" | "aborted", errorMessage: string, retryable: boolean, overflow = false) => {
    if (closed) return;
    closed = true;
    begin();
    const failed = snapshot(stopReason);
    failed.errorMessage = errorMessage;
    if (retryable) failed.retryable = true;
    if (overflow) failed.overflow = true;
    stream.push({ type: "error", error: failed });
  };
  const consumeLine = (line: string) => {
    if (closed) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      finishMessage();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data) as unknown;
    } catch {
      fail("error", "OpenAI completions stream: malformed event", false);
      return;
    }
    if (isRecord(decoded) && "error" in decoded && isRecord(decoded.error)) {
      const classification = classifyTransportFailure(undefined, data);
      fail(
        "error",
        `OpenAI completions stream ${classification.kind}: ${transportErrorDetail(data)}`,
        classification.retryable,
        classification.overflow,
      );
      return;
    }
    if (!isCompletionChunk(decoded)) {
      fail("error", "OpenAI completions stream: malformed event", false);
      return;
    }
    const parsed = decoded;
    const reported = usageFromChunk(model, parsed.usage);
    if (reported) usage = reported;
    const choice = parsed.choices?.[0];
    if (!choice) return;
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
  };

  try {
    while (!closed) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
        if (closed) break;
      }
    }
    if (closed) return;
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (closed) return;
    if (signal?.aborted && !finish) {
      fail("aborted", "aborted", false);
      return;
    }
    finishMessage();
  } catch (error) {
    const aborted = isAbort(error, signal);
    fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), !aborted);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
}

interface CompletionChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check only the fields consumed below; additional server metadata remains opaque. */
function isCompletionChunk(value: unknown): value is CompletionChunk {
  if (!isRecord(value) || "error" in value) return false;
  if (value.choices === undefined) return true;
  if (!Array.isArray(value.choices)) return false;
  return value.choices.every((choice: unknown) => {
    if (!isRecord(choice)) return false;
    const finish = choice.finish_reason;
    if (finish !== undefined && finish !== null
      && (typeof finish !== "string" || !["stop", "length", "tool_calls", "content_filter"].includes(finish))) return false;
    if (choice.delta === undefined) return true;
    if (!isRecord(choice.delta)) return false;
    const { content, tool_calls: calls } = choice.delta;
    if (content !== undefined && content !== null && typeof content !== "string") return false;
    if (calls === undefined) return true;
    if (!Array.isArray(calls)) return false;
    return calls.every((call: unknown) => {
      if (!isRecord(call) || typeof call.index !== "number" || !Number.isSafeInteger(call.index) || call.index < 0) return false;
      if (call.id !== undefined && typeof call.id !== "string") return false;
      if (call.function === undefined) return true;
      if (!isRecord(call.function)) return false;
      return (call.function.name === undefined || typeof call.function.name === "string")
        && (call.function.arguments === undefined || typeof call.function.arguments === "string");
    });
  });
}

/** `model.cost` is USD per 1,000,000 tokens. Non-finite or absent rates contribute 0; no catalog price is invented. */
function usageFromChunk(model: Model, raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const input = finiteNumber(record.prompt_tokens);
  const output = finiteNumber(record.completion_tokens);
  const total = finiteNumber(record.total_tokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  const prompt = input ?? 0;
  const completion = output ?? 0;
  const inputRate = finiteNumber(model.cost?.input) ?? 0;
  const outputRate = finiteNumber(model.cost?.output) ?? 0;
  const inputCost = (prompt * inputRate) / 1_000_000;
  const outputCost = (completion * outputRate) / 1_000_000;
  return {
    input: prompt,
    output: completion,
    totalTokens: total ?? prompt + completion,
    cost: { input: inputCost, output: outputCost, total: inputCost + outputCost },
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function terminalMessage(
  model: Model,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage: string,
  retryable = false,
  overflow = false,
): AssistantMessage {
  const message = baseAssistant(model, content.length > 0 ? content : [{ type: "text", text: "" }], stopReason);
  message.errorMessage = errorMessage;
  if (retryable) message.retryable = true;
  if (overflow) message.overflow = true;
  return message;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  const pending = reader.read();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (chunk) => {
        signal.removeEventListener("abort", onAbort);
        resolve(chunk);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
