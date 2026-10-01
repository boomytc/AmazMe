import { baseAssistant, createAssistantEventStream, type Provider } from "../models.ts";
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
  return {
    id,
    name: "Faux",
    auth: options.authEnv ? { env: options.authEnv } : { env: "FAUX_API_KEY", ambient: "faux" },
    state,
    getModels: () => [model],
    streamSimple(active, context, streamOptions) {
      const stream = createAssistantEventStream();
      state.callCount += 1;
      state.contexts.push(context);
      state.options.push(streamOptions);
      const call = state.callCount;
      void (async () => {
        try {
          if (streamOptions.signal?.aborted) {
            throw new Error("aborted");
          }
          const produced = await respond(context, streamOptions, state, active);
          const message: AssistantMessage = {
            ...produced,
            api: active.api,
            provider: active.provider,
            model: active.id,
            usage: produced.usage ?? emptyUsage(),
          };
          emitMessage(stream, message);
        } catch (error) {
          const aborted = streamOptions.signal?.aborted === true;
          const failed = baseAssistant(active, [{ type: "text", text: "" }], aborted ? "aborted" : "error");
          failed.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", error: failed });
        }
      })();
      void call;
      return stream;
    },
  };
}

function emitMessage(stream: ReturnType<typeof createAssistantEventStream>, message: AssistantMessage): void {
  const partial = { ...message, content: [] as AssistantMessage["content"], stopReason: "pending" as const };
  stream.push({ type: "start", partial: { ...partial, content: [] } });
  for (const block of message.content) {
    if (block.type === "text") {
      stream.push({ type: "text_start", partial });
      const size = 8;
      for (let i = 0; i < block.text.length; i += size) {
        const delta = block.text.slice(i, i + size);
        partial.content = mergeText(partial.content, delta);
        stream.push({ type: "text_delta", delta, partial: clonePartial(partial) });
      }
      stream.push({ type: "text_end", partial: clonePartial(partial) });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_start", partial });
      partial.content = [...partial.content, block];
      stream.push({ type: "thinking_delta", delta: block.thinking, partial: clonePartial(partial) });
      stream.push({ type: "thinking_end", partial: clonePartial(partial) });
    } else {
      const index = partial.content.length;
      partial.content = [...partial.content, { ...block, arguments: {} }];
      stream.push({ type: "toolcall_start", contentIndex: index, partial: clonePartial(partial) });
      const encoded = JSON.stringify(block.arguments ?? {});
      partial.content = partial.content.map((item, itemIndex) =>
        itemIndex === index && item.type === "toolCall" ? { ...block } : item,
      );
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: encoded,
        partial: clonePartial(partial),
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: index,
        toolCall: block,
        partial: clonePartial(partial),
      });
    }
  }
  stream.push({ type: "done", reason: message.stopReason, message });
}

function mergeText(content: AssistantMessage["content"], delta: string): AssistantMessage["content"] {
  const next = [...content];
  const last = next[next.length - 1];
  if (last?.type === "text") next[next.length - 1] = { type: "text", text: last.text + delta };
  else next.push({ type: "text", text: delta });
  return next;
}

function clonePartial(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.map((block) => ({ ...block })) };
}
