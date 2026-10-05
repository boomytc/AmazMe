import { pastedImageMention } from "./images.ts";
import type { ActivityDto } from "@amazme/runtime-service";
import { activeBinding, composerHint, hotkeyText, type BindingId } from "./bindings.ts";
import { collectToolCards, summarizeArgs, toolCardRows, type ToolCardCall } from "./cards.ts";
import { parseSlash, slashMatches, type SlashAction } from "./commands.ts";
import type { Key } from "./keys.ts";
import { markdownLines } from "./markdown.ts";
import { footerParts, nextCompaction } from "./status.ts";
import { paint, theme } from "./theme.ts";

export { summarizeArgs };

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
  /** Snapshot entry time. Card duration is the result time minus the call's entry time. */
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
  /** Tool calls on an assistant entry. The card is drawn from these, not from a stored card. */
  calls?: ToolCardCall[];
}

export interface TuiTool {
  name: string;
  status: "planned" | "running" | "settled";
  /** 运行中检查点的输出尾。缺了就不显示。 */
  outputTail?: string;
  /** 用来把开放批次对上助手消息里的调用。手写窗口可以不带。 */
  toolCallId?: string;
}

export interface TuiWindow {
  entries: TuiEntry[];
  pendingText: string;
  tools: TuiTool[];
  busy: boolean;
  sessions: string[];
  active: string;
  /** 协议快照上的底栏数据。缺了就不显示分支、耗时、重试、压缩和费用。 */
  activity?: ActivityDto;
  /**
   * Parked approvals from `pendingApprovals`. Omitted means none.
   * The snapshot does not carry this list.
   */
  approvals?: TuiApproval[];
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
  /** 压缩中变成停止之后保留「压缩完成」，直到下一轮开始。 */
  compaction: "off" | "active" | "done";
  /** Parked tool calls. The first one is the card. Empty means the keys type into the composer. */
  approvals: TuiApproval[];
  /** True after y/n/a until that call leaves the pending list, so a second key does not decide twice. */
  deciding: boolean;
  decidingId: string | null;
  /**
   * Ctrl+O 展开的调用。只对最近一张卡生效。
   * 不进快照。重开是一块新状态，卡片仍从条目里画出来，但是收着的。
   */
  expandedToolId: string | null;
  /** Query after `@` at the cursor. Null when the cursor is not in a mention. */
  fileQuery: string | null;
  /** Paths the host returned for `fileQuery`. The screen does not scan disk. */
  filePaths: string[];
  fileIndex: number;
  /** Esc hides the current query until the mention changes. */
  fileHidden: boolean;
}

/** One parked tool call the card can show. `summary` is a short argument line. */
export interface TuiApproval {
  toolCallId: string;
  name: string;
  summary: string;
}

export type TuiEffect =
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "slash"; command: SlashAction }
  | { type: "pick"; kind: Picker["kind"]; id: string; subject?: string; secret?: string }
  | { type: "cycle-model" }
  | { type: "approve"; toolCallId: string; decision: "allow" | "deny"; session?: boolean }
  | { type: "copy"; text: string }
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
    compaction: "off",
    approvals: [],
    deciding: false,
    decidingId: null,
    expandedToolId: null,
    fileQuery: null,
    filePaths: [],
    fileIndex: 0,
    fileHidden: false,
  };
}

export function reduceTui(state: TuiState, action: { type: "window"; window: TuiWindow } | { type: "key"; key: Key }): { state: TuiState; effect: TuiEffect | null } {
  if (action.type === "window") return { state: applyWindow(state, action.window), effect: null };
  const step = applyKey(state, action.key);
  return { state: syncFileQuery(step.state), effect: step.effect };
}

/** Conversation, slash menu, status, and composer. The composer stays on the last row. */
export function renderTui(state: TuiState, columns = 100, rows = 32, now?: number): string {
  const width = Math.max(20, columns);
  const height = Math.max(8, rows);
  const composer = composerLines(state, width);
  const status = paint(theme.dim, fit(statusLine(state, now), width));
  const rule = paint(theme.border, "─".repeat(width));
  const menu = state.picker ? [] : menuLines(state, width);
  const picker = state.picker ? pickerLines(state.picker, width) : [];
  const notice = state.notice ? state.notice.split("\n").map((line) => paint(theme.dim, fit(line, width))) : [];
  const hint = paint(theme.dim, fit(composerHint(), width));
  const transcript = transcriptLines(state, width, now).flatMap((line) => wrap(line, width));
  const approval = approvalLines(state, width);
  const footer = [status, hint, rule, ...composer];
  if (state.overlay) {
    const reserved = [...picker, ...menu, ...notice, ...approval, ...footer];
    const kept = reserved.length >= height ? reserved.slice(-(height - 1)) : reserved;
    const overlay = overlayLines(state, width, height - kept.length);
    const chrome = [...overlay, ...kept];
    const room = Math.max(0, height - chrome.length);
    const visible = transcript.slice(-room);
    while (visible.length < room) visible.unshift("");
    return [...visible, ...chrome].join("\n");
  }
  const chrome = [...picker, ...menu, ...notice, ...approval, ...footer];
  const room = Math.max(1, height - chrome.length);
  const visible = transcript.slice(-room);
  while (visible.length < room) visible.unshift("");
  return [...visible, ...chrome].slice(-height).join("\n");
}

