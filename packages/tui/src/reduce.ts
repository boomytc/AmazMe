import { activeBinding, composerHint, hotkeyText, type BindingId } from "./bindings.ts";
import { parseSlash, slashMatches, type SlashAction } from "./commands.ts";
import type { Key } from "./keys.ts";
import { markdownLines } from "./markdown.ts";
import { paint, theme } from "./theme.ts";

export interface PickerRow {
  id: string;
  label: string;
  detail: string;
  tone: "ok" | "muted";
}

export interface Picker {
  title: string;
  hint: string;
  query: string;
  index: number;
  rows: PickerRow[];
  kind: "login-entry" | "login-provider" | "logout-provider" | "login-method" | "api-key" | "model" | "thinking" | "resume" | "tree";
  /** Provider chosen before an authentication method or an API key. */
  subject?: string;
  secret?: boolean;
}

export interface TuiEntry {
  id: string;
  role: "user" | "assistant" | "tool" | "other";
  text: string;
  /** Tool name for a result block. Absent on user and assistant text. */
  title?: string;
}

export interface TuiTool {
  name: string;
  status: "planned" | "running" | "settled";
}

export interface TuiWindow {
  entries: TuiEntry[];
  pendingText: string;
  tools: TuiTool[];
  busy: boolean;
  sessions: string[];
  active: string;
}

/**
 * 协议已经算好的用量。缺了就不显示。
 * 这个包不估算 token、上下文占比、命中率或花费。
 */
export interface TuiMeters {
  tokens?: number;
  /** Already a percent, 0–100. */
  contextPercent?: number;
  /** Already a percent, 0–100. */
  hitPercent?: number;
  /** USD already totaled. */
  costUsd?: number;
}

export interface TuiState extends TuiWindow {
  focus: "prompt" | "scroll";
  entryIndex: number;
  turnIndex: number;
  input: string;
  /** Code-point index in `input`. The cursor may sit after the last character. */
  cursor: number;
  notice: string | null;
  menuIndex: number;
  provider: string;
  modelId: string;
  thinking: string;
  directory: string;
  picker: Picker | null;
  /** Empty idle Ctrl-C is armed. The next Ctrl-C quits. */
  exitArmed: boolean;
  /** Submitted composer texts, oldest first. */
  history: string[];
  /** Index into `history` while recalling. Null while the draft is live. */
  historyAt: number | null;
  /** Composer text saved when recall starts. */
  draft: string;
  /** Shortcut sheet over the transcript. */
  overlay: boolean;
  /**
   * Follow-ups this screen got accepted while the lane stayed busy.
   * The protocol does not report queue length yet. Idle clears it.
   */
  queued: number;
  meters: TuiMeters;
}

export type TuiEffect =
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "slash"; command: SlashAction }
  | { type: "pick"; kind: Picker["kind"]; id: string; subject?: string; secret?: string }
  | { type: "quit" };

/** Shown after the first Ctrl-C on an idle, empty prompt. */
export const EXIT_HINT = "再按一次 Ctrl-C 退出";
export const EXIT_WINDOW_MS = 1_500;

export function emptyTui(active = "main"): TuiState {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: false,
    sessions: [active],
    active,
    directory: "",
    focus: "prompt",
    entryIndex: 0,
    turnIndex: 0,
    input: "",
    cursor: 0,
    notice: null,
    menuIndex: 0,
    provider: "",
    modelId: "",
    thinking: "",
    picker: null,
    exitArmed: false,
    history: [],
    historyAt: null,
    draft: "",
    overlay: false,
    queued: 0,
    meters: {},
  };
}

export function reduceTui(state: TuiState, action: { type: "window"; window: TuiWindow } | { type: "key"; key: Key }): { state: TuiState; effect: TuiEffect | null } {
  if (action.type === "window") return { state: applyWindow(state, action.window), effect: null };
  return applyKey(state, action.key);
}

