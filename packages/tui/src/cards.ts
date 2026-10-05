/**
 * 工具卡片。字段都从已经在快照里的条目、开放批次和审批列表推出来。
 * 这里不写新的持久字段。展开状态只留在这一屏。
 */

/** 展开后正文最多这么多行。折叠的运行中卡片仍只露输出尾三行。 */
export const TOOL_CARD_DETAIL_LIMIT = 20;

const ARG_SUMMARY_LIMIT = 80;
const DENIED_TEXT = "Tool call denied";

export type ToolCardStatus = "running" | "ok" | "error" | "denied" | "approval";

export interface ToolCardCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolCardEntry {
  id: string;
  role: "user" | "assistant" | "tool" | "other";
  text: string;
  title?: string;
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
  calls?: readonly ToolCardCall[];
}

export interface ToolCardLive {
  name: string;
  status: "planned" | "running" | "settled";
  outputTail?: string;
  toolCallId?: string;
}

export interface ToolCardApproval {
  toolCallId: string;
  name: string;
  summary: string;
}

export interface ToolCardInput {
  entries: readonly ToolCardEntry[];
  tools: readonly ToolCardLive[];
  approvals: readonly ToolCardApproval[];
}

export interface ToolCard {
  id: string;
  name: string;
  status: ToolCardStatus;
  /** 起止都在快照时间戳里才有。运行中还要绘制时传入的 now。 */
  durationMs: number | null;
  summary: string;
  /** 展开时的正文，已经截到 {@link TOOL_CARD_DETAIL_LIMIT} 行。 */
  detailLines: string[];
  /** 运行中折叠时露出的输出尾，最多三行。 */
  tailLines: string[];
  /** 跟在这条条目后面画。没有则画在记录末尾，例如还没有条目的开放批次。 */
  anchorId?: string;
}

export interface ToolCardRow {
  tone: "accent" | "dim" | "text" | "border";
  text: string;
}

const STATUS_LABEL: Record<ToolCardStatus, string> = {
  running: "运行中",
  ok: "成功",
  error: "失败",
  denied: "被拒",
  approval: "等审批",
};

/** 审批卡和工具卡共用的一行参数。对象变成 `key=value`，过长就截断。 */
export function summarizeArgs(args: unknown): string {
  const text = argText(args).replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= ARG_SUMMARY_LIMIT) return text;
  return `${chars.slice(0, ARG_SUMMARY_LIMIT - 1).join("")}…`;
}

export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1_000) return `${value}ms`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  const minutes = Math.floor(value / 60_000);
  let seconds = Math.round((value % 60_000) / 1_000);
  let shown = minutes;
  if (seconds === 60) {
    shown += 1;
    seconds = 0;
  }
  return `${shown}m${String(seconds).padStart(2, "0")}s`;
}

export function collectToolCards(input: ToolCardInput, now?: number): ToolCard[] {
  const approvals = new Map(input.approvals.map((item) => [item.toolCallId, item]));
  const results = new Map<string, { name: string; text: string; isError: boolean; timestamp?: number }>();
  for (const entry of input.entries) {
    if (entry.role !== "tool" || !entry.toolCallId) continue;
    results.set(entry.toolCallId, {
      name: entry.title && entry.title.length > 0 ? entry.title : "tool",
      text: entry.text,
      isError: entry.isError === true,
      ...(typeof entry.timestamp === "number" ? { timestamp: entry.timestamp } : {}),
    });
  }
  const liveById = new Map<string, ToolCardLive>();
  for (const tool of input.tools) {
    if (tool.toolCallId) liveById.set(tool.toolCallId, tool);
  }

  const cards: ToolCard[] = [];
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (entry.role !== "assistant" || !entry.calls) continue;
    for (const call of entry.calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      cards.push(makeCard({
        id: call.id,
        name: call.name,
        args: call.arguments,
        startedAt: entry.timestamp,
        anchorId: entry.id,
        result: results.get(call.id),
        live: liveById.get(call.id),
        approval: approvals.get(call.id),
        now,
      }));
    }
  }
  for (const entry of input.entries) {
    if (entry.role !== "tool") continue;
    const id = entry.toolCallId ?? `entry:${entry.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const named = entry.title && entry.title.length > 0 ? entry.title : "tool";
    cards.push(makeCard({
      id,
      name: entry.toolCallId ? (results.get(entry.toolCallId)?.name ?? named) : named,
      args: undefined,
      startedAt: undefined,
      anchorId: entry.id,
      result: entry.toolCallId ? results.get(entry.toolCallId) : {
        name: named,
        text: entry.text,
        isError: entry.isError === true,
        ...(typeof entry.timestamp === "number" ? { timestamp: entry.timestamp } : {}),
      },
      live: entry.toolCallId ? liveById.get(entry.toolCallId) : undefined,
      approval: entry.toolCallId ? approvals.get(entry.toolCallId) : undefined,
      now,
    }));
  }
  input.tools.forEach((tool, index) => {
    if (tool.toolCallId && seen.has(tool.toolCallId)) return;
    const id = tool.toolCallId ?? `live:${index}:${tool.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    cards.push(makeCard({
      id,
      name: tool.name,
      args: undefined,
      startedAt: undefined,
      result: tool.toolCallId ? results.get(tool.toolCallId) : undefined,
      live: tool,
      approval: tool.toolCallId ? approvals.get(tool.toolCallId) : undefined,
      now,
    }));
  });
  return cards;
}

