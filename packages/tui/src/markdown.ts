import { paint, theme } from "./theme.ts";

/** Structured lines for one message. Fence backticks and heading marks are not the structure. */
export function markdownLines(source: string, tone: "assistant" | "user" = "assistant"): string[] {
  const body = tone === "user" ? theme.warm : theme.text;
  const heading = tone === "user" ? theme.warm : theme.accent;
  const lines = source.split("\n");
  const out: string[] = [];
  let fence: string[] | null = null;
  const closeFence = (): void => {
    out.push(paint(theme.border, "┌"));
    for (const row of fence ?? []) out.push(paint(theme.dim, `│ ${row}`));
    out.push(paint(theme.border, "└"));
    fence = null;
  };
  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith("```")) closeFence();
      else fence.push(line);
      continue;
    }
    if (line.trim().startsWith("```")) {
      fence = [];
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      out.push(paint(heading, headingMatch[2] ?? ""));
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(paint(body, `• ${inlinePlain(bullet[1] ?? "")}`));
      continue;
    }
    out.push(inline(line, body));
  }
  if (fence) closeFence();
  return out;
}

function inlinePlain(text: string): string {
  return text.replace(/`([^`]*)`/g, "$1");
}

function inline(text: string, body: string): string {
  const parts = text.split("`");
  if (parts.length < 3) return paint(body, text);
  let out = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (part.length === 0) continue;
    out += index % 2 === 1 ? paint(theme.dim, part) : paint(body, part);
  }
  return out;
}
