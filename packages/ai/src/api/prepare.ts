import { imageInputRefusal } from "../image-input.ts";
import { baseAssistant } from "../models.ts";
import { resolveThinkingLevel } from "../thinking.ts";
import type { AssistantMessage, Context, Message, Model, StreamOptions } from "../types.ts";
import { transformMessages } from "../transform.ts";
import { resolveOutputBudget } from "../utils/budget.ts";

const IMAGE_MIME = /^image\/[\w.+-]+$/;
const IMAGE_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

export interface PreparedChat {
  context: Context;
  outputCap: number;
  effort?: string;
}

export function prepareChat(model: Model, context: Context, request: StreamOptions, label: string):
  | { ok: true; prepared: PreparedChat }
  | { ok: false; message: AssistantMessage } {
  if (request.signal?.aborted) return { ok: false, message: terminal(model, "aborted", "aborted") };
  const resolution = resolveThinkingLevel(model, request.thinkingLevel);
  if (!resolution.ok) {
    return { ok: false, message: terminal(model, "error", `Thinking level "${resolution.level}" is not supported by ${model.id}`) };
  }
  const image = userImageProblem(model, context.messages);
  if (image) return { ok: false, message: terminal(model, "error", image) };
  const wire: Context = { ...context, messages: transformMessages(context.messages, model) };
  const budget = resolveOutputBudget(model, wire, request.maxTokens);
  if (budget.status !== "ok" || budget.outputCap === undefined) {
    return {
      ok: false,
      message: terminal(model, "error", budget.message ?? "Context budget rejected the request", false, budget.status === "cannot_fit"),
    };
  }
  if (!request.baseUrl) return { ok: false, message: terminal(model, "error", `${label} request requires baseUrl`) };
  return { ok: true, prepared: { context: wire, outputCap: budget.outputCap, ...(resolution.parameter ? { effort: resolution.parameter } : {}) } };
}

export function terminal(
  model: Model,
  stopReason: AssistantMessage["stopReason"],
  errorMessage: string,
  retryable = false,
  overflow = false,
): AssistantMessage {
  const message = baseAssistant(model, [{ type: "text", text: "" }], stopReason);
  message.errorMessage = errorMessage;
  if (retryable) message.retryable = true;
  if (overflow) message.overflow = true;
  return message;
}

/**
 * Capability and format failures apply only to the user message of this turn.
 * Earlier user images stay in the transcript. A text-only model projects them
 * to `[image]`. Refusal follows `model.input`, not a model id.
 */
export function userImageProblem(model: Model, messages: readonly Message[]): string | undefined {
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUser = index;
      break;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") {
      if (index !== latestUser || typeof message.content === "string") continue;
      for (const block of message.content) {
        if (block.type !== "image") continue;
        const problem = imageBlockProblem(model, block, true);
        if (problem) return problem;
      }
      continue;
    }
    if (message.role !== "toolResult" || !model.input.includes("image")) continue;
    for (const block of message.content) {
      if (block.type !== "image") continue;
      const problem = imageBlockProblem(model, block, false);
      if (problem) return problem;
    }
  }
  return undefined;
}

function imageBlockProblem(model: Model, block: { mimeType: string; data: string }, rejectTextModel: boolean): string | undefined {
  if (rejectTextModel) {
    const refused = imageInputRefusal(model, [{ type: "image" }]);
    if (refused) return refused;
  }
  if (typeof block.mimeType !== "string" || !IMAGE_MIME.test(block.mimeType)) return "Image input requires a mime type";
  if (typeof block.data !== "string" || block.data.length === 0 || !IMAGE_BASE64.test(block.data)) {
    return "Image input requires base64 data";
  }
  return undefined;
}

export async function readSse(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (event: { event?: string; data: string }) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const flush = () => {
    if (dataLines.length === 0 && !eventName) return;
    const data = dataLines.join("\n");
    const event = eventName;
    eventName = undefined;
    dataLines = [];
    if (data.length > 0) onEvent({ ...(event ? { event } : {}), data });
  };
  const consume = (line: string) => {
    if (signal?.aborted) throw abortError();
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      return;
    }
    if (line.trim() === "") flush();
  };
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const chunk = await reader.read();
      if (signal?.aborted) throw abortError();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    buffer += decoder.decode();
    if (buffer.length > 0) consume(buffer);
    flush();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
