import {
  resolveOutputBudget,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ToolDefinition,
} from "@amazme/ai";
import { summaryOutputLimit } from "./policy.ts";
import { selectTail, transcriptMessage, type TailCut, type TranscriptEntry } from "./select.ts";
import { SUMMARY_SECTION_HEADINGS, SUMMARY_SYSTEM_PROMPT, summaryTranscript } from "./serialize.ts";

const SHRINK_LIMITS = [Number.POSITIVE_INFINITY, 4_000, 1_000, 240, 80, 0];

export interface CompactionRequest {
  entries: readonly TranscriptEntry[];
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  model: Model;
  /** Generation output cap. Undefined uses the model cap. Not the compaction input trigger. */
  requestedOutput?: number;
  boundary: "resume" | "finish" | "navigation";
  keepTokens: number;
}

export interface PlannedCompaction {
  summarizedIds: string[];
  keptIds: string[];
  keptMessages: Message[];
  context: Context;
  maxTokens: number;
  estimatedInput: number;
}

export type PlanResult =
  | { ok: true; plan: PlannedCompaction }
  | { ok: false; code: "nothing_to_compact" | "cannot_fit" | "invalid"; message: string };

/** Build the one summary request for a selected tail. Returns before any model call. */
export function planCompaction(request: CompactionRequest): PlanResult {
  if (request.boundary !== "navigation") {
    const selected = selectFittingTail(request);
    if (!selected.ok) return selected;
    return buildPlan(request, selected.cut);
  }
  const selected = selectTail(request.entries, request.keepTokens, request.boundary);
  if (!selected.ok) return { ok: false, code: "nothing_to_compact", message: selected.message };
  return buildPlan(request, selected.cut);
}

function buildPlan(request: CompactionRequest, cut: TailCut): PlanResult {
  const summarized = cut.summarized;
  const kept = cut.kept;
  const maxTokens = summaryOutputLimit(request.model.maxTokens, request.model.contextWindow);
  let transcript: string;
  let budget: ReturnType<typeof resolveOutputBudget>;
  try {
    const shrunk = shrinkToFit(request.model, request.systemPrompt, summarized, maxTokens);
    if (!shrunk) {
      return { ok: false, code: "cannot_fit", message: "Summary request cannot fit after shortening old content" };
    }
    transcript = shrunk.transcript;
    budget = shrunk.budget;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool argument or schema is not JSON-serializable";
    return { ok: false, code: "invalid", message };
  }
  if (budget.status === "invalid_limit" || budget.status === "unserializable") {
    return { ok: false, code: "invalid", message: budget.message ?? "Summary request is invalid" };
  }
  if (budget.status !== "ok" || budget.outputCap === undefined) {
    return { ok: false, code: "cannot_fit", message: budget.message ?? "Summary request cannot fit" };
  }
  return {
    ok: true,
    plan: {
      summarizedIds: summarized.map((entry) => entry.id),
      keptIds: kept.map((entry) => entry.id),
      keptMessages: kept.map(transcriptMessage),
      context: summaryContext(transcript),
      maxTokens: budget.outputCap,
      estimatedInput: budget.estimatedInput,
    },
  };
}

/** Rebuild one summary request from the entries chosen before the call. Does not select a new range. */
export function fitSummaryRequest(
  model: Model,
  systemPrompt: string,
  entries: readonly TranscriptEntry[],
  requestedOutput: number,
): { ok: true; context: Context; maxTokens: number } | { ok: false; message: string } {
  try {
    const shrunk = shrinkToFit(model, systemPrompt, entries, requestedOutput);
    if (!shrunk || shrunk.budget.status !== "ok" || shrunk.budget.outputCap === undefined) {
      return { ok: false, message: shrunk?.budget.message ?? "Summary request cannot fit after shortening old content" };
    }
    return { ok: true, context: summaryContext(shrunk.transcript), maxTokens: shrunk.budget.outputCap };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Tool argument or schema is not JSON-serializable" };
  }
}

/** The request that continues after a published summary. */
export function continuationContext(
  systemPrompt: string,
  summary: string,
  kept: readonly Message[],
  tools: readonly ToolDefinition[],
): Context {
  return {
    systemPrompt,
    messages: [{ role: "user", content: summary, timestamp: 0 }, ...kept],
    tools: [...tools],
  };
}

/** A stopped reply shorter than this is not a summary. */
export const SUMMARY_MIN_CHARS = 80;

