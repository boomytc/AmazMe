import type { Context, Message, Model, ToolDefinition } from "../types.ts";
import { transformMessages } from "../transform.ts";

/**
 * UTF-8 bytes per estimated token. This is an approximation, so callers keep a
 * safety margin and still treat a server overflow as authoritative.
 */
export const BYTES_PER_TOKEN = 4;

/**
 * Fixed cost of one image in the request budget.
 * The base64 payload is not measured: decoding and tiling are not available here,
 * and a long data URL would dominate the estimate without describing the image.
 * 1,200 tokens matches a conservative high-detail still (4,800 bytes at 4 bytes/token)
 * without claiming to know the picture.
 */
export const IMAGE_TOKEN_COST = 1_200;

/** Per-message framing that the character count of the body does not include. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export type BudgetStatus = "ok" | "cannot_fit" | "invalid_limit" | "unserializable";

export interface OutputBudget {
  /** Estimated input tokens of the projected request. Previous usage is not reused. */
  estimatedInput: number;
  /** Caller `maxTokens`, or the model output cap when the caller omitted it. */
  requestedOutput: number;
  /** Model-declared output cap. */
  modelOutputCap: number;
  /** `contextWindow - estimatedInput - safetyMargin`. Negative means the input already overflows. */
  remainingOutputRoom: number;
  /** Final output cap sent on the request. Absent when the request must not be sent. */
  outputCap?: number;
  status: BudgetStatus;
  message?: string;
}

/**
 * Safety margin for a context window.
 * Large windows keep 4,096 tokens. Smaller windows use one twentieth of the window,
 * and never less than 32, so a small model is not charged a flat 4,096.
 */
export function contextSafetyMargin(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(4_096, Math.max(32, Math.floor(contextWindow / 20)));
}

export function modelLimitProblem(contextWindow: number, maxTokens: number, label: string): string | undefined {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return `${label} contextWindow must be a positive integer`;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return `${label} maxTokens must be a positive integer`;
  if (maxTokens > contextWindow) return `${label} maxTokens cannot exceed contextWindow`;
  return undefined;
}

/** Estimate the projected request. Does not read `usage` and does not mutate `context`. */
export function estimateRequestTokens(context: Context): number {
  let tokens = 0;
  const prompt = context.systemPrompt ?? "";
  const leading = context.messages[0];
  const duplicated = leading?.role === "system" && leading.content === prompt;
  if (prompt && !duplicated) tokens += MESSAGE_OVERHEAD_TOKENS + textTokens(prompt);
  for (const message of context.messages) tokens += MESSAGE_OVERHEAD_TOKENS + messageTokens(message);
  if (context.tools && context.tools.length > 0) tokens += MESSAGE_OVERHEAD_TOKENS + toolDefinitionTokens(context.tools);
  return tokens;
}

/** Resolve against the model request projection, including synthesized tool results. */
export function resolveOutputBudget(model: Model, context: Context, requested: number | undefined): OutputBudget {
  const limitProblem = modelLimitProblem(model.contextWindow, model.maxTokens, `Model ${model.id}`);
  const requestedProblem = requested === undefined ? undefined : requestLimitProblem(requested);
  const modelOutputCap = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 0;
  if (limitProblem || requestedProblem) {
    return {
      estimatedInput: 0,
      requestedOutput: typeof requested === "number" && Number.isFinite(requested) ? requested : modelOutputCap,
      modelOutputCap,
      remainingOutputRoom: 0,
      status: "invalid_limit",
      message: limitProblem ?? requestedProblem,
    };
  }
  let estimatedInput: number;
  try {
    estimatedInput = estimateRequestTokens({ ...context, messages: transformMessages(context.messages, model) });
  } catch (error) {
    return {
      estimatedInput: 0,
      requestedOutput: requested ?? model.maxTokens,
      modelOutputCap: model.maxTokens,
      remainingOutputRoom: 0,
      status: "unserializable",
      message: error instanceof Error ? error.message : "Tool argument or schema is not JSON-serializable",
    };
  }
  const remainingOutputRoom = model.contextWindow - estimatedInput - contextSafetyMargin(model.contextWindow);
  const requestedOutput = requested ?? model.maxTokens;
  const outputCap = Math.min(requestedOutput, model.maxTokens, remainingOutputRoom);
  if (remainingOutputRoom < 1 || outputCap < 1) {
    return {
      estimatedInput,
      requestedOutput,
      modelOutputCap: model.maxTokens,
      remainingOutputRoom,
      status: "cannot_fit",
      message: `Context budget cannot fit this request: estimated input ${estimatedInput}, remaining output room ${remainingOutputRoom}`,
    };
  }
  return {
    estimatedInput,
    requestedOutput,
    modelOutputCap: model.maxTokens,
    remainingOutputRoom,
    outputCap,
    status: "ok",
  };
}

function requestLimitProblem(value: number): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return "maxTokens must be a positive integer";
  return undefined;
}

function textTokens(value: string): number {
  const bytes = new TextEncoder().encode(value).length;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

function messageTokens(message: Message): number {
  if (message.role === "system") {
    return textTokens(message.content) + labelTokens(message.toolsAdded) + labelTokens(message.toolsRemoved);
  }
  if (message.role === "user") {
    if (typeof message.content === "string") return textTokens(message.content);
    let tokens = 0;
    for (const block of message.content) {
      tokens += block.type === "text" ? textTokens(block.text) : IMAGE_TOKEN_COST;
    }
    return tokens;
  }
  if (message.role === "toolResult") {
    return message.content.reduce((sum, block) => sum + textTokens(block.text), 0);
  }
  let tokens = 0;
  for (const block of message.content) {
    if (block.type === "text") tokens += textTokens(block.text) + textTokens(block.textSignature ?? "");
    else if (block.type === "thinking") tokens += textTokens(block.thinking) + textTokens(block.thinkingSignature ?? "");
    else tokens += textTokens(block.name) + textTokens(stringifyForBudget(block.arguments)) + textTokens(block.thoughtSignature ?? "");
  }
  return tokens;
}

function labelTokens(labels: readonly string[] | undefined): number {
  if (!labels || labels.length === 0) return 0;
  return labels.reduce((sum, label) => sum + textTokens(label), 0);
}

function toolDefinitionTokens(tools: readonly ToolDefinition[]): number {
  let tokens = 0;
  for (const tool of tools) {
    tokens += textTokens(tool.name) + textTokens(tool.description) + textTokens(stringifyForBudget(tool.parameters));
  }
  return tokens;
}

function stringifyForBudget(value: unknown): string {
  assertSerializable(value, new WeakSet());
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Tool argument or schema is not JSON-serializable");
  return encoded;
}

function assertSerializable(value: unknown, stack: WeakSet<object>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Tool argument or schema is not JSON-serializable");
    return;
  }
  if (typeof value !== "object") throw new Error("Tool argument or schema is not JSON-serializable");
  if (stack.has(value)) throw new Error("Tool argument or schema contains a circular reference");
  if (Array.isArray(value)) {
    stack.add(value);
    for (const item of value) assertSerializable(item, stack);
    stack.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Tool argument or schema is not JSON-serializable");
  stack.add(value);
  for (const key of Object.keys(value)) assertSerializable((value as Record<string, unknown>)[key], stack);
  stack.delete(value);
}
