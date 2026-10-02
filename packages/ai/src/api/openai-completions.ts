import { baseAssistant, createAssistantEventStream, type AssistantEventStream, type ProviderStreams } from "../models.ts";
import { resolveThinkingLevel } from "../thinking.ts";
import type { AssistantMessage, Context, Message, Model, OpenAICompletionsOptions, ToolCall, Usage } from "../types.ts";
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
        stream_options: { include_usage: true },
        ...(effort ? { reasoning_effort: effort } : {}),
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
      let body = "";
      try {
        body = await response.text();
      } catch (error) {
        if (isAbort(error, request.signal)) throw error;
      }
      const classification = classifyHttpFailure(response.status, body);
      const failed = terminalMessage(
        model,
        [],
        "error",
        `OpenAI completions ${response.status} ${classification.kind}: ${body.slice(0, 400)}`,
        classification.retryable,
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
      !aborted,
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
    stream.push({ type: "done", reason: stopReason, message: snapshot(stopReason) });
  };
  const fail = (stopReason: "error" | "aborted", errorMessage: string, retryable: boolean) => {
    if (closed) return;
    closed = true;
    begin();
    const failed = snapshot(stopReason);
    failed.errorMessage = errorMessage;
    if (retryable) failed.retryable = true;
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
    let parsed: CompletionChunk;
    try {
      parsed = JSON.parse(data) as CompletionChunk;
    } catch {
      fail("error", "OpenAI completions stream: malformed event", false);
      return;
    }
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

type FailureKind = "quota" | "authentication" | "invalid_request" | "rate_limit" | "unavailable" | "server";

const QUOTA = /insufficient_quota|quota_exceeded|exceeded your current quota|billing|out of credits|credit balance/i;
const AUTH = /invalid_api_key|authentication_error|permission_error|access_denied/i;
const RATE = /rate_limit|too many requests/i;
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);

/**
 * Quota and billing lose to nothing: a 429 or 5xx that says the account is exhausted is not retried.
 * A bare 429 is a temporary rate limit. Only 408 and the transient 5xx set are retried; 501 and 505 are not.
 * This classification does not resend the request.
 */
function classifyHttpFailure(status: number, body: string): { kind: FailureKind; retryable: boolean } {
  const fields = errorFields(body);
  const haystack = `${fields.type ?? ""}\n${fields.code ?? ""}\n${fields.message ?? ""}`;
  if (status === 402 || QUOTA.test(haystack)) return { kind: "quota", retryable: false };
  if (status === 401 || status === 403 || AUTH.test(haystack)) return { kind: "authentication", retryable: false };
  if (status === 400 || status === 404 || status === 422) return { kind: "invalid_request", retryable: false };
  if (fields.type === "invalid_request_error" && status !== 429) return { kind: "invalid_request", retryable: false };
  if (status === 429 || RATE.test(haystack)) return { kind: "rate_limit", retryable: true };
  if (RETRYABLE_STATUS.has(status)) return { kind: "unavailable", retryable: true };
  return { kind: "server", retryable: false };
}

function errorFields(body: string): { type?: string; code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown; message?: unknown } };
    const error = parsed.error;
    if (!error || typeof error !== "object") return { message: body };
    return {
      ...(typeof error.type === "string" ? { type: error.type } : {}),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : { message: body }),
    };
  } catch {
    return { message: body };
  }
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
): AssistantMessage {
  const message = baseAssistant(model, content.length > 0 ? content : [{ type: "text", text: "" }], stopReason);
  message.errorMessage = errorMessage;
  if (retryable) message.retryable = true;
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
