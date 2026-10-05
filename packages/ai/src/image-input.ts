import type { ImageContent, UserContent } from "./types.ts";

/**
 * One @ scanner for composer text.
 * Image extensions become attachments. Every other @ span, including `@readme.md`
 * and a bare `@`, stays in the text unchanged.
 * A later cut adds non-image mention kinds in this scanner. Do not add a second one.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export interface AtText {
  kind: "text";
  text: string;
}

export interface AtImage {
  kind: "image";
  path: string;
  /** Source slice, including the leading @ and any quotes. */
  raw: string;
}

export type AtPart = AtText | AtImage;

export function imageExtension(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const extension = base.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? extension : undefined;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imageMimeType(path: string): string | undefined {
  const extension = imageExtension(path);
  return extension ? IMAGE_MIME[extension] : undefined;
}

export function parseAtMentions(text: string): AtPart[] {
  const parts: AtPart[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@" || !mentionBoundary(text, index)) {
      index += 1;
      continue;
    }
    const mention = readMention(text, index);
    if (!mention || !imageExtension(mention.path)) {
      index += 1;
      continue;
    }
    if (index > cursor) parts.push({ kind: "text", text: text.slice(cursor, index) });
    parts.push({ kind: "image", path: mention.path, raw: mention.raw });
    cursor = mention.end;
    index = mention.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

/**
 * A paste that is only an image path becomes the same @ mention the scanner reads.
 * Any other paste, including a non-image path, is left unchanged by the caller.
 */
export function pastedImageMention(pasted: string): string | undefined {
  const trimmed = pasted.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
  if (trimmed.startsWith("@")) {
    const parts = parseAtMentions(trimmed);
    if (parts.length === 1 && parts[0]?.kind === "image" && parts[0].raw === trimmed) return trimmed;
    return undefined;
  }
  const quoted = trimmed.length >= 2 && (trimmed[0] === "\"" || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  const path = quoted ? trimmed.slice(1, -1) : trimmed;
  if (!path || /[\r\n]/.test(path) || (!quoted && /\s/.test(path)) || !imageExtension(path)) return undefined;
  const mention = quoted ? `@${trimmed}` : `@${path}`;
  const parts = parseAtMentions(mention);
  const only = parts[0];
  if (parts.length !== 1 || only?.kind !== "image" || only.path !== path) return undefined;
  return mention;
}

export function userContentFromParts(
  parts: readonly AtPart[],
  images: ReadonlyMap<string, { mimeType: string; data: string }>,
): UserContent[] {
  const content: UserContent[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.length === 0) continue;
      const last = content.at(-1);
      if (last?.type === "text") content[content.length - 1] = { type: "text", text: last.text + part.text };
      else content.push({ type: "text", text: part.text });
      continue;
    }
    const image = images.get(part.path);
    if (!image) throw new Error(`missing image bytes for ${part.path}`);
    const block: ImageContent = { type: "image", mimeType: image.mimeType, data: image.data };
    content.push(block);
  }
  return content;
}

/** User image blocks are sent only when `model.input` lists `image`. No separate vision flag. */
export function imageInputRefusal(
  model: { id: string; input: readonly string[] },
  content: readonly { type: string }[],
): string | undefined {
  if (!content.some((block) => block.type === "image")) return undefined;
  if (model.input.includes("image")) return undefined;
  return `Model ${model.id} does not accept image input`;
}

function mentionBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /\s/.test(text[index - 1] ?? "");
}

function readMention(text: string, at: number): { raw: string; path: string; end: number } | undefined {
  const start = at + 1;
  const quote = text[start];
  if (quote === "\"" || quote === "'") {
    const close = text.indexOf(quote, start + 1);
    if (close <= start + 1) return undefined;
    const path = text.slice(start + 1, close);
    const end = close + 1;
    return { raw: text.slice(at, end), path, end };
  }
  let end = start;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
  if (end === start) return undefined;
  const token = text.slice(start, end).replace(/[.,;:!?)]+$/, "");
  if (!token) return undefined;
  return { raw: `@${token}`, path: token, end: at + 1 + token.length };
}
