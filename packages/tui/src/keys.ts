export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "page-up" }
  | { type: "page-down" };

export function decodeKeys(input: string): { keys: Key[]; rest: string } {
  const chars = Array.from(input);
  const keys: Key[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (char === "\u001b") {
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
  if (final === "A") return { type: "up" };
  if (final === "B") return { type: "down" };
  if (final === "~" && body === "5") return { type: "page-up" };
  if (final === "~" && body === "6") return { type: "page-down" };
  return { type: "escape" };
}

export class KeyDecoder {
  private rest = "";

  push(chunk: string): Key[] {
    const decoded = decodeKeys(this.rest + chunk);
    this.rest = decoded.rest.length > 32 ? "" : decoded.rest;
    return decoded.keys;
  }
}
