import { isCompletionsThinkingField, type AssistantContent, type AssistantMessage, type Message, type Model, type TextContent, type ThinkingContent, type ToolCall, type ToolResultMessage, type UserContent } from "./types.ts";

const USER_IMAGE = "(image omitted: model does not support images)";
const TOOL_IMAGE = "(tool image omitted: model does not support images)";

function text(value: string): TextContent {
  return { type: "text", text: value };
}

/** Anthropic accepts tool ids matching this shape, max 64 characters. */
export function normalizeToolCallId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned.length <= 64 && cleaned === id) return id;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, "0");
  const head = cleaned.slice(0, 64 - 1 - suffix.length);
  return `${head}_${suffix}`;
}

function downgradeImages(content: UserContent[], placeholder: string): TextContent[] {
  const result: TextContent[] = [];
  for (const block of content) {
    if (block.type === "image") {
      if (result[result.length - 1]?.text !== placeholder) result.push(text(placeholder));
      continue;
    }
    result.push(block);
  }
  return result;
}

/**
 * Make one transcript acceptable to another provider.
 * Images disappear on text-only models. Tool ids are normalized except for
 * same-origin Google calls, whose native ids must be returned exactly. Tool
 * results follow the mapped ids. A completions thinking block
 * keeps its field when the destination api is openai-completions. Every
 * other destination receives that text as an ordinary assistant answer.
 * Native signatures are replayed only to the same provider/api/model. Foreign
 * signed thinking becomes text; redacted payloads are omitted from that projection.
 * Unsigned Anthropic and Google thinking follows the existing block policy.
 * Failed assistant prefixes are omitted and unanswered calls receive error
 * results in this request projection. The source transcript is not rewritten.
 */
export function transformMessages(messages: Message[], model: Model): Message[] {
  const idMap = new Map<string, string>();
  const vision = model.input.includes("image");

  const transformed = messages.map((message): Message => {
    if (message.role === "user") {
      if (vision || typeof message.content === "string") return message;
      return { ...message, content: downgradeImages(message.content, USER_IMAGE) };
    }
    if (message.role === "toolResult") {
      const toolCallId = idMap.get(message.toolCallId) ?? normalizeToolCallId(message.toolCallId);
      return { ...message, toolCallId, ...(vision ? {} : { content: downgradeImages(message.content, TOOL_IMAGE) }) };
    }
    if (message.role !== "assistant") return message;
    idMap.clear();
    const sameOrigin = message.api === model.api && message.provider === model.provider && message.model === model.id;
    const content: AssistantContent[] = [];
    for (const block of message.content) {
      if (block.type === "toolCall") {
        const preserveNativeId = sameOrigin && (model.api === "google-generative-ai" || model.api === "google-vertex");
        const id = preserveNativeId ? block.id : normalizeToolCallId(block.id);
        idMap.set(block.id, id);
        const { thoughtSignature, ...call } = block;
        content.push({ ...call, id, ...(sameOrigin && thoughtSignature !== undefined ? { thoughtSignature } : {}) });
        continue;
      }
      if (block.type === "thinking" && block.redacted && !sameOrigin) continue;
      if (block.type === "thinking" && !keepThinkingBlock(block, model, sameOrigin)) {
        content.push(text(block.thinking));
        continue;
      }
      if (!sameOrigin && block.type === "text") {
        const { textSignature, ...plain } = block;
        content.push(plain);
      } else if (!sameOrigin && block.type === "thinking") {
        const { thinkingSignature, redacted, ...plain } = block;
        content.push(plain);
      } else content.push(block);
    }
    return { ...message, content };
  });

  return reconcileToolResults(transformed);
}

function keepThinkingBlock(block: ThinkingContent, model: Model, sameOrigin: boolean): boolean {
  if (["anthropic-messages", "google-generative-ai", "google-vertex", "bedrock-converse-stream"].includes(model.api)) return sameOrigin || block.thinkingSignature === undefined;
  return model.api === OPENAI_COMPLETIONS_API && isCompletionsThinkingField(block.thinkingField);
}

const OPENAI_COMPLETIONS_API = "openai-completions";

function reconcileToolResults(messages: Message[]): Message[] {
  const projected: Message[] = [];
  let pending: ToolCall[] = [];
  const answered = new Set<string>();
  const heldSystems: Message[] = [];
  const closeTurn = () => {
    for (const call of pending) {
      if (!answered.has(call.id)) projected.push({
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "No tool result was recorded" }],
        isError: true, timestamp: Date.now(),
      });
    }
    pending = [];
    answered.clear();
    projected.push(...heldSystems);
    heldSystems.length = 0;
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      closeTurn();
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") continue;
      pending = findToolCalls(message);
    } else if (message.role === "user") {
      closeTurn();
    } else if (message.role === "system" && pending.length > 0) {
      // Keep system updates after all real and synthesized results in this group.
      heldSystems.push(message);
      continue;
    } else if (message.role === "toolResult") {
      answered.add(message.toolCallId);
    }
    projected.push(message);
  }
  closeTurn();
  return projected;
}

export function findToolCalls(message: AssistantMessage): Array<Extract<AssistantMessage["content"][number], { type: "toolCall" }>> {
  return message.content.filter((block) => block.type === "toolCall");
}

export function messageText(message: Message): string {
  if (message.role === "system") return message.content;
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("");
}

export function normalizeContext(context: { systemPrompt?: string; messages: Message[]; tools?: import("./types.ts").ToolDefinition[] }): {
  systemPrompt?: string;
  messages: Message[];
  tools: import("./types.ts").ToolDefinition[];
} {
  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => {
      if (message.role === "user" && message.content == null) return { ...message, content: "" };
      return message;
    }),
    tools: context.tools ?? [],
  };
}

export function emptyUsage(): import("./types.ts").Usage {
  return { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } };
}

export function estimateTokens(textValue: string): number {
  return Math.ceil(textValue.length / 4);
}

export type { ToolResultMessage };