function applyWindow(state: TuiState, window: TuiWindow): TuiState {
  const turns = turnStarts(window.entries);
  const entryIndex = clamp(state.entryIndex, window.entries.length);
  const turnIndex = clamp(state.turnIndex, turns.length);
  const compaction = nextCompaction(state.compaction, state.activity, window.activity);
  const approvals = window.approvals ?? [];
  const stillDeciding = state.decidingId !== null && approvals.some((item) => item.toolCallId === state.decidingId);
  const next = {
    ...state,
    ...window,
    approvals,
    deciding: stillDeciding,
    decidingId: stillDeciding ? state.decidingId : null,
    entryIndex,
    turnIndex,
    compaction,
  };
  if (!window.busy) next.queued = 0;
  return next;
}

function applyKey(state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } {
  if (key.type !== "ctrl-c") state = forgetExit(state);
  if (key.type === "paste") return applyPaste(state, key.text);
  if (state.picker) return pickerKey(forgetExit(state), key);
  const approval = approvalDecision(state, key);
  if (approval) return approval;
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
      return fileMenuOpen(state) ? acceptFile(state) : completeSlash(state);
    case "dismiss":
      if (state.overlay) return { state: { ...state, overlay: false }, effect: null };
      if (fileMenuOpen(state)) return { state: { ...state, fileHidden: true }, effect: null };
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
    case "cycle-model":
      return { state, effect: { type: "cycle-model" } };
    case "copy-reply":
      return copyReply(state);
    case "toggle-tool":
      return { state: toggleToolCard(state), effect: null };
    case "insert":
      return key.type === "char" ? { state: insertText(state, key.value), effect: null } : { state, effect: null };
    default: {
      const unreachable: never = id;
      return unreachable;
    }
  }
}

/** 正在生成的回复比已落下的助手条目更新。空文本不复制。 */
function assistantReply(state: TuiState): string {
  if (state.pendingText.length > 0) return state.pendingText;
  return [...state.entries].reverse().find((entry) => entry.role === "assistant")?.text ?? "";
}

function copyReply(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  const text = assistantReply(state);
  if (text.length === 0) return { state: { ...state, notice: "没有助手回复" }, effect: null };
  return { state, effect: { type: "copy", text } };
}

/** 最后一个围栏代码块的正文。没有围栏就不是代码块。 */
function lastCodeBlock(source: string): string | null {
  const lines = source.split("\n");
  let open = false;
  let current: string[] = [];
  let last: string[] | null = null;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (open) {
        last = current;
        open = false;
        current = [];
      } else {
        open = true;
        current = [];
      }
      continue;
    }
    if (open) current.push(line);
  }
  if (open) last = current;
  return last === null ? null : last.join("\n");
}

function copyCommand(state: TuiState, code: boolean): { state: TuiState; effect: TuiEffect | null } {
  const reply = assistantReply(state);
  if (!code) return copyReply(state);
  const block = lastCodeBlock(reply);
  if (block === null) return { state: { ...state, notice: "没有代码块" }, effect: null };
  return { state, effect: { type: "copy", text: block } };
}

function applyPaste(state: TuiState, text: string): { state: TuiState; effect: TuiEffect | null } {
  if (state.overlay) return { state, effect: null };
  if (state.picker) {
    const extra = text.replace(/\n/g, "");
    return { state: { ...state, picker: { ...state.picker, query: state.picker.query + extra, index: 0 } }, effect: null };
  }
  if (state.focus !== "prompt") return { state, effect: null };
  const mention = pastedImageMention(text);
  return { state: insertText(state, mention ? boundedMention(state, mention) : text), effect: null };
}

function boundedMention(state: TuiState, mention: string): string {
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  const prev = chars[cursor - 1];
  const next = chars[cursor];
  let text = mention;
  if (prev !== undefined && !/\s/.test(prev)) text = ` ${text}`;
  if (next !== undefined && !/\s/.test(next)) text = `${text} `;
  return text;
}

