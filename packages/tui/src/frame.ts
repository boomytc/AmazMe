import { preview } from "./transcript.ts";

export interface ConfirmationPrompt {
  toolName: string;
  args: unknown;
}

export interface ScreenState {
  lines: string[];
  busy: boolean;
  notice: string | null;
  failure: string | null;
  queued: number;
  input: string;
  confirmation: ConfirmationPrompt | null;
}

export interface Frame {
  scroll: string[];
  status: string;
  prompt: string;
  body: string[];
}

/** Busy is only the open turn. After turn_end the status line does not say 忙. */
export function statusText(state: Pick<ScreenState, "busy" | "notice" | "failure" | "queued">): string {
  const parts = [state.busy ? "忙" : "空闲"];
  if (state.notice) parts.push(state.notice);
  if (state.failure) parts.push(state.failure);
  if (state.queued > 0) parts.push(`排队 ${state.queued}`);
  return parts.join(" · ");
}

export function promptText(state: Pick<ScreenState, "input" | "confirmation">): string {
  if (state.confirmation) {
    const args = preview(state.confirmation.args);
    const detail = args.length > 0 ? ` ${args}` : "";
    return `允许执行 ${state.confirmation.toolName}${detail}？ y 答应 / n 拒绝`;
  }
  return `› ${state.input}`;
}

export function renderFrame(state: ScreenState, columns: number, rows: number): Frame {
  const width = Math.max(1, columns);
  const height = Math.max(2, rows);
  const status = fit(statusText(state), width);
  const prompt = fit(promptText(state), width);
  const scrollHeight = Math.max(1, height - 2);
  const wrapped = state.lines.flatMap((line) => wrap(line, width));
  const visible = wrapped.slice(-scrollHeight);
  while (visible.length < scrollHeight) visible.unshift("");
  const body = [...visible, status, prompt];
  return { scroll: visible, status, prompt, body: body.slice(0, height) };
}

export function paintAnsi(body: string[]): string {
  const lines = body.map((line, index) => `\x1b[${index + 1};1H\x1b[2K${line}`);
  return `\x1b[H${lines.join("")}`;
}

function wrap(line: string, width: number): string[] {
  const rows: string[] = [];
  for (const part of line.split("\n")) {
    let row = "";
    let used = 0;
    for (const char of Array.from(part)) {
      const size = cellWidth(char);
      if (used > 0 && used + size > width) {
        rows.push(row);
        row = "";
        used = 0;
      }
      row += char;
      used += size;
    }
    rows.push(row);
  }
  return rows.length > 0 ? rows : [""];
}

function fit(text: string, width: number): string {
  const chars = Array.from(text.replaceAll("\n", " "));
  let used = 0;
  let count = 0;
  for (const char of chars) {
    const size = cellWidth(char);
    if (used + size > width) break;
    used += size;
    count += 1;
  }
  if (count === chars.length) return chars.join("");
  let kept = 0;
  let keptWidth = 0;
  for (const char of chars) {
    const size = cellWidth(char);
    if (keptWidth + size > width - 1) break;
    keptWidth += size;
    kept += 1;
  }
  return `${chars.slice(0, kept).join("")}…`;
}

function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}
