import { baseAssistant, type AssistantEventStream } from "../models.ts";
import type { AssistantMessage, Model, StopReason, ToolCall, Usage } from "../types.ts";
import { isFilledWindowLength } from "../utils/overflow.ts";
import { cloneUsage, emptyUsage } from "../transform.ts";

interface TextBlock {
  kind: "text";
  contentIndex: number;
  text: string;
  key?: string;
  signature?: string;
}

interface ThinkingBlock {
  kind: "thinking";
  contentIndex: number;
  text: string;
  key?: string;
  signature?: string;
  redacted?: boolean;
}

interface ToolBlock {
  kind: "tool";
  contentIndex: number;
  key: string;
  id: string;
  name: string;
  arguments: string;
  parsed?: unknown;
  thoughtSignature?: string;
}

type Block = TextBlock | ThinkingBlock | ToolBlock;

export interface NativeBlockOptions {
  key?: string;
  signature?: string;
  appendSignature?: boolean;
  redacted?: boolean;
  newBlock?: boolean;
}

/** One assistant stream. Text, thinking, and tool calls share first-seen contentIndex. */
export interface AssistantAccumulator {
  readonly stream: AssistantEventStream;
  readonly closed: boolean;
  text(delta: string, options?: NativeBlockOptions): void;
  thinking(delta: string, options?: NativeBlockOptions): void;
  tool(key: string, id: string | undefined, name: string | undefined, argumentDelta: string, replace?: boolean, thoughtSignature?: string): void;
  usage(next: Usage): void;
  finish(stopReason: StopReason, overflow?: boolean): void;
  fail(stopReason: "error" | "aborted", message: string, retryable?: boolean, overflow?: boolean): void;
}

export function createAccumulator(stream: AssistantEventStream, model: Model): AssistantAccumulator {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  const nativeBlocks = new Map<string, TextBlock | ThinkingBlock>();
  let usage = emptyUsage();
  let started = false;
  let closed = false;

  const snapshot = (stopReason: StopReason): AssistantMessage => {
    const content = blocks.map((block) => {
      if (block.kind === "text") return { type: "text" as const, text: block.text, ...(block.signature !== undefined ? { textSignature: block.signature } : {}) };
      if (block.kind === "thinking") return { type: "thinking" as const, thinking: block.text, ...(block.signature !== undefined ? { thinkingSignature: block.signature } : {}), ...(block.redacted ? { redacted: true } : {}) };
      return toolCallOf(block);
    });
    return {
      ...baseAssistant(model, content.length > 0 ? content : [{ type: "text", text: "" }], stopReason),
      usage: cloneUsage(usage),
    };
  };
  const begin = () => {
    if (started || closed) return;
    started = true;
    stream.push({ type: "start", partial: snapshot("pending") });
  };
  const endOpen = (stopReason: StopReason) => {
    for (const block of blocks) {
      if (block.kind === "text") {
        stream.push({ type: "text_end", contentIndex: block.contentIndex, partial: snapshot(stopReason) });
      } else if (block.kind === "thinking") {
        stream.push({ type: "thinking_end", contentIndex: block.contentIndex, partial: snapshot(stopReason) });
      } else {
        const toolCall = toolCallOf(block);
        stream.push({ type: "toolcall_end", contentIndex: block.contentIndex, toolCall, partial: snapshot(stopReason) });
      }
    }
  };

  const appendNative = (kind: "text" | "thinking", delta: string, options: NativeBlockOptions) => {
    if (closed || (!delta && options.signature === undefined && !options.redacted)) return;
    begin();
    const key = options.key === undefined ? undefined : `${kind}:${options.key}`;
    const last = blocks[blocks.length - 1];
    const nativeLast = last?.kind === "text" || last?.kind === "thinking" ? last : undefined;
    let block = key ? nativeBlocks.get(key) : !options.newBlock && nativeLast?.kind === kind && !(nativeLast.signature !== undefined && delta) ? nativeLast : undefined;
    if (!block) {
      block = kind === "text"
        ? { kind: "text", contentIndex: blocks.length, text: "", ...(key ? { key } : {}) }
        : { kind: "thinking", contentIndex: blocks.length, text: "", ...(key ? { key } : {}) };
      blocks.push(block);
      if (key) nativeBlocks.set(key, block);
      stream.push(kind === "text"
        ? { type: "text_start", contentIndex: block.contentIndex, partial: snapshot("pending") }
        : { type: "thinking_start", contentIndex: block.contentIndex, partial: snapshot("pending") });
    }
    if (options.signature !== undefined) {
      block.signature = options.appendSignature
        ? options.redacted ? btoa(atob(block.signature ?? "") + atob(options.signature)) : (block.signature ?? "") + options.signature
        : options.signature;
    }
    if (block.kind === "thinking" && options.redacted) block.redacted = true;
    block.text += delta;
    stream.push(kind === "text"
      ? { type: "text_delta", contentIndex: block.contentIndex, delta, partial: snapshot("pending") }
      : { type: "thinking_delta", contentIndex: block.contentIndex, delta, partial: snapshot("pending") });
  };

  return {
    stream,
    get closed() {
      return closed;
    },
    text(delta, options = {}) {
      appendNative("text", delta, options);
    },
    thinking(delta, options = {}) {
      appendNative("thinking", delta, options);
    },
    tool(key, id, name, argumentDelta, replace = false, thoughtSignature) {
      if (closed) return;
      begin();
      let block = tools.get(key);
      if (!block) {
        block = {
          kind: "tool",
          contentIndex: blocks.length,
          key,
          id: id ?? "",
          name: name ?? "",
          arguments: "",
        };
        blocks.push(block);
        tools.set(key, block);
        stream.push({ type: "toolcall_start", contentIndex: block.contentIndex, partial: snapshot("pending") });
      } else if (replace) {
        if (thoughtSignature !== undefined) block.thoughtSignature = thoughtSignature;
        if (id) block.id = id;
        if (name) block.name = name;
        if (argumentDelta) block.arguments = argumentDelta;
        return;
      } else {
        if (id) block.id = id;
        if (name) block.name += name;
      }
      if (thoughtSignature !== undefined) block.thoughtSignature = thoughtSignature;
      if (argumentDelta) {
        block.arguments += argumentDelta;
        stream.push({
          type: "toolcall_delta",
          contentIndex: block.contentIndex,
          delta: argumentDelta,
          partial: snapshot("pending"),
        });
      }
    },
    usage(next) {
      usage = next;
    },
    finish(stopReason, overflow = false) {
      if (closed) return;
      const reason: StopReason = stopReason === "length"
        ? "length"
        : tools.size > 0 || stopReason === "toolUse"
          ? "toolUse"
          : stopReason;
      overflow ||= isFilledWindowLength(snapshot(reason), model.contextWindow);
      if (tools.size > 0) {
        const ids = new Set<string>();
        for (const block of blocks) {
          if (block.kind !== "tool") continue;
          if (!block.id) block.id = `call_${block.contentIndex}`;
          if (ids.has(block.id)) {
            this.fail("error", "duplicate tool call id", false, overflow);
            return;
          }
          ids.add(block.id);
          if (!block.arguments) {
            block.parsed = {};
            continue;
          }
          try {
            block.parsed = JSON.parse(block.arguments) as unknown;
          } catch {
            this.fail("error", `malformed tool arguments for ${block.name || block.id}`, false, overflow);
            return;
          }
        }
      }
      begin();
      closed = true;
      endOpen(reason);
      const message = snapshot(reason);
      if (overflow) message.overflow = true;
      stream.push({ type: "done", reason, message });
    },
    fail(stopReason, message, retryable = false, overflow = false) {
      if (closed) return;
      begin();
      closed = true;
      const failed = snapshot(stopReason);
      failed.errorMessage = message;
      if (retryable) failed.retryable = true;
      if (overflow) failed.overflow = true;
      stream.push({ type: "error", error: failed });
    },
  };
}

