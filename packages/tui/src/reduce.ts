import type { Key } from "./keys.ts";

export interface TuiEntry {
  id: string;
  role: "user" | "assistant" | "tool" | "other";
  text: string;
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
  notice: string | null;
}

export type TuiEffect =
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "new-session" }
  | { type: "resume"; name: string }
  | { type: "compact" };

export function emptyTui(active = "main"): TuiState {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: false,
    sessions: [active],
    active,
    focus: "prompt",
    entryIndex: 0,
    turnIndex: 0,
    input: "",
    notice: null,
  };
}

export function reduceTui(state: TuiState, action: { type: "window"; window: TuiWindow } | { type: "key"; key: Key }): { state: TuiState; effect: TuiEffect | null } {
  if (action.type === "window") return { state: applyWindow(state, action.window), effect: null };
  return applyKey(state, action.key);
}

export function renderTui(state: TuiState): string {
  const lines = state.entries.map((entry, index) => {
    const mark = index === state.entryIndex && state.focus === "scroll" ? ">" : " ";
    return `${mark}${entry.role} ${entry.text}`;
  });
  if (state.pendingText.length > 0) lines.push(` assistant ${state.pendingText}`);
  for (const tool of state.tools) lines.push(` tool ${tool.name} ${tool.status}`);
  lines.push(`focus ${state.focus}`);
  lines.push(`session ${state.active}`);
  lines.push(`> ${state.input}`);
  if (state.notice) lines.push(state.notice);
  return lines.join("\n");
}

function applyWindow(state: TuiState, window: TuiWindow): TuiState {
  const turns = turnStarts(window.entries);
  const entryIndex = clamp(state.entryIndex, window.entries.length);
  const turnIndex = clamp(state.turnIndex, turns.length);
  return { ...state, ...window, entryIndex, turnIndex };
}

function applyKey(state: TuiState, key: Key): { state: TuiState; effect: TuiEffect | null } {
  if (key.type === "escape") {
    return { state: { ...state, focus: state.focus === "prompt" ? "scroll" : "prompt", notice: null }, effect: null };
  }
  if (state.focus === "scroll") return { state: move(state, key), effect: null };
  if (key.type === "char") return { state: { ...state, input: state.input + key.value, notice: null }, effect: null };
  if (key.type === "backspace") {
    const chars = Array.from(state.input);
    chars.pop();
    return { state: { ...state, input: chars.join("") }, effect: null };
  }
  if (key.type === "enter") return submit(state);
  if (key.type === "ctrl-c") {
    if (state.busy) return { state: { ...state, notice: null }, effect: { type: "abort" } };
    if (state.input.length > 0) return { state: { ...state, input: "" }, effect: null };
    return { state, effect: null };
  }
  return { state, effect: null };
}

function submit(state: TuiState): { state: TuiState; effect: TuiEffect | null } {
  const text = state.input.trim();
  const cleared = { ...state, input: "", notice: null };
  if (!text) return { state: cleared, effect: null };
  if (text === "/new") return { state: cleared, effect: { type: "new-session" } };
  if (text === "/compact") return { state: cleared, effect: { type: "compact" } };
  if (text.startsWith("/resume ")) {
    const name = text.slice("/resume ".length).trim();
    if (!name) return { state: { ...cleared, notice: "用法：/resume 名称" }, effect: null };
    return { state: cleared, effect: { type: "resume", name } };
  }
  return { state: cleared, effect: { type: "submit", text } };
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

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