/** Conversation, slash menu, status, and composer. The composer stays on the last row. */
export function renderTui(state: TuiState, columns = 100, rows = 32): string {
  const width = Math.max(20, columns);
  const height = Math.max(8, rows);
  const composer = composerLines(state, width);
  const status = paint(theme.dim, fit(statusLine(state), width));
  const rule = paint(theme.border, "─".repeat(Math.min(width, 80)));
  const menu = state.picker ? [] : menuLines(state, width);
  const picker = state.picker ? pickerLines(state.picker, width) : [];
  const notice = state.notice ? state.notice.split("\n").slice(0, 8).map((line) => paint(theme.dim, fit(line, width))) : [];
  const hint = paint(theme.dim, fit(composerHint(), width));
  const transcript = transcriptLines(state).flatMap((line) => wrap(line, width));
  const footer = [status, hint, rule, ...composer];
  if (state.overlay) {
    const reserved = [...picker, ...menu, ...notice, ...footer];
    const kept = reserved.length >= height ? reserved.slice(-(height - 1)) : reserved;
    const overlay = overlayLines(state, width, height - kept.length);
    const chrome = [...overlay, ...kept];
    const room = Math.max(0, height - chrome.length);
    const visible = transcript.slice(-room);
    while (visible.length < room) visible.unshift("");
    return [...visible, ...chrome].join("\n");
  }
  const chrome = [...picker, ...menu, ...notice, ...footer];
  const room = Math.max(1, height - chrome.length);
  const visible = transcript.slice(-room);
  while (visible.length < room) visible.unshift("");
  return [...visible, ...chrome].slice(-height).join("\n");
}

function applyWindow(state: TuiState, window: TuiWindow): TuiState {
  const turns = turnStarts(window.entries);
  const entryIndex = clamp(state.entryIndex, window.entries.length);
  const turnIndex = clamp(state.turnIndex, turns.length);
  const next = { ...state, ...window, entryIndex, turnIndex };
  if (!window.busy) next.queued = 0;
  return next;
}

function applyKey(state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } {
  if (key.type !== "ctrl-c") state = forgetExit(state);
  if (key.type === "paste") return applyPaste(state, key.text);
  if (state.picker) return pickerKey(forgetExit(state), key);
  const binding = activeBinding(state, key);
  if (!binding) return { state, effect: null };
  return runBinding(binding.id, state, key);
}

function runBinding(id: BindingId, state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } {
  switch (id) {
    case "submit":
      return acceptOrSubmit(state);
    case "newline":
      return { state: insertText(state, "\n"), effect: null };
    case "prompt-up":
      return onVertical(state, -1);
    case "prompt-down":
      return onVertical(state, 1);
    case "cursor-left":
      return { state: moveCursor(state, -1), effect: null };
    case "cursor-right":
      return { state: moveCursor(state, 1), effect: null };
    case "backspace":
      return { state: deleteBeforeCursor(state), effect: null };
    case "complete":
      return completeSlash(state);
    case "dismiss":
      if (state.overlay) return { state: { ...state, overlay: false }, effect: null };
      return { state: { ...state, focus: state.focus === "prompt" ? "scroll" : "prompt", notice: null }, effect: null };
    case "overlay":
      return { state: { ...state, overlay: true, notice: null }, effect: null };
    case "interrupt":
      return onInterrupt(state);
    case "leave":
      return { state: { ...state, exitArmed: false, notice: null }, effect: { type: "quit" } };
    case "scroll-up":
      return { state: move(state, { type: "up" }), effect: null };
    case "scroll-down":
      return { state: move(state, { type: "down" }), effect: null };
    case "scroll-page-up":
      return { state: move(state, { type: "page-up" }), effect: null };
    case "scroll-page-down":
      return { state: move(state, { type: "page-down" }), effect: null };
    case "scroll-edit":
      return { state: move(state, { type: "char", value: "i" }), effect: null };
    case "insert":
      return key.type === "char" ? { state: insertText(state, key.value), effect: null } : { state, effect: null };
    default: {
      const unreachable: never = id;
      return unreachable;
    }
  }
}

function applyPaste(state: TuiState, text: string): { state: TuiState; effect: TuiEffect | null } {
  if (state.overlay) return { state, effect: null };
  if (state.picker) {
    const extra = text.replace(/\n/g, "");
    return { state: { ...state, picker: { ...state.picker, query: state.picker.query + extra, index: 0 } }, effect: null };
  }
  if (state.focus !== "prompt") return { state, effect: null };
  return { state: insertText(state, text), effect: null };
}

