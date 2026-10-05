export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "backspace" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "newline" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "paste"; text: string };

export function decodeKeys(input: string): { keys: Key[]; rest: string } {
  const chars = Array.from(input);
  const keys: Key[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (char === "\u001b") {
      if (chars[index + 1] === "\r" || chars[index + 1] === "\n") {
        keys.push({ type: "newline" });
        index += 2;
        if (chars[index - 1] === "\r" && chars[index] === "\n") index += 1;
        continue;
      }
      if (chars.slice(index, index + 6).join("") === "\u001b[200~") {
        const tail = chars.slice(index + 6).join("");
        const end = tail.indexOf("\u001b[201~");
        if (end < 0) return { keys, rest: chars.slice(index).join("") };
        const text = tail.slice(0, end).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        keys.push({ type: "paste", text });
        index += 6 + end + 6;
        continue;
      }
      if (index + 1 >= chars.length) return { keys, rest: chars.slice(index).join("") };
      if (chars[index + 1] === "[") {
        let cursor = index + 2;
        if (cursor >= chars.length) return { keys, rest: chars.slice(index).join("") };
        while (cursor < chars.length) {
          const code = chars[cursor]?.charCodeAt(0) ?? 0;
          if (code >= 0x40 && code <= 0x7e) {
            const final = chars[cursor] ?? "";
            const body = chars.slice(index + 2, cursor).join("");
            keys.push(csiKey(body, final));
            index = cursor + 1;
            break;
          }
          cursor += 1;
          if (cursor >= chars.length) return { keys, rest: chars.slice(index).join("") };
        }
        continue;
      }
      keys.push({ type: "escape" });
      index += 1;
      continue;
    }
    if (char === "\u0003") {
      keys.push({ type: "ctrl-c" });
      index += 1;
      continue;
    }
    if (char === "\u0004") {
      keys.push({ type: "ctrl-d" });
      index += 1;
      continue;
    }
    if (char === "\t") {
      keys.push({ type: "tab" });
      index += 1;
      continue;
    }
    if (char === "\r") {
      keys.push({ type: "enter" });
      index += 1;
      if (chars[index] === "\n") index += 1;
      continue;
    }
    if (char === "\n") {
      keys.push({ type: "enter" });
      index += 1;
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      keys.push({ type: "backspace" });
      index += 1;
      continue;
    }
    if (char < " " ) {
      index += 1;
      continue;
    }
    keys.push({ type: "char", value: char });
    index += 1;
  }
  return { keys, rest: "" };
}

function csiKey(body: string, final: string): Key {
  const entered = modifiedEnter(body, final);
  if (entered) return { type: entered };
  if (final === "A") return { type: "up" };
  if (final === "B") return { type: "down" };
  if (final === "C") return { type: "right" };
  if (final === "D") return { type: "left" };
  if (final === "~" && body === "5") return { type: "page-up" };
  if (final === "~" && body === "6") return { type: "page-down" };
  return { type: "escape" };
}

/** Shift or Alt with Enter. Plain Enter stays a submit. Terminals that cannot tell Shift+Enter apart never send these. */
function modifiedEnter(body: string, final: string): "newline" | "enter" | null {
  if (final === "~") {
    const parts = body.split(";");
    if (parts[0] !== "27" || parts[2] !== "13") return null;
    const mod = Number(parts[1] ?? "");
    if (!Number.isInteger(mod)) return null;
    return mod >= 2 ? "newline" : "enter";
  }
  if (final === "u") {
    const parts = body.split(";");
    if (parts[0] !== "13") return null;
    const raw = parts.length === 1 ? "1" : (parts[1] ?? "").split(":")[0];
    const mod = Number(raw);
    if (!Number.isInteger(mod)) return null;
    return mod >= 2 ? "newline" : "enter";
  }
  return null;
}

/** A lone Escape waits this long so a split sequence can still finish. */
const ESCAPE_HOLD_MS = 50;

export class KeyDecoder {
  private rest = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly delayed: (keys: Key[]) => void = () => undefined) {}

  push(chunk: string): Key[] {
    this.disarm();
    const decoded = decodeKeys(this.rest + chunk);
    const holdingPaste = decoded.rest.includes("\u001b[200~") || decoded.rest.startsWith("\u001b[200");
    this.rest = !holdingPaste && decoded.rest.length > 32 ? "" : decoded.rest;
    if (this.rest === "\u001b") {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.rest !== "\u001b") return;
        this.rest = "";
        this.delayed([{ type: "escape" }]);
      }, ESCAPE_HOLD_MS);
    }
    return decoded.keys;
  }

  stop(): void {
    this.disarm();
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