/** A summary can be published only when the model stopped with sectioned text and no tool call. */
export function acceptedSummary(message: AssistantMessage): string | undefined {
  if (message.stopReason !== "stop") return undefined;
  if (message.content.some((block) => block.type === "toolCall")) return undefined;
  const text = summaryText(message);
  if (text.length < SUMMARY_MIN_CHARS) return undefined;
  if (!SUMMARY_SECTION_HEADINGS.some((heading) => text.includes(heading))) return undefined;
  return text;
}

export function summaryRejection(message: AssistantMessage): string {
  if (message.stopReason === "length") return "summary was truncated";
  if (message.content.some((block) => block.type === "toolCall")) return "summary called a tool";
  if (message.stopReason === "error") return message.errorMessage ?? "summary failed";
  if (message.stopReason === "aborted") return message.errorMessage ?? "summary aborted";
  const text = summaryText(message);
  if (text.length === 0) return "summary was empty";
  if (text.length < SUMMARY_MIN_CHARS) return "summary was too short";
  return "summary had no section heading";
}

function summaryText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}

function selectFittingTail(
  request: CompactionRequest,
): { ok: true; cut: TailCut } | Extract<PlanResult, { ok: false }> {
  const fit = (kept: readonly TranscriptEntry[]) => resolveOutputBudget(
    request.model,
    { systemPrompt: request.systemPrompt, messages: kept.map(transcriptMessage), tools: [...request.tools] },
    request.requestedOutput,
  );
  let selected = selectTail(request.entries, request.keepTokens, request.boundary);
  if (!selected.ok) return rejectUncut(fit, request.entries, selected.message);
  let budget = fit(selected.cut.kept);
  if ((budget.status === "invalid_limit" || budget.status === "unserializable") && request.keepTokens > 0) {
    return { ok: false, code: "invalid", message: budget.message ?? "Context budget is invalid" };
  }
  if (budget.status !== "ok" && request.keepTokens > 0) {
    selected = selectTail(request.entries, 0, request.boundary);
    if (!selected.ok) return rejectUncut(fit, request.entries, selected.message);
    budget = fit(selected.cut.kept);
  }
  if (budget.status === "ok") return selected;
  if (budget.status === "cannot_fit") {
    return {
      ok: false,
      code: "cannot_fit",
      message: "Current input, system prompt, and tool definitions cannot fit in the context window",
    };
  }
  return { ok: false, code: "invalid", message: budget.message ?? "Context budget is invalid" };
}

function rejectUncut(
  fit: (kept: readonly TranscriptEntry[]) => ReturnType<typeof resolveOutputBudget>,
  entries: readonly TranscriptEntry[],
  message: string,
): Extract<PlanResult, { ok: false }> {
  const whole = fit(entries);
  if (whole.status === "invalid_limit" || whole.status === "unserializable") {
    return { ok: false, code: "invalid", message: whole.message ?? "Context budget is invalid" };
  }
  if (whole.status === "cannot_fit") {
    return {
      ok: false,
      code: "cannot_fit",
      message: "Current input, system prompt, and tool definitions cannot fit in the context window",
    };
  }
  return { ok: false, code: "nothing_to_compact", message };
}

function shrinkToFit(
  model: Model,
  systemPrompt: string,
  summarized: readonly TranscriptEntry[],
  maxTokens: number,
): { transcript: string; budget: ReturnType<typeof resolveOutputBudget> } | undefined {
  const attempt = (toolLimit: number, textLimit: number) => {
    const transcript = summaryTranscript(systemPrompt, summarized, toolLimit, textLimit);
    const budget = resolveOutputBudget(model, summaryContext(transcript), maxTokens);
    return { transcript, budget };
  };
  for (const toolLimit of SHRINK_LIMITS) {
    const candidate = attempt(toolLimit, Number.POSITIVE_INFINITY);
    if (candidate.budget.status === "ok") return candidate;
    if (candidate.budget.status === "invalid_limit" || candidate.budget.status === "unserializable") return candidate;
  }
  for (const textLimit of SHRINK_LIMITS) {
    const candidate = attempt(0, textLimit);
    if (candidate.budget.status === "ok") return candidate;
    if (candidate.budget.status === "invalid_limit" || candidate.budget.status === "unserializable") return candidate;
  }
  return undefined;
}

function summaryContext(transcript: string): Context {
  const body = transcript.replace(/<\s*\/?\s*conversation\s*>/gi, (tag) => tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  return {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `<conversation>\n${body}\n</conversation>`, timestamp: 0 }],
    tools: [],
  };
}