function onVertical(state: TuiState, direction: -1 | 1): { state: TuiState; effect: TuiEffect | null } {
  const matches = slashMatches(state.input);
  if (matches.length > 0) {
    const menuIndex = (state.menuIndex + direction + matches.length) % matches.length;
    return { state: { ...state, menuIndex }, effect: null };
  }
  const line = lineInfo(state.input, state.cursor);
  if (direction < 0 && !line.first) return { state: moveLine(state, -1), effect: null };
  if (direction > 0 && !line.last) return { state: moveLine(state, 1), effect: null };
  return { state: direction < 0 ? historyUp(state) : historyDown(state), effect: null };
}

function completeSlash(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  const matches = slashMatches(state.input);
  const picked = matches[clamp(state.menuIndex, matches.length)];
  if (!picked) return { state, effect: null };
  const suffix = picked.takesArgs === "required" ? " " : "";
  const input = `/${picked.name}${suffix}`;
  return { state: { ...state, input, cursor: Array.from(input).length, menuIndex: 0, notice: null, historyAt: null, draft: input }, effect: null };
}

function onInterrupt(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  if (state.busy) return { state: forgetExit(state), effect: { type: "abort" } };
  if (state.input.length > 0) return { state: { ...forgetExit(state), input: "", cursor: 0, historyAt: null, draft: "" }, effect: null };
  if (state.exitArmed) return { state: { ...state, exitArmed: false, notice: null }, effect: { type: "quit" } };
  return { state: { ...state, exitArmed: true, notice: EXIT_HINT }, effect: null };
}

function forgetExit(state: TuiState): TuiState {
  if (!state.exitArmed) return state;
  return { ...state, exitArmed: false, notice: state.notice === EXIT_HINT ? null : state.notice };
}

function pickerKey(state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } {
  const picker = state.picker;
  if (!picker) return { state, effect: null };
  if (key.type === "escape" || key.type === "ctrl-c") return { state: { ...state, picker: null }, effect: null };
  const rows = visibleRows(picker);
  if (key.type === "up" || key.type === "down") {
    if (rows.length === 0) return { state, effect: null };
    const delta = key.type === "up" ? -1 : 1;
    const index = (picker.index + delta + rows.length) % rows.length;
    return { state: { ...state, picker: { ...picker, index } }, effect: null };
  }
  if (key.type === "backspace") {
    const chars = Array.from(picker.query);
    chars.pop();
    return { state: { ...state, picker: { ...picker, query: chars.join(""), index: 0 } }, effect: null };
  }
  if (key.type === "char") {
    return { state: { ...state, picker: { ...picker, query: picker.query + key.value, index: 0 } }, effect: null };
  }
  if (key.type === "enter") {
    if (picker.kind === "api-key") {
      if (!picker.subject || picker.query.length === 0) return { state, effect: null };
      return { state: { ...state, picker: null }, effect: { type: "pick", kind: picker.kind, id: picker.subject, secret: picker.query } };
    }
    const picked = rows[clamp(picker.index, rows.length)];
    if (!picked) return { state, effect: null };
    return {
      state: { ...state, picker: null },
      effect: { type: "pick", kind: picker.kind, id: picked.id, ...(picker.subject ? { subject: picker.subject } : {}) },
    };
  }
  return { state, effect: null };
}

function visibleRows(picker: Picker): PickerRow[] {
  if (picker.kind === "api-key") return [];
  const query = picker.query.trim().toLowerCase();
  if (!query) return picker.rows;
  return picker.rows.filter((row) => row.label.toLowerCase().includes(query) || row.id.toLowerCase().includes(query));
}

function acceptOrSubmit(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  const matches = slashMatches(state.input);
  const picked = matches[clamp(state.menuIndex, matches.length)];
  const token = state.input.trim();
  if (picked && token.startsWith("/") && !/\s/.test(token.slice(1)) && token.slice(1).toLowerCase() !== picked.name) {
    if (picked.takesArgs === "required") {
      const input = `/${picked.name} `;
      return { state: { ...state, input, cursor: Array.from(input).length, menuIndex: 0 }, effect: null };
    }
    return submit({ ...state, input: `/${picked.name}` });
  }
  return submit(state);
}

