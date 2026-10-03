import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { Context, Model, StreamOptions, ToolCall } from "../types.ts";
import { classifyTransportFailure } from "../utils/overflow.ts";
import { createAccumulator, isAbort, usageFromCounts } from "./events.ts";
import { isRecord, postJson, prepareChat, readSse, terminal } from "./prepare.ts";

export const PI_MESSAGES_API = "pi-messages";

/** Radius's static preset. POST `{base}/messages` and read assistant events back. No catalog refresh. */
export function piMessagesApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"pi-messages"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"pi-messages"> = {
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
    const prepared = prepareChat(model, context, request, "pi-messages");
    if (!prepared.ok) {
      stream.push({ type: "error", error: prepared.message });
      return;
    }
    if (!request.apiKey) {
      stream.push({ type: "error", error: terminal(model, "error", "pi-messages request requires apiKey") });
      return;
    }
    const payload = {
      model: model.id,
      context: prepared.prepared.context,
      options: {
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        maxTokens: prepared.prepared.outputCap,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      },
    };
    const headers = {
      ...request.headers,
      authorization: `Bearer ${request.apiKey}`,
      accept: "text/event-stream",
      "content-type": "application/json",
    };
    sent = true;
    const response = await postJson(fetchImpl, `${request.baseUrl?.replace(/\/$/, "")}/messages`, headers, payload, request.signal);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classification = classifyTransportFailure(response.status, body);
      acc.fail("error", `pi-messages ${response.status} ${classification.kind}: ${body.slice(0, 400)}`, classification.retryable, classification.overflow);
      return;
    }
    let terminalReason: "stop" | "length" | "toolUse" | undefined;
    await readSse(response, request.signal, ({ data }) => {
      if (acc.closed) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        acc.fail("error", "pi-messages stream: malformed event");
        return;
      }
      if (!isRecord(decoded) || typeof decoded.type !== "string") return;
      if (decoded.type === "text_delta" && typeof decoded.delta === "string") acc.text(decoded.delta);
      if (decoded.type === "thinking_delta" && typeof decoded.delta === "string") acc.thinking(decoded.delta);
      if (decoded.type === "toolcall_start") {
        acc.tool(
          `tool_${typeof decoded.contentIndex === "number" ? decoded.contentIndex : 0}`,
          typeof decoded.id === "string" ? decoded.id : undefined,
          typeof decoded.toolName === "string" ? decoded.toolName : undefined,
          "",
        );
      }
      if (decoded.type === "toolcall_delta" && typeof decoded.delta === "string") {
        acc.tool(`tool_${typeof decoded.contentIndex === "number" ? decoded.contentIndex : 0}`, undefined, undefined, decoded.delta);
      }
      if (decoded.type === "toolcall_end" && isRecord(decoded.toolCall)) {
        const call = decoded.toolCall as Partial<ToolCall>;
        const key = `tool_${typeof decoded.contentIndex === "number" ? decoded.contentIndex : 0}`;
        const args = call.arguments === undefined ? "" : typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
        acc.tool(key, typeof call.id === "string" ? call.id : undefined, typeof call.name === "string" ? call.name : undefined, args, true);
      }
      if (decoded.type === "done") {
        const usage = isRecord(decoded.usage) ? decoded.usage : undefined;
        if (usage) {
          const reported = usageFromCounts(model, numberOf(usage.input), numberOf(usage.output), numberOf(usage.totalTokens));
          if (reported) acc.usage(reported);
        }
        terminalReason = decoded.reason === "length" ? "length" : decoded.reason === "toolUse" ? "toolUse" : "stop";
      }
      if (decoded.type === "error") {
        acc.fail(decoded.reason === "aborted" ? "aborted" : "error", typeof decoded.errorMessage === "string" ? decoded.errorMessage : "pi-messages error");
      }
    });
    if (acc.closed) return;
    if (!terminalReason) {
      acc.fail("error", "pi-messages stream ended without a terminal event");
      return;
    }
    acc.finish(terminalReason);
  } catch (error) {
    const aborted = isAbort(error, request.signal);
    acc.fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), sent && !aborted);
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
