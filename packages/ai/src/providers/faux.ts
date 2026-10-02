import { baseAssistant, createAssistantEventStream, createProvider, type Provider, type ProviderStreams } from "../models.ts";
import type { AssistantMessage, Context, Model, StreamOptions, ToolCall } from "../types.ts";
import { emptyUsage } from "../transform.ts";

export interface FauxState {
  callCount: number;
  contexts: Context[];
  options: Array<StreamOptions & { apiKey: string }>;
}

export type FauxResponder = (
  context: Context,
  options: StreamOptions & { apiKey: string },
  state: FauxState,
  model: Model,
) => AssistantMessage | Promise<AssistantMessage>;

export interface FauxProviderOptions {
  id?: string;
  modelId?: string;
  respond?: FauxResponder;
  /** When set, auth requires this env var instead of the ambient faux key. */
  authEnv?: string;
}

const DEFAULT_RESPOND: FauxResponder = (_context, _options, _state, model) =>
  baseAssistant(model, [{ type: "text", text: "ok" }], "stop");

export function fauxText(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

export function fauxToolCall(name: string, args: unknown, id?: string): ToolCall {
  return { type: "toolCall", id: id ?? `call_${name}`, name, arguments: args };
}

export function fauxAssistant(
  content: string | AssistantMessage["content"],
  options: {
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    retryable?: boolean;
    overflow?: boolean;
    usage?: AssistantMessage["usage"];
  } = {},
): AssistantMessage {
  const blocks = typeof content === "string" ? [fauxText(content)] : content;
  return {
    role: "assistant",
    content: blocks,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: options.usage ?? emptyUsage(),
    stopReason: options.stopReason ?? (blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    ...(options.retryable ? { retryable: true } : {}),
    ...(options.overflow ? { overflow: true } : {}),
    timestamp: Date.now(),
  };
}

export function fauxProvider(options: FauxProviderOptions = {}): Provider & { state: FauxState } {
  const id = options.id ?? "faux";
  const modelId = options.modelId ?? "faux-1";
  const respond = options.respond ?? DEFAULT_RESPOND;
  const state: FauxState = { callCount: 0, contexts: [], options: [] };
  const model: Model = {
    id: modelId,
    name: "Faux",
    provider: id,
    api: "faux",
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 16_000,
    cost: { input: 0, output: 0 },
  };
  const streams: ProviderStreams<"faux"> = {
    stream(active, context, streamOptions) {
      return streams.streamSimple(active, context, streamOptions);
    },
    streamSimple(active, context, streamOptions) {
      const stream = createAssistantEventStream();
      const recorded = { ...streamOptions, apiKey: streamOptions?.apiKey ?? "" };
      state.callCount += 1;
      state.contexts.push(context);
      state.options.push(recorded);
      void (async () => {
        try {
          if (streamOptions?.signal?.aborted) {
            throw new Error("aborted");
          }
          const produced = await respond(context, recorded, state, active);
          const message: AssistantMessage = {
            ...produced,
            api: active.api,
            provider: active.provider,
            model: active.id,
            usage: produced.usage ?? emptyUsage(),
          };
          emitMessage(stream, message);
        } catch (error) {
          const aborted = streamOptions?.signal?.aborted === true;
          const failed = baseAssistant(active, [{ type: "text", text: "" }], aborted ? "aborted" : "error");
          failed.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", error: failed });
        }
      })();
      return stream;
    },
  };
  return Object.assign(createProvider({
    id,
    name: "Faux",
    auth: options.authEnv ? { env: options.authEnv } : { env: "FAUX_API_KEY", ambient: "faux" },
    models: [model],
    api: streams,
  }), { state });
}

function emitMessage(stream: ReturnType<typeof createAssistantEventStream>, message: AssistantMessage): void {
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial: { ...partial, content: [] } });
  message.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      partial.content = [...partial.content, { type: "text", text: "" }];
      stream.push({ type: "text_start", contentIndex, partial });
      let text = "";
      for (let offset = 0; offset < block.text.length; offset += 8) {
        const delta = block.text.slice(offset, offset + 8);
        text += delta;
        partial.content = replaceBlock(partial.content, contentIndex, { type: "text", text });
        stream.push({ type: "text_delta", contentIndex, delta, partial });
      }
      if (!failed) stream.push({ type: "text_end", contentIndex, partial });
    } else if (block.type === "thinking") {
      partial.content = [...partial.content, { ...block, thinking: "" }];
      stream.push({ type: "thinking_start", contentIndex, partial });
      partial.content = replaceBlock(partial.content, contentIndex, block);
      stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
      if (!failed) stream.push({ type: "thinking_end", contentIndex, partial });
    } else {
      partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
      stream.push({ type: "toolcall_start", contentIndex, partial });
      partial.content = replaceBlock(partial.content, contentIndex, block);
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(block.arguments ?? {}),
        partial,
      });
      if (!failed) stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
    }
  });
  if (failed) stream.push({ type: "error", error: message });
  else stream.push({ type: "done", reason: message.stopReason, message });
}

function replaceBlock(
  content: AssistantMessage["content"],
  contentIndex: number,
  block: AssistantMessage["content"][number],
): AssistantMessage["content"] {
  return content.map((item, index) => (index === contentIndex ? block : item));
}