function submit(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  const text = state.input.trim();
  const history = text.length > 0 && state.history.at(-1) !== text ? [...state.history, text] : state.history;
  const cleared = { ...state, input: "", cursor: 0, notice: null, history, historyAt: null, draft: "" };
  if (!text) return { state: cleared, effect: null };
  const command = parseSlash(text);
  if (command.type === "prompt") return { state: cleared, effect: { type: "submit", text: command.text } };
  if (command.type === "notice") return { state: { ...cleared, notice: command.text }, effect: null };
  return { state: cleared, effect: { type: "slash", command } };
}

function move(state: TuiState, key: Key): TuiState {
  const turns = turnStarts(state.entries);
  if (key.type === "up") return { ...state, entryIndex: clamp(state.entryIndex - 1, state.entries.length) };
  if (key.type === "down") return { ...state, entryIndex: clamp(state.entryIndex + 1, state.entries.length) };
  if (key.type === "page-up") {
    const turnIndex = clamp(state.turnIndex - 1, turns.length);
    return { ...state, turnIndex, entryIndex: turns[turnIndex] ?? 0 };
  }
  if (key.type === "page-down") {
    const turnIndex = clamp(state.turnIndex + 1, turns.length);
    return { ...state, turnIndex, entryIndex: turns[turnIndex] ?? 0 };
  }
  if (key.type === "char" && key.value === "i") return { ...state, focus: "prompt" };
  return state;
}

function turnStarts(entries: readonly TuiEntry[]): number[] {
  const starts = entries.flatMap((entry, index) => entry.role === "user" ? [index] : []);
  return starts.length > 0 ? starts : [0];
}

function composerLines(state: TuiState, width: number): string[] {
  const inner = Math.max(1, width - 2);
  const bar = "─".repeat(Math.max(0, width - 2));
  const edge = width > 1 ? "┐" : "";
  const top = paint(theme.border, `┌${bar}${edge}`);
  const bottom = paint(theme.border, `└${bar}${width > 1 ? "┘" : ""}`);
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  const marked = [...chars.slice(0, cursor), "▏", ...chars.slice(cursor)].join("");
  const rows = marked.split("\n").map((line, index) => {
    const lead = index === 0 ? "› " : "  ";
    const room = Math.max(0, inner - widthOf(lead));
    const shown = fit(line, Math.max(1, room));
    const ghost = state.input.length === 0 && index === 0 ? fit("输入消息", Math.max(0, room - widthOf(shown))) : "";
    const leadPaint = index === 0 ? paint(theme.accent, "› ") : "  ";
    const body = paint(theme.text, shown) + (ghost.length > 0 ? paint(theme.dim, ghost) : "");
    const pad = " ".repeat(Math.max(0, inner - widthOf(lead) - widthOf(shown) - widthOf(ghost)));
    return `${paint(theme.border, "│")}${leadPaint}${body}${pad}${paint(theme.border, "│")}`;
  });
  return [top, ...rows, bottom];
}

/**
 * 浮层按剩余行数排。标题先占一行，正文放不下就从末尾丢掉。
 * 整帧从底部裁时，60×16 会把顶部的「快捷键」裁掉。底栏提示里也有这四个字，不能靠子串判断标题还在。
 */
function overlayLines(state: TuiState, width: number, budget: number): string[] {
  if (!state.overlay || budget < 1) return [];
  const rule = paint(theme.border, "─".repeat(Math.min(width, 80)));
  const title = paint(theme.accent, "快捷键");
  const body = hotkeyText().split("\n").map((line) => paint(theme.text, fit(line, width)));
  const framed = [rule, title, ...body, rule];
  if (framed.length <= budget) return framed;
  if (budget === 1) return [title];
  if (budget === 2) return [title, body[0] ?? rule];
  return [rule, title, ...body.slice(0, budget - 3), rule];
}

function insertText(state: TuiState, text: string): TuiState {
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  const extra = Array.from(text);
  chars.splice(cursor, 0, ...extra);
  const input = chars.join("");
  return { ...state, input, cursor: cursor + extra.length, menuIndex: 0, notice: null, historyAt: null, draft: input };
}

function deleteBeforeCursor(state: TuiState): TuiState {
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  if (cursor === 0) return state;
  chars.splice(cursor - 1, 1);
  const input = chars.join("");
  return { ...state, input, cursor: cursor - 1, menuIndex: 0, historyAt: null, draft: input };
}