function toolCallOf(block: ToolBlock): ToolCall {
  return {
    type: "toolCall",
    id: block.id || `call_${block.contentIndex}`,
    name: block.name,
    arguments: block.parsed ?? parsedArguments(block.arguments),
    ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
  };
}

function parsedArguments(value: string): unknown {
  if (!value) return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

/**
 * Prompt counts that already include cache hits. The miss portion is `prompt - cacheRead`.
 * A missing cache read is not zero and is not subtracted.
 */
export function cacheMissInput(prompt: number | undefined, cacheRead: number | undefined): number | undefined {
  if (prompt === undefined) return undefined;
  if (cacheRead === undefined) return prompt;
  return prompt - cacheRead;
}

export function usageFromCounts(
  model: Model,
  input: number | undefined,
  output: number | undefined,
  total: number | undefined,
  cache?: { cacheRead?: number; cacheWrite?: number },
): Usage | undefined {
  if (input === undefined && output === undefined && total === undefined) return undefined;
  const prompt = finite(input) ?? 0;
  const completion = finite(output) ?? 0;
  const inputRate = finite(model.cost?.input) ?? 0;
  const outputRate = finite(model.cost?.output) ?? 0;
  const inputCost = (prompt * inputRate) / 1_000_000;
  const outputCost = (completion * outputRate) / 1_000_000;
  const cacheRead = finite(cache?.cacheRead);
  const cacheWrite = finite(cache?.cacheWrite);
  const cacheReadRate = finite(model.cost?.cacheRead);
  const cacheWriteRate = finite(model.cost?.cacheWrite);
  const cacheReadCost = cacheRead !== undefined && cacheReadRate !== undefined ? (cacheRead * cacheReadRate) / 1_000_000 : 0;
  const cacheWriteCost = cacheWrite !== undefined && cacheWriteRate !== undefined ? (cacheWrite * cacheWriteRate) / 1_000_000 : 0;
  return {
    input: prompt,
    output: completion,
    totalTokens: finite(total) ?? prompt + completion,
    cost: { input: inputCost, output: outputCost, total: inputCost + outputCost + cacheReadCost + cacheWriteCost },
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}