export function toolCardRows(card: ToolCard, expanded: boolean): ToolCardRow[] {
  const duration = card.durationMs === null ? "" : `  ${formatDuration(card.durationMs)}`;
  const rows: ToolCardRow[] = [
    { tone: "accent", text: `┌ ${card.name}  ${statusText(card)}${duration}` },
  ];
  if (card.summary.length > 0) rows.push({ tone: "dim", text: `│ ${card.summary}` });
  const body = expanded ? card.detailLines : card.status === "running" ? card.tailLines : foldedErrorLine(card);
  for (const line of body) rows.push({ tone: "text", text: `│ ${line}` });
  rows.push({ tone: "border", text: "└" });
  return rows;
}

/** 带理由的拒绝用「已拒绝：理由」。没写理由仍是「被拒」。其余状态用固定词。 */
function statusText(card: ToolCard): string {
  if (card.status === "denied") {
    const reason = denialReason(card.detailLines.join("\n"));
    if (reason !== null && reason.length > 0) return summarizeArgs(`已拒绝：${reason}`);
  }
  return STATUS_LABEL[card.status];
}

/** 折叠的失败卡片露出错误第一行。摘要已经是这一行时不重复。过长按参数摘要的宽度截断。 */
function foldedErrorLine(card: ToolCard): string[] {
  if (card.status !== "error") return [];
  const line = card.detailLines.find((row) => row.trim().length > 0)?.trim() ?? "";
  if (line.length === 0) return [];
  const shown = summarizeArgs(line);
  if (shown.length === 0 || shown === card.summary) return [];
  return [shown];
}

function makeCard(input: {
  id: string;
  name: string;
  args: unknown;
  startedAt: number | undefined;
  anchorId?: string;
  result?: { text: string; isError: boolean; timestamp?: number };
  live?: ToolCardLive;
  approval?: ToolCardApproval;
  now?: number;
}): ToolCard {
  const status = cardStatus(input.id, input.result, input.live, input.approval);
  const summary = cardSummary(input.args, input.approval, input.result?.text);
  const detailLines = input.result && input.result.text.length > 0
    ? clippedLines(input.result.text, TOOL_CARD_DETAIL_LIMIT)
    : status === "running" && input.live?.outputTail
      ? lastLines(input.live.outputTail, TOOL_CARD_DETAIL_LIMIT)
      : [];
  return {
    id: input.id,
    name: input.name,
    status,
    durationMs: cardDuration(status, input.startedAt, input.result?.timestamp, input.now),
    summary,
    detailLines,
    tailLines: status === "running" && input.live?.outputTail ? lastOutputLines(input.live.outputTail) : [],
    ...(input.anchorId ? { anchorId: input.anchorId } : {}),
  };
}

function cardStatus(
  id: string,
  result: { text: string; isError: boolean } | undefined,
  live: ToolCardLive | undefined,
  approval: ToolCardApproval | undefined,
): ToolCardStatus {
  if (approval && approval.toolCallId === id) return "approval";
  if (live?.status === "running" || live?.status === "planned") return "running";
  if (result?.isError && isDenied(result.text)) return "denied";
  if (result?.isError) return "error";
  if (result) return "ok";
  if (live?.status === "settled") return "ok";
  return "running";
}

/**
 * 快照里没有单独的拒绝标记。没写原因时，结果正文就是 `Tool call denied`。
 * 写了原因时，正文是这句再加一行理由，或 `Tool call denied: 理由`。卡片标「已拒绝：理由」。
 * 只有理由、没有这句时，和工具错误是同一份正文，卡片仍标失败。
 */
function denialReason(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === DENIED_TEXT) return "";
  let rest = "";
  if (trimmed.startsWith(`${DENIED_TEXT}\n`)) rest = trimmed.slice(DENIED_TEXT.length + 1);
  else if (trimmed.startsWith(`${DENIED_TEXT}:`)) rest = trimmed.slice(DENIED_TEXT.length + 1);
  else if (trimmed.startsWith(`${DENIED_TEXT}：`)) rest = trimmed.slice(DENIED_TEXT.length + 1);
  else return null;
  const line = rest.split("\n").find((row) => row.trim().length > 0)?.trim() ?? "";
  return line;
}

function isDenied(text: string): boolean {
  return denialReason(text) !== null;
}

function cardDuration(
  status: ToolCardStatus,
  startedAt: number | undefined,
  endedAt: number | undefined,
  now: number | undefined,
): number | null {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const end = status === "running" || status === "approval" ? now : endedAt;
  if (typeof end !== "number" || !Number.isFinite(end)) return null;
  return Math.max(0, end - startedAt);
}

function cardSummary(args: unknown, approval: ToolCardApproval | undefined, resultText: string | undefined): string {
  if (args !== undefined) {
    const fromArgs = summarizeArgs(args);
    if (fromArgs.length > 0) return fromArgs;
  }
  if (approval && approval.summary.length > 0) return approval.summary;
  return firstLine(resultText ?? "");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((row) => row.trim().length > 0) ?? "";
  return summarizeArgs(line);
}

function clippedLines(text: string, limit: number): string[] {
  if (text.length === 0 || limit <= 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.slice(0, limit);
}

function lastOutputLines(tail: string): string[] {
  return lastLines(tail, 3);
}

function lastLines(text: string, limit: number): string[] {
  if (text.length === 0 || limit <= 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.slice(-limit);
}

function argText(args: unknown): string {
  if (typeof args === "string") return args;
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  if (Array.isArray(args)) return jsonBit(args);
  if (typeof args === "object" && args !== null) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      parts.push(`${key}=${typeof value === "string" ? value : jsonBit(value)}`);
    }
    return parts.join(" ");
  }
  return "";
}

function jsonBit(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
