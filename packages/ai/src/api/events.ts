import { baseAssistant, type AssistantEventStream } from "../models.ts";
import type { AssistantMessage, Model, StopReason, ToolCall, Usage } from "../types.ts";
import { emptyUsage } from "../transform.ts";

interface TextBlock {
  kind: "text";
  contentIndex: number;
  text: string;
}

interface ThinkingBlock {
  kind: "thinking";
  contentIndex: number;
  text: string;
}

interface ToolBlock {
  kind: "tool";
  contentIndex: number;
  key: string;
  id: string;
  name: string;
  arguments: string;
  parsed?: unknown;
}

type Block = TextBlock | ThinkingBlock | ToolBlock;

/** One assistant stream. Text, thinking, and tool calls share first-seen contentIndex. */
export interface AssistantAccumulator {
  readonly stream: AssistantEventStream;
  readonly closed: boolean;
  text(delta: string): void;
  thinking(delta: string): void;
  tool(key: string, id: string | undefined, name: string | undefined, argumentDelta: string): void;
  usage(next: Usage): void;
  finish(stopReason: StopReason): void;
  fail(stopReason: "error" | "aborted", message: string, retryable?: boolean, overflow?: boolean): void;
}

export function createAccumulator(stream: AssistantEventStream, model: Model): AssistantAccumulator {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  let usage = emptyUsage();
  let started = false;
  let closed = false;

  const snapshot = (stopReason: StopReason): AssistantMessage => {
    const content = blocks.map((block) => {
      if (block.kind === "text") return { type: "text" as const, text: block.text };
      if (block.kind === "thinking") return { type: "thinking" as const, thinking: block.text };
      return toolCallOf(block);
    });
    return {
      ...baseAssistant(model, content.length > 0 ? content : [{ type: "text", text: "" }], stopReason),
      usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: { ...usage.cost } },
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

  return {
    stream,
    get closed() {
      return closed;
    },
    text(delta) {
      if (closed || !delta) return;
      begin();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text") {
        last.text += delta;
        stream.push({ type: "text_delta", contentIndex: last.contentIndex, delta, partial: snapshot("pending") });
        return;
      }
      const block: TextBlock = { kind: "text", contentIndex: blocks.length, text: "" };
      blocks.push(block);
      stream.push({ type: "text_start", contentIndex: block.contentIndex, partial: snapshot("pending") });
      block.text = delta;
      stream.push({ type: "text_delta", contentIndex: block.contentIndex, delta, partial: snapshot("pending") });
    },
    thinking(delta) {
      if (closed || !delta) return;
      begin();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "thinking") {
        last.text += delta;
        stream.push({ type: "thinking_delta", contentIndex: last.contentIndex, delta, partial: snapshot("pending") });
        return;
      }
      const block: ThinkingBlock = { kind: "thinking", contentIndex: blocks.length, text: "" };
      blocks.push(block);
      stream.push({ type: "thinking_start", contentIndex: block.contentIndex, partial: snapshot("pending") });
      block.text = delta;
      stream.push({ type: "thinking_delta", contentIndex: block.contentIndex, delta, partial: snapshot("pending") });
    },
    tool(key, id, name, argumentDelta) {
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
      } else {
        if (id) block.id = id;
        if (name) block.name += name;
      }
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
    finish(stopReason) {
      if (closed) return;
      const reason: StopReason = stopReason === "length"
        ? "length"
        : tools.size > 0 || stopReason === "toolUse"
          ? "toolUse"
          : stopReason;
      if (reason === "toolUse") {
        const ids = new Set<string>();
        for (const block of blocks) {
          if (block.kind !== "tool") continue;
          if (!block.id) block.id = `call_${block.contentIndex}`;
          if (ids.has(block.id)) {
            this.fail("error", "duplicate tool call id");
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
            this.fail("error", `malformed tool arguments for ${block.name || block.id}`);
            return;
          }
        }
      }
      closed = true;
      begin();
      endOpen(reason);
      stream.push({ type: "done", reason, message: snapshot(reason) });
    },
    fail(stopReason, message, retryable = false, overflow = false) {
      if (closed) return;
      closed = true;
      begin();
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
    arguments: block.parsed ?? {},
  };
}

export function usageFromCounts(model: Model, input: number | undefined, output: number | undefined, total: number | undefined): Usage | undefined {
  if (input === undefined && output === undefined && total === undefined) return undefined;
  const prompt = finite(input) ?? 0;
  const completion = finite(output) ?? 0;
  const inputRate = finite(model.cost?.input) ?? 0;
  const outputRate = finite(model.cost?.output) ?? 0;
  const inputCost = (prompt * inputRate) / 1_000_000;
  const outputCost = (completion * outputRate) / 1_000_000;
  return {
    input: prompt,
    output: completion,
    totalTokens: finite(total) ?? prompt + completion,
    cost: { input: inputCost, output: outputCost, total: inputCost + outputCost },
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}
