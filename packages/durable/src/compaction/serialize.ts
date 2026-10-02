import type { TranscriptEntry } from "./select.ts";
import { transcriptMessage } from "./select.ts";

/** Instructions for the single summary request. The old system prompt is transcript text, not this message. */
export const SUMMARY_SYSTEM_PROMPT = [
  "You summarize an earlier conversation so a later model turn can continue.",
  "Do not continue the conversation, do not call tools, and do not answer questions from the transcript.",
  "Preserve the goal, constraints, key decisions, progress, and next steps.",
  "If a previous summary is included, fold it into the new summary.",
  "An image attachment marker means an image was present. Do not claim you can see the image.",
].join("\n");

const TRUNCATED = "[truncated]";
const IMAGE_MARKER = "[Image attachment]";

interface Part {
  bucket: "fixed" | "tool" | "text";
  text: string;
}

/**
 * Serialize old entries as one transcript.
 * `toolLimit` and `textLimit` apply to tool results first and then to other text.
 * Image bytes are replaced with a marker. The original entries are not modified.
 */
export function summaryTranscript(
  systemPrompt: string,
  entries: readonly TranscriptEntry[],
  toolLimit: number,
  textLimit: number,
): string {
  const parts: Part[] = [{ bucket: "fixed", text: "Summarize the transcript below." }];
  if (systemPrompt) parts.push({ bucket: "text", text: `[System]\n${systemPrompt}` });
  for (const entry of entries) parts.push(...partsFor(entry));
  return parts.map((part) => render(part, toolLimit, textLimit)).filter((text) => text.length > 0).join("\n\n");
}

function render(part: Part, toolLimit: number, textLimit: number): string {
  if (part.bucket === "fixed") return part.text;
  if (part.bucket === "tool") return clip(part.text, toolLimit);
  return clip(part.text, textLimit);
}

function clip(text: string, limit: number): string {
  if (!Number.isFinite(limit) || text.length <= limit) return text;
  if (limit <= TRUNCATED.length) return TRUNCATED;
  const room = limit - TRUNCATED.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return text.slice(0, head) + TRUNCATED + (tail > 0 ? text.slice(text.length - tail) : "");
}

function partsFor(entry: TranscriptEntry): Part[] {
  if (entry.kind === "compaction") return [{ bucket: "text", text: `[Previous summary]\n${entry.summary}` }];
  const message = transcriptMessage(entry);
  if (message.role === "system") return [{ bucket: "text", text: `[System]\n${message.content}` }];
  if (message.role === "user") return userParts(message.content);
  if (message.role === "toolResult") {
    const text = message.content.map((block) => block.text).join("\n");
    return [{ bucket: "tool", text: `[ToolResult id=${message.toolCallId} name=${message.toolName}]\n${text}` }];
  }
  const parts: Part[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text) parts.push({ bucket: "text", text: `[Assistant]\n${block.text}` });
    else if (block.type === "thinking" && block.thinking) parts.push({ bucket: "text", text: `[Assistant thinking]\n${block.thinking}` });
    else if (block.type === "toolCall") {
      parts.push({
        bucket: "text",
        text: `[ToolCall id=${block.id} name=${block.name}]\n${stringifyArguments(block.arguments)}`,
      });
    }
  }
  return parts;
}

function userParts(content: string | Array<{ type: string; text?: string }>): Part[] {
  if (typeof content === "string") return [{ bucket: "text", text: `[User]\n${content}` }];
  const parts: Part[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ bucket: "text", text: `[User]\n${block.text ?? ""}` });
    else if (block.type === "image") parts.push({ bucket: "fixed", text: `[User]\n${IMAGE_MARKER}` });
  }
  return parts;
}

function stringifyArguments(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Tool argument or schema is not JSON-serializable");
    return encoded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Tool argument")) throw error;
    const circular = error instanceof Error && /circular/i.test(error.message);
    throw new Error(circular ? "Tool argument or schema contains a circular reference" : "Tool argument or schema is not JSON-serializable");
  }
}
