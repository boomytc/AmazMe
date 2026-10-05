import type { AssistantAccumulator } from "./events.ts";
import { cacheMissInput, usageFromCounts } from "./events.ts";
import { isRecord } from "./prepare.ts";
import type { Context, Message, Model, ThinkingLevel } from "../types.ts";
import { messageText } from "../transform.ts";

export function googleBody(model: Model, context: Context, outputCap: number, effort: string | undefined, requested?: ThinkingLevel): Record<string, unknown> {
  const system = systemText(context);
  const thinkingConfig = googleThinkingConfig(model, effort, requested);
  const payload: Record<string, unknown> = {
    contents: toContents(context, model),
    generationConfig: {
      maxOutputTokens: outputCap,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (context.tools && context.tools.length > 0) {
    payload.tools = [{
      functionDeclarations: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    }];
  }
  return payload;
}

export function applyGoogleChunk(model: Model, acc: AssistantAccumulator, decoded: Record<string, unknown>, finish: { reason: string; tools: number }): void {
  const usage = isRecord(decoded.usageMetadata) ? decoded.usageMetadata : undefined;
  if (usage) {
    const cache = cacheMissInput(numberOf(usage.promptTokenCount), numberOf(usage.cachedContentTokenCount));
    const thoughts = numberOf(usage.thoughtsTokenCount);
    const reported = usageFromCounts(
      model,
      cache.input,
      (numberOf(usage.candidatesTokenCount) ?? 0) + (thoughts ?? 0),
      numberOf(usage.totalTokenCount),
      { cacheRead: cache.cacheRead, ...(thoughts !== undefined ? { reasoning: thoughts } : {}) },
    );
    if (reported) acc.usage(reported);
  }
  const candidates = Array.isArray(decoded.candidates) ? decoded.candidates : [];
  const candidate = candidates[0];
  if (!isRecord(candidate)) return;
  if (typeof candidate.finishReason === "string") finish.reason = candidate.finishReason;
  const content = isRecord(candidate.content) ? candidate.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  for (const [partIndex, part] of parts.entries()) {
    if (!isRecord(part)) continue;
    const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
    if (part.thought === true && typeof part.text === "string") acc.thinking(part.text, { ...(signature !== undefined ? { signature } : {}), ...(partIndex > 0 ? { newBlock: true } : {}) });
    else if (typeof part.text === "string") acc.text(part.text, { ...(signature !== undefined ? { signature } : {}), ...(partIndex > 0 ? { newBlock: true } : {}) });
    if (isRecord(part.functionCall)) {
      const name = typeof part.functionCall.name === "string" ? part.functionCall.name : "tool";
      const id = typeof part.functionCall.id === "string" && part.functionCall.id.length > 0 ? part.functionCall.id : undefined;
      const key = id ?? `tool_${finish.tools++}_${name}`;
      acc.tool(key, id, name, JSON.stringify(part.functionCall.args ?? {}), false, signature);
    }
  }
}

/** https://ai.google.dev/api/generate-content#FinishReason */
export function googleStop(reason: string): "stop" | "length" | "error" {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return "error";
}

export function finishGoogle(acc: AssistantAccumulator, reason: string, label: string): void {
  if (!reason) {
    acc.fail("error", `${label} stream ended without a finish reason`);
    return;
  }
  const mapped = googleStop(reason);
  if (mapped === "error") {
    acc.fail("error", `${label} stream: ${reason}`);
    return;
  }
  acc.finish(mapped);
}

function systemText(context: Context): string {
  const prompt = context.systemPrompt ?? "";
  const parts: string[] = [];
  const leading = context.messages[0];
  if (prompt && !(leading?.role === "system" && leading.content === prompt)) parts.push(prompt);
  for (const message of context.messages) if (message.role === "system") parts.push(message.content);
  return parts.join("\n");
}

interface GoogleContent {
  role: string;
  parts: unknown[];
}

function toContents(context: Context, model: Model): unknown[] {
  const contents: unknown[] = [];
  // Vision input alone does not imply support for nested function-response media.
  const version = /^gemini(?:-live)?-(\d+)(?:[.-]|$)/i.exec(model.id);
  const multimodalResponse = version !== null && Number(version[1]) >= 3;
  const responses: unknown[] = [];
  const attachments: unknown[] = [];
  const flush = () => {
    if (responses.length > 0) contents.push({ role: "user", parts: [...responses] });
    if (attachments.length > 0) contents.push({ role: "user", parts: [...attachments] });
    responses.length = 0;
    attachments.length = 0;
  };
  for (const message of context.messages) {
    if (message.role !== "toolResult") flush();
    if (message.role === "system") continue;
    const converted = convert(message, multimodalResponse);
    if (message.role !== "toolResult") {
      contents.push(converted);
      continue;
    }
    responses.push(...converted.parts);
    if (multimodalResponse || !message.content.some((block) => block.type === "image")) continue;
    attachments.push({ text: `Images from tool ${message.toolName} (call ${message.toolCallId}):` });
    for (const block of message.content) {
      if (block.type === "image") attachments.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
    }
  }
  flush();
  return contents;
}

function convert(message: Message, multimodalResponse: boolean): GoogleContent {
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
    const images = message.content.flatMap((block) => block.type === "image"
      ? [{ inlineData: { mimeType: block.mimeType, data: block.data } }]
      : []);
    const text = images.length > 0
      ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
      : messageText(message);
    return {
      role: "user",
      parts: [{
        functionResponse: {
          id: message.toolCallId,
          name: message.toolName,
          response: { result: text || (images.length > 0 ? "(see attached image)" : "") },
          ...(images.length > 0 && multimodalResponse ? { parts: images } : {}),
        },
      }],
    };
  }
  if (message.role !== "assistant") return { role: "user", parts: [{ text: message.content }] };
  const parts: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push({ text: block.text, ...(block.textSignature !== undefined ? { thoughtSignature: block.textSignature } : {}) });
    else if (block.type === "thinking") parts.push({ text: block.thinking, thought: true, ...(block.thinkingSignature !== undefined ? { thoughtSignature: block.thinkingSignature } : {}) });
    else parts.push({ functionCall: { id: block.id, name: block.name, args: block.arguments ?? {} }, ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}) });
  }
  return { role: "model", parts };
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Gemini 2.5 uses a token budget; Gemini 3 uses its declared discrete levels. */
function googleThinkingConfig(model: Model, effort: string | undefined, requested: ThinkingLevel | undefined): Record<string, unknown> | undefined {
  if (requested === undefined && effort === undefined) return undefined;
  if (!model.reasoning) return undefined;
  const discrete = /gemini-3(?:\.\d+)?-(?:pro|flash)/i.test(model.id) || /^gemini-flash(?:-lite)?-latest$/i.test(model.id) || /gemma-?4/i.test(model.id);
  if (requested === "off") {
    if (discrete || /gemini-2\.5-pro/i.test(model.id)) throw new Error(`Google model ${model.id} cannot disable thinking`);
    return { thinkingBudget: 0 };
  }
  if (!effort) return undefined;
  const level = effort.toLowerCase();
  if (!["minimal", "low", "medium", "high"].includes(level)) throw new Error(`Unsupported Google thinking level ${effort}`);
  if (discrete) return { thinkingLevel: level.toUpperCase(), includeThoughts: true };
  const pro = /gemini-2\.5-pro/i.test(model.id);
  const lite = /gemini-2\.5-flash-lite/i.test(model.id);
  const budgets: Record<string, number> = { minimal: lite ? 512 : 128, low: 2048, medium: 8192, high: pro ? 32768 : 24576 };
  // The budget guides reasoning; maxOutputTokens remains the independent hard output limit.
  return { thinkingBudget: budgets[level], includeThoughts: true };
}