function historyUp(state: TuiState): TuiState {
  if (state.history.length === 0) return state;
  const from = state.historyAt === null ? state.history.length : state.historyAt;
  if (from <= 0) return state;
  const historyAt = from - 1;
  const draft = state.historyAt === null ? state.input : state.draft;
  const input = state.history[historyAt] ?? "";
  return { ...state, draft, historyAt, input, cursor: 0, menuIndex: 0, notice: null };
}

function historyDown(state: TuiState): TuiState {
  if (state.historyAt === null) return state;
  if (state.historyAt >= state.history.length - 1) {
    const input = state.draft;
    return { ...state, historyAt: null, input, cursor: Array.from(input).length, menuIndex: 0 };
  }
  const historyAt = state.historyAt + 1;
  const input = state.history[historyAt] ?? "";
  return { ...state, historyAt, input, cursor: Array.from(input).length, menuIndex: 0 };
}

function moveLine(state: TuiState, direction: -1 | 1): TuiState {
  const chars = Array.from(state.input);
  const line = lineInfo(state.input, state.cursor);
  if (direction < 0) {
    if (line.first) return state;
    const prevEnd = line.start - 1;
    let prevStart = 0;
    for (let index = 0; index < prevEnd; index += 1) if (chars[index] === "\n") prevStart = index + 1;
    const cursor = prevStart + Math.min(line.offset, prevEnd - prevStart);
    return { ...state, cursor };
  }
  if (line.last) return state;
  const nextStart = line.end + 1;
  let nextEnd = chars.length;
  for (let index = nextStart; index < chars.length; index += 1) if (chars[index] === "\n") { nextEnd = index; break; }
  const cursor = nextStart + Math.min(line.offset, nextEnd - nextStart);
  return { ...state, cursor };
}

function lineInfo(input: string, cursor: number): { start: number; end: number; offset: number; first: boolean; last: boolean } {
  const chars = Array.from(input);
  const at = Math.max(0, Math.min(cursor, chars.length));
  let start = 0;
  for (let index = 0; index < at; index += 1) if (chars[index] === "\n") start = index + 1;
  let end = chars.length;
  for (let index = at; index < chars.length; index += 1) if (chars[index] === "\n") { end = index; break; }
  return { start, end, offset: at - start, first: start === 0, last: end === chars.length };
}

function moveCursor(state: TuiState, delta: number): TuiState {
  const length = Array.from(state.input).length;
  const cursor = clamp(state.cursor, length + 1);
  return { ...state, cursor: clamp(cursor + delta, length + 1) };
}

function statusLine(state: TuiState): string {
  const model = state.provider && state.modelId ? `${state.provider}/${state.modelId}` : "";
  const parts = [model, state.thinking, state.directory, state.active, state.busy ? "忙" : "空闲", ...meterParts(state.meters)];
  if (state.busy && state.queued > 0) parts.push(`排队 ${state.queued}`);
  if (state.focus === "scroll") parts.push("滚动");
  return parts.filter((part) => part.length > 0).join("  ");
}