function onVertical(state: TuiState, direction: -1 | 1): { state: TuiState; effect: TuiEffect | null } {
  if (fileMenuOpen(state)) {
    const count = state.filePaths.length;
    const fileIndex = (state.fileIndex + direction + count) % count;
    return { state: { ...state, fileIndex }, effect: null };
  }
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
  if (fileMenuOpen(state)) return acceptFile(state);
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
  if (command.type === "copy") return copyCommand(cleared, command.code);
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
 * 浮层按剩余行数排。标题先占一行，正文放不下就从末尾丢掉，并在末尾标「更多」。
 * 整帧从底部裁时，60×16 会把顶部的「快捷键」裁掉。底栏提示里也有这四个字，不能靠子串判断标题还在。
 */
function overlayLines(state: TuiState, width: number, budget: number): string[] {
  if (!state.overlay || budget < 1) return [];
  const rule = paint(theme.border, "─".repeat(width));
  const title = paint(theme.accent, "快捷键");
  const more = paint(theme.dim, "更多");
  const body = hotkeyText().split("\n").map((line) => paint(theme.text, fit(line, width)));
  const framed = [rule, title, ...body, rule];
  if (framed.length <= budget) return framed;
  if (budget === 1) return [title];
  if (budget === 2) return [title, more];
  if (budget === 3) return [rule, title, more];
  return [rule, title, ...body.slice(0, budget - 4), more, rule];
}

function approvalLines(state: TuiState, width: number): string[] {
  const card = state.approvals[0];
  if (!card || state.picker) return [];
  const summary = card.summary.length > 0 ? `  ${card.summary}` : "";
  return [
    paint(theme.border, "─".repeat(width)),
    paint(theme.accent, "审批"),
    paint(theme.text, fit(`${card.name}${summary}`, width)),
    paint(theme.dim, fit("y 允许  n 拒绝  a 本次会话允许", width)),
  ];
}

function approvalDecision(state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } | null {
  const card = state.approvals[0];
  if (!card || state.picker || key.type !== "char" || state.input.length > 0) return null;
  const value = key.value;
  const decision = value === "n" || value === "N" ? "deny" : value === "y" || value === "Y" || value === "a" || value === "A" ? "allow" : null;
  if (!decision) return null;
  if (state.deciding) return { state, effect: null };
  const session = value === "a" || value === "A";
  return {
    state: { ...state, deciding: true, decidingId: card.toolCallId },
    effect: { type: "approve", toolCallId: card.toolCallId, decision, ...(session ? { session: true } : {}) },
  };
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

function statusLine(state: TuiState, now?: number): string {
  const model = state.provider && state.modelId ? `${state.provider}/${state.modelId}` : "";
  const parts = [
    model,
    state.thinking,
    state.directory,
    state.active,
    state.busy ? "忙" : "空闲",
    ...meterParts(state.meters),
    ...footerParts(state.activity, state.compaction, now),
  ];
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

function toggleToolCard(state: TuiState): TuiState {
  const latest = collectToolCards(state).at(-1);
  if (!latest) return state;
  return { ...state, expandedToolId: state.expandedToolId === latest.id ? null : latest.id };
}

function transcriptLines(state: TuiState, width: number, now?: number): string[] {
  const cards = collectToolCards(state, now);
  const latestId = cards.at(-1)?.id ?? null;
  const emitted = new Set<string>();
  const lines: string[] = [];
  const pushCard = (card: (typeof cards)[number], mark: string): void => {
    if (emitted.has(card.id)) return;
    emitted.add(card.id);
    const expanded = state.expandedToolId === card.id && card.id === latestId;
    const rows = toolCardRows(card, expanded);
    for (const [rowIndex, row] of rows.entries()) {
      const painted = paint(theme[row.tone], fit(row.text, width));
      lines.push(rowIndex === 0 ? mark + painted : painted);
    }
  };
  for (const [index, entry] of state.entries.entries()) {
    const mark = state.focus === "scroll" && index === state.entryIndex ? "> " : "";
    if (entry.role === "user") {
      lines.push(...userBlock(entry.text).map((line, lineIndex) => lineIndex === 0 ? mark + line : line));
      lines.push("");
    } else if (entry.role === "assistant") {
      const anchored = cards.filter((card) => card.anchorId === entry.id);
      const showSpeaker = entry.text.length > 0 || anchored.length === 0;
      if (showSpeaker) {
        lines.push(mark + paint(theme.accent, "AmazMe"));
        if (entry.text.length > 0) lines.push(...markdownLines(entry.text, "assistant"));
      }
      for (const [cardIndex, card] of anchored.entries()) pushCard(card, showSpeaker || cardIndex > 0 ? "" : mark);
      lines.push("");
    } else if (entry.role === "tool") {
      const before = lines.length;
      for (const card of cards) if (card.anchorId === entry.id) pushCard(card, mark);
      if (lines.length !== before) lines.push("");
    } else {
      lines.push(mark + paint(theme.dim, entry.text));
      lines.push("");
    }
  }
  if (state.pendingText.length > 0) {
    lines.push(paint(theme.accent, "AmazMe"));
    lines.push(...markdownLines(state.pendingText, "assistant"));
    lines.push("");
  }
  for (const card of cards) {
    if (emitted.has(card.id)) continue;
    pushCard(card, "");
    lines.push("");
  }
  return lines;
}

function userBlock(text: string): string[] {
  return [paint(theme.warm, "┌ 你"), ...markdownLines(text, "user").map((line) => `${paint(theme.warm, "│ ")}${line}`), paint(theme.warm, "└")];
}

function pickerLines(picker: Picker, width: number): string[] {
  const rule = paint(theme.border, "─".repeat(width));
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

function fileMenuOpen(state: TuiState): boolean {
  return state.focus === "prompt"
    && state.picker === null
    && !state.overlay
    && !state.fileHidden
    && state.fileQuery !== null
    && state.filePaths.length > 0
    && slashMatches(state.input).length === 0;
}

/** The `@` token touching the cursor. The query is the text between `@` and the cursor. */
function atToken(input: string, cursor: number): { start: number; end: number; query: string } | null {
  const chars = Array.from(input);
  const at = Math.max(0, Math.min(cursor, chars.length));
  let index = at;
  while (index > 0 && !/\s/.test(chars[index - 1] ?? "")) index -= 1;
  if (chars[index] !== "@") return null;
  if (index > 0 && !/\s/.test(chars[index - 1] ?? "")) return null;
  if (at <= index) return null;
  return { start: index, end: at, query: chars.slice(index + 1, at).join("") };
}

function syncFileQuery(state: TuiState): TuiState {
  const query = atToken(state.input, state.cursor)?.query ?? null;
  if (query === state.fileQuery) return state;
  return { ...state, fileQuery: query, filePaths: [], fileIndex: 0, fileHidden: false };
}

function mentionText(path: string): string {
  return /[\s"]/.test(path) ? `@"${path.replaceAll("\"", "")}"` : `@${path}`;
}

function acceptFile(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  const token = atToken(state.input, state.cursor);
  const path = state.filePaths[clamp(state.fileIndex, state.filePaths.length)];
  if (!token || !path) return { state, effect: null };
  const mention = mentionText(path);
  const chars = Array.from(state.input);
  chars.splice(token.start, token.end - token.start, ...Array.from(mention));
  const input = chars.join("");
  const cursor = token.start + Array.from(mention).length;
  return {
    state: {
      ...state,
      input,
      cursor,
      draft: input,
      historyAt: null,
      notice: null,
      menuIndex: 0,
      filePaths: [],
      fileIndex: 0,
      fileQuery: atToken(input, cursor)?.query ?? null,
      fileHidden: true,
    },
    effect: null,
  };
}

function menuLines(state: TuiState, width: number): string[] {
  if (fileMenuOpen(state)) {
    const limit = 8;
    const selected = clamp(state.fileIndex, state.filePaths.length);
    const start = Math.max(0, Math.min(selected - 1, state.filePaths.length - limit));
    return state.filePaths.slice(start, start + limit).map((path, offset) => {
      const index = start + offset;
      const mark = index === selected ? paint(theme.accent, "→") : " ";
      return mark + paint(index === selected ? theme.accent : theme.dim, fit(` ${path}`, Math.max(8, width - 2)));
    });
  }
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
export function columnWidth(char: string): number {
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
  if (width <= 0) return "";
  const ellipsis = "…";
  const mark = columnWidth(ellipsis);
  let used = 0;
  const chars: string[] = [];
  for (const char of Array.from(line)) {
    const size = columnWidth(char);
    if (used + size > width) {
      while (used + mark > width && chars.length > 0) {
        const last = chars.pop() ?? "";
        used -= columnWidth(last);
      }
      if (used + mark > width) return "";
      return chars.join("") + ellipsis;
    }
    chars.push(char);
    used += size;
  }
  return chars.join("");
}

/** CUP for the composer caret. `▏` is the input cell; colors do not take columns. */
export function inputCursorSequence(frame: string): string {
  const lines = frame.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const plain = (lines[index] ?? "").replace(/\u001b\[[0-9;]*m/g, "");
    const chars = Array.from(plain);
    const at = chars.indexOf("▏");
    if (at < 0) continue;
    let column = 1;
    for (let cursor = 0; cursor < at; cursor += 1) column += columnWidth(chars[cursor] ?? "");
    return `\x1b[${index + 1};${column}H`;
  }
  return "";
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
