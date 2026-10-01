import type { AssistantContent, AssistantMessage, Message, Model, TextContent, ToolResultMessage, UserContent } from "./types.ts";

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
 * Images disappear on text-only models. Tool ids are rewritten and the
 * matching tool results follow the new ids. Thinking blocks stay as text
 * when the destination has no native thinking channel (`api` other than
 * anthropic-messages / google-generative-ai).
 */
export function transformMessages(messages: Message[], model: Model): Message[] {
  const idMap = new Map<string, string>();
  const keepThinking = model.api === "anthropic-messages" || model.api === "google-generative-ai";
  const vision = model.input.includes("image");

  const transformed = messages.map((message): Message => {
    if (message.role === "user") {
      if (vision || typeof message.content === "string") return message;
      return { ...message, content: downgradeImages(message.content, USER_IMAGE) };
    }
    if (message.role === "toolResult") {
      if (vision) return message;
      return { ...message, content: downgradeImages(message.content, TOOL_IMAGE) };
    }
    if (message.role !== "assistant") return message;
    const content: AssistantContent[] = [];
    for (const block of message.content) {
      if (block.type === "toolCall") {
        const id = normalizeToolCallId(block.id);
        idMap.set(block.id, id);
        content.push({ ...block, id });
        continue;
      }
      if (block.type === "thinking" && !keepThinking) {
        content.push(text(block.thinking));
        continue;
      }
      content.push(block);
    }
    return { ...message, content };
  });

  return transformed.map((message) => {
    if (message.role !== "toolResult") return message;
    const id = idMap.get(message.toolCallId) ?? normalizeToolCallId(message.toolCallId);
    return { ...message, toolCallId: id };
  });
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
