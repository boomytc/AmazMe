import { createAssistantEventStream, type AssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Context, Message, Model, OpenAIResponsesOptions, Usage } from "../types.ts";
import { messageText } from "../transform.ts";
import { classifyTransportFailure, transportErrorDetail } from "../utils/overflow.ts";
import { createAccumulator, isAbort, usageFromCounts, type AssistantAccumulator } from "./events.ts";
import { isRecord, postJson, prepareChat, readSse, terminal } from "./prepare.ts";

export const OPENAI_RESPONSES_API = "openai-responses";

export interface OpenAIResponsesApiOptions {
  fetch?: typeof fetch;
}

export function openAIResponsesApi(options: OpenAIResponsesApiOptions = {}): ProviderStreams<"openai-responses"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"openai-responses"> = {
    stream(model, context, request) {
      const stream = createAssistantEventStream();
      void pumpResponses(fetchImpl, model, context, request ?? {}, stream, responsesUrl);
      return stream;
    },
    streamSimple(model, context, request) {
      return streams.stream(model, context, request);
    },
  };
  return streams;
}

export function responsesUrl(_model: Model, request: OpenAIResponsesOptions): string {
  return `${(request.baseUrl ?? "").replace(/\/$/, "")}/responses`;
}

export async function pumpResponses(
  fetchImpl: typeof fetch,
  model: Model,
  context: Context,
  request: OpenAIResponsesOptions,
  stream: AssistantEventStream,
  urlFor: (model: Model, request: OpenAIResponsesOptions) => string,
  headersFor?: (request: OpenAIResponsesOptions) => Record<string, string>,
  modelFor?: (model: Model, request: OpenAIResponsesOptions) => string,
): Promise<void> {
  const acc = createAccumulator(stream, model);
  let sent = false;
  try {
    const prepared = prepareChat(model, context, request, "OpenAI responses");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    if (!request.apiKey) {
      stream.push({ type: "error", error: terminal(model, "error", "OpenAI responses request requires apiKey") });
      return;
    }
    const effort = request.reasoningEffort ?? prepared.prepared.effort;
    const payload: Record<string, unknown> = {
      model: modelFor ? modelFor(model, request) : model.id,
      input: toResponsesInput(prepared.prepared.context),
      stream: true,
      store: false,
      max_output_tokens: prepared.prepared.outputCap,
    };
    if (effort) payload.reasoning = { effort };
    if (prepared.prepared.context.tools && prepared.prepared.context.tools.length > 0) {
      payload.tools = prepared.prepared.context.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }
    const headers = {
      ...(headersFor ? headersFor(request) : { authorization: `Bearer ${request.apiKey}` }),
      ...request.headers,
      "content-type": "application/json",
    };
    const url = urlFor(model, request);
    sent = true;
    const response = await postJson(fetchImpl, url, headers, payload, request.signal);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail(
        "error",
        `OpenAI responses ${response.status} ${classification.kind}: ${body.slice(0, 400)}`,
        classification.retryable,
        classification.overflow,
      );
      return;
    }
    await consumeResponses(model, response, acc, request.signal);
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}

export async function consumeResponses(
  model: Model,
  response: Response,
  acc: AssistantAccumulator,
  signal: AbortSignal | undefined,
): Promise<void> {
  let sawTerminal = false;
  const tools = new Map<string, string>();
  await readSse(response, signal, ({ data }) => {
    if (acc.closed || data === "[DONE]") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(data) as unknown;
    } catch {
      acc.fail("error", "OpenAI responses stream: malformed event");
      return;
    }
    if (!isRecord(decoded)) {
      acc.fail("error", "OpenAI responses stream: malformed event");
      return;
    }
    const type = typeof decoded.type === "string" ? decoded.type : "";
    if (type === "error" || type === "response.failed") {
      const classification = classifyTransportFailure(undefined, data);
      acc.fail("error", `OpenAI responses stream ${classification.kind}: ${transportErrorDetail(data)}`, classification.retryable, classification.overflow);
      return;
    }
    if (type === "response.output_text.delta" && typeof decoded.delta === "string") acc.text(decoded.delta);
    if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof decoded.delta === "string") {
      acc.thinking(decoded.delta);
    }
    if (type === "response.output_item.added" && isRecord(decoded.item) && decoded.item.type === "function_call") {
      const key = stringField(decoded.item, "id") || stringField(decoded.item, "call_id") || `tool_${tools.size}`;
      tools.set(key, key);
      acc.tool(key, stringField(decoded.item, "call_id") || stringField(decoded.item, "id"), stringField(decoded.item, "name"), "");
    }
    if (type === "response.function_call_arguments.delta" && typeof decoded.delta === "string") {
      const key = stringField(decoded, "item_id") || stringField(decoded, "output_index") || [...tools.keys()].at(-1) || "tool_0";
      acc.tool(key, undefined, undefined, decoded.delta);
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const responseRecord = isRecord(decoded.response) ? decoded.response : decoded;
      const reported = responsesUsage(model, responseRecord.usage);
      if (reported) acc.usage(reported);
      const status = stringField(responseRecord, "status");
      const details = isRecord(responseRecord.incomplete_details) ? responseRecord.incomplete_details : undefined;
      const why = details ? stringField(details, "reason") : undefined;
      // https://platform.openai.com/docs/api-reference/responses/object — incomplete_details.reason
      const incomplete = type === "response.incomplete" || status === "incomplete";
      if (incomplete && why && why !== "max_output_tokens") {
        sawTerminal = true;
        acc.fail("error", `OpenAI responses stream: ${why}`);
        return;
      }
      sawTerminal = true;
      acc.finish(incomplete ? "length" : "stop");
    }
  });
  if (!acc.closed) {
    if (sawTerminal) return;
    acc.fail("error", "OpenAI responses stream ended without a terminal event");
  }
}

function responsesUsage(model: Model, raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  return usageFromCounts(
    model,
    numberField(raw, "input_tokens"),
    numberField(raw, "output_tokens"),
    numberField(raw, "total_tokens"),
  );
}

function toResponsesInput(context: Context): unknown[] {
  const input: unknown[] = [];
  const prompt = context.systemPrompt ?? "";
  const leading = context.messages[0];
  if (prompt && !(leading?.role === "system" && leading.content === prompt)) {
    input.push({ role: "system", content: [{ type: "input_text", text: prompt }] });
  }
  for (const message of context.messages) input.push(...convertMessage(message));
  return input;
}

function convertMessage(message: Message): unknown[] {
  if (message.role === "system") return [{ role: "system", content: [{ type: "input_text", text: message.content }] }];
  if (message.role === "user") {
    if (typeof message.content === "string") return [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
    return [{
      role: "user",
      content: message.content.map((block) => block.type === "text"
        ? { type: "input_text", text: block.text }
        : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` }),
    }];
  }
  if (message.role === "toolResult") {
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content.some((block) => block.type === "image")
        ? message.content.map((block) => block.type === "text"
          ? { type: "input_text", text: block.text }
          : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` })
        : messageText(message),
    }];
  }
  const parts: unknown[] = [];
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const thinking = message.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("");
  if (thinking) parts.push({ type: "reasoning", content: [{ type: "reasoning_text", text: thinking }] });
  if (text) parts.push({ role: "assistant", content: [{ type: "output_text", text }] });
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    parts.push({
      type: "function_call",
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.arguments ?? {}),
    });
  }
  return parts;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
