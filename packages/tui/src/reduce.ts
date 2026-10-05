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
  const transcript = transcriptLines(state).flatMap((line) => wrap(line, width));
  const chrome = [...picker, ...menu, ...notice, status, rule, ...composer];
  const room = Math.max(1, height - chrome.length);
  const visible = transcript.slice(-room);
  while (visible.length < room) visible.unshift("");
  return [...visible, ...chrome].join("\n");
}

function applyWindow(state: TuiState, window: TuiWindow): TuiState {
  const turns = turnStarts(window.entries);
  const entryIndex = clamp(state.entryIndex, window.entries.length);
  const turnIndex = clamp(state.turnIndex, turns.length);
  return { ...state, ...window, entryIndex, turnIndex };
}

function applyKey(state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } {
  if (key.type !== "ctrl-c") state = forgetExit(state);
  if (state.picker) return pickerKey(forgetExit(state), key);
  if (key.type === "escape") {
    return { state: { ...state, focus: state.focus === "prompt" ? "scroll" : "prompt", notice: null }, effect: null };
  }
  if (state.focus === "scroll") return { state: move(state, key), effect: null };
  const matches = slashMatches(state.input);
  if (matches.length > 0 && (key.type === "up" || key.type === "down")) {
    const delta = key.type === "up" ? -1 : 1;
    const menuIndex = (state.menuIndex + delta + matches.length) % matches.length;
    return { state: { ...state, menuIndex }, effect: null };
  }
  if (key.type === "left" || key.type === "right") return { state: moveCursor(state, key.type === "left" ? -1 : 1), effect: null };
  if (key.type === "newline") return { state: insertText(state, "\n"), effect: null };
  if (key.type === "tab") {
    const picked = matches[clamp(state.menuIndex, matches.length)];
    if (!picked) return { state, effect: null };
    const suffix = picked.takesArgs === "required" ? " " : "";
    const input = `/${picked.name}${suffix}`;
    return { state: { ...state, input, cursor: Array.from(input).length, menuIndex: 0, notice: null }, effect: null };
  }
  if (key.type === "char") return { state: insertText(state, key.value), effect: null };
  if (key.type === "backspace") return { state: deleteBeforeCursor(state), effect: null };
  if (key.type === "enter") return acceptOrSubmit(state);
  if (key.type === "ctrl-c") {
    if (state.busy) return { state: forgetExit(state), effect: { type: "abort" } };
    if (state.input.length > 0) return { state: { ...forgetExit(state), input: "", cursor: 0 }, effect: null };
    if (state.exitArmed) return { state: { ...state, exitArmed: false, notice: null }, effect: { type: "quit" } };
    return { state: { ...state, exitArmed: true, notice: EXIT_HINT }, effect: null };
  }
  return { state, effect: null };
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
  const cleared = { ...state, input: "", cursor: 0, notice: null };
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
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  const marked = [...chars.slice(0, cursor), "▏", ...chars.slice(cursor)].join("");
  return marked.split("\n").map((line, index) => {
    const prefix = index === 0 ? paint(theme.accent, "› ") : "  ";
    return prefix + paint(theme.text, fit(line, Math.max(1, width - 2)));
  });
}

function insertText(state: TuiState, text: string): TuiState {
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  const extra = Array.from(text);
  chars.splice(cursor, 0, ...extra);
  return { ...state, input: chars.join(""), cursor: cursor + extra.length, menuIndex: 0, notice: null };
}

function deleteBeforeCursor(state: TuiState): TuiState {
  const chars = Array.from(state.input);
  const cursor = clamp(state.cursor, chars.length + 1);
  if (cursor === 0) return state;
  chars.splice(cursor - 1, 1);
  return { ...state, input: chars.join(""), cursor: cursor - 1, menuIndex: 0 };
}

function moveCursor(state: TuiState, delta: number): TuiState {
  const length = Array.from(state.input).length;
  const cursor = clamp(state.cursor, length + 1);
  return { ...state, cursor: clamp(cursor + delta, length + 1) };
}

function statusLine(state: TuiState): string {
  const model = state.provider && state.modelId ? `${state.provider}/${state.modelId}` : "";
  const parts = [state.directory, state.active, model, state.thinking, state.busy ? "忙" : "空闲"].filter((part) => part.length > 0);
  if (state.focus === "scroll") parts.push("滚动");
  return parts.join("  ");
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

function fit(line: string, width: number): string {
  let used = 0;
  let out = "";
  for (const char of Array.from(line)) {
    const size = char.charCodeAt(0) > 255 ? 2 : 1;
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
    const size = char.charCodeAt(0) > 255 ? 2 : 1;
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