function meterParts(meters: TuiMeters): string[] {
  const parts: string[] = [];
  if (meters.tokens !== undefined && Number.isFinite(meters.tokens)) parts.push(`${formatCount(meters.tokens)} tok`);
  const context = formatPercent(meters.contextPercent);
  if (context) parts.push(`上下文 ${context}`);
  const hit = formatPercent(meters.hitPercent);
  if (hit) parts.push(`命中 ${hit}`);
  const cost = formatUsd(meters.costUsd);
  if (cost) parts.push(cost);
  return parts;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  return `${text}%`;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  const text = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

function transcriptLines(state: TuiState): string[] {
  const lines: string[] = [];
  for (const [index, entry] of state.entries.entries()) {
    const mark = state.focus === "scroll" && index === state.entryIndex ? "> " : "";
    if (entry.role === "user") {
      lines.push(...userBlock(entry.text).map((line, lineIndex) => lineIndex === 0 ? mark + line : line));
    } else if (entry.role === "assistant") {
      lines.push(mark + paint(theme.accent, "AmazMe"));
      lines.push(...markdownLines(entry.text, "assistant"));
    } else if (entry.role === "tool") {
      lines.push(mark + paint(theme.accent, entry.title && entry.title.length > 0 ? entry.title : "tool"));
      lines.push(paint(theme.dim, "  result"));
      for (const row of entry.text.split("\n")) lines.push(paint(theme.text, row));
    } else {
      lines.push(mark + paint(theme.dim, entry.text));
    }
    lines.push("");
  }
  if (state.pendingText.length > 0) {
    lines.push(paint(theme.accent, "AmazMe"));
    lines.push(...markdownLines(state.pendingText, "assistant"));
    lines.push("");
  }
  for (const tool of state.tools) {
    lines.push(paint(theme.accent, tool.name));
    lines.push(paint(theme.dim, `  ${tool.status}`));
    lines.push("");
  }
  return lines;
}

function userBlock(text: string): string[] {
  return [paint(theme.warm, "┌ 你"), ...markdownLines(text, "user").map((line) => `${paint(theme.warm, "│ ")}${line}`), paint(theme.warm, "└")];
}

function pickerLines(picker: Picker, width: number): string[] {
  const rule = paint(theme.border, "─".repeat(Math.min(width, 80)));
  const rows = visibleRows(picker);
  const selected = clamp(picker.index, rows.length);
  const limit = 8;
  const start = Math.max(0, Math.min(selected - 1, rows.length - limit));
  const window = rows.slice(start, start + limit);
  const lines = [
    rule,
    "",
    paint(theme.accent, picker.title),
    "",
    paint(theme.text, picker.kind === "api-key" ? `> ${"•".repeat(Math.min(picker.query.length, 24))}` : `> ${picker.query}`),
    "",
  ];
  if (picker.kind !== "api-key") {
    for (const [offset, row] of window.entries()) {
      const index = start + offset;
      const on = index === selected;
      const mark = on ? paint(theme.accent, "→ ") : "  ";
      const name = paint(on ? theme.accent : theme.text, fit(row.label, Math.max(8, width - 24)));
      const detail = paint(row.tone === "ok" ? theme.green : theme.dim, row.detail.length > 0 ? `  ${row.detail}` : "");
      lines.push(mark + name + detail);
    }
    if (rows.length > limit) lines.push(paint(theme.dim, `  (${selected + 1}/${rows.length})`));
    if (rows.length === 0) lines.push(paint(theme.dim, "  no match"));
  }
  lines.push("", paint(theme.dim, picker.hint), rule);
  return lines;
}

function menuLines(state: TuiState, width: number): string[] {
  const matches = slashMatches(state.input);
  if (matches.length === 0) return [];
  const limit = 8;
  const selected = clamp(state.menuIndex, matches.length);
  const start = Math.max(0, Math.min(selected - 1, matches.length - limit));
  return matches.slice(start, start + limit).map((item, offset) => {
    const index = start + offset;
    const mark = index === selected ? paint(theme.accent, "→") : " ";
    const hint = item.hint.length > 0 ? ` ${item.hint}` : "";
    const body = fit(` /${item.name}${hint}  ${item.description}`, Math.max(8, width - 2));
    return mark + paint(index === selected ? theme.accent : theme.dim, body);
  });
}

function widthOf(line: string): number {
  let used = 0;
  for (const char of Array.from(line)) used += columnWidth(char);
  return used;
}

/** CJK is two columns. Box drawing and the composer cursor stay one, matching the rule line. */
function columnWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0xff) return 1;
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2329 && code <= 0x232a) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe10 && code <= 0xfe19) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  if (code >= 0x1f300 && code <= 0x1f64f) return 2;
  if (code >= 0x1f900 && code <= 0x1f9ff) return 2;
  if (code >= 0x20000 && code <= 0x3fffd) return 2;
  return 1;
}

function fit(line: string, width: number): string {
  let used = 0;
  let out = "";
  for (const char of Array.from(line)) {
    const size = columnWidth(char);
    if (used + size > width) return `${out}…`;
    out += char;
    used += size;
  }
  return out;
}

function wrap(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  const chars = Array.from(line);
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === "\u001b" && chars[index + 1] === "[") {
      let end = index + 2;
      while (end < chars.length && !/[A-Za-z]/.test(chars[end] ?? "")) end += 1;
      row += chars.slice(index, end + 1).join("");
      index = end;
      continue;
    }
    const char = chars[index] ?? "";
    const size = columnWidth(char);
    if (used > 0 && used + size > width) {
      rows.push(row + theme.reset);
      row = "";
      used = 0;
    }
    row += char;
    used += size;
  }
  rows.push(row);
  return rows.length > 0 ? rows : [""];
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
