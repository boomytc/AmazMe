import type { AssistantAccumulator } from "./events.ts";
import { usageFromCounts } from "./events.ts";
import { isRecord } from "./prepare.ts";
import type { Context, Message, Model } from "../types.ts";
import { messageText } from "../transform.ts";

export function googleBody(model: Model, context: Context, outputCap: number, effort: string | undefined): Record<string, unknown> {
  const system = systemText(context);
  const payload: Record<string, unknown> = {
    contents: toContents(context),
    generationConfig: {
      maxOutputTokens: outputCap,
      ...(effort ? { thinkingConfig: { thinkingLevel: effort } } : {}),
    },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (context.tools && context.tools.length > 0) {
    payload.tools = [{
      functionDeclarations: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }];
  }
  void model;
  return payload;
}

export function applyGoogleChunk(model: Model, acc: AssistantAccumulator, decoded: Record<string, unknown>, finish: { reason: string }): void {
  const usage = isRecord(decoded.usageMetadata) ? decoded.usageMetadata : undefined;
  if (usage) {
    const reported = usageFromCounts(
      model,
      numberOf(usage.promptTokenCount),
      numberOf(usage.candidatesTokenCount),
      numberOf(usage.totalTokenCount),
    );
    if (reported) acc.usage(reported);
  }
  const candidates = Array.isArray(decoded.candidates) ? decoded.candidates : [];
  const candidate = candidates[0];
  if (!isRecord(candidate)) return;
  if (typeof candidate.finishReason === "string") finish.reason = candidate.finishReason;
  const content = isRecord(candidate.content) ? candidate.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  parts.forEach((part, index) => {
    if (!isRecord(part)) return;
    if (part.thought === true && typeof part.text === "string") acc.thinking(part.text);
    else if (typeof part.text === "string") acc.text(part.text);
    if (isRecord(part.functionCall)) {
      const name = typeof part.functionCall.name === "string" ? part.functionCall.name : "tool";
      const args = part.functionCall.args ?? {};
      acc.tool(`tool_${index}_${name}`, typeof part.functionCall.id === "string" ? part.functionCall.id : undefined, name, JSON.stringify(args));
    }
  });
}

export function googleStop(reason: string): "stop" | "length" | "toolUse" {
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

function systemText(context: Context): string {
  const prompt = context.systemPrompt ?? "";
  const parts: string[] = [];
  const leading = context.messages[0];
  if (prompt && !(leading?.role === "system" && leading.content === prompt)) parts.push(prompt);
  for (const message of context.messages) if (message.role === "system") parts.push(message.content);
  return parts.join("\n");
}

function toContents(context: Context): unknown[] {
  const contents: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    contents.push(convert(message));
  }
  return contents;
}

function convert(message: Message): unknown {
  if (message.role === "user") {
    if (typeof message.content === "string") return { role: "user", parts: [{ text: message.content }] };
    return {
      role: "user",
      parts: message.content.map((block) => block.type === "text"
        ? { text: block.text }
        : { inlineData: { mimeType: block.mimeType, data: block.data } }),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "user",
      parts: [{ functionResponse: { name: message.toolName, response: { result: messageText(message) } } }],
    };
  }
  if (message.role !== "assistant") return { role: "user", parts: [{ text: message.content }] };
  const parts: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push({ text: block.text });
    else if (block.type === "thinking") parts.push({ text: block.thinking, thought: true });
    else parts.push({ functionCall: { name: block.name, args: block.arguments ?? {} } });
  }
  return { role: "model", parts };
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
