import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { imageMimeType, parseAtMentions, userContentFromParts, type UserContent } from "@amazme/ai";

/** Base64 stays under the runtime frame limit. */
const MAX_IMAGE_CHARS = 8_000_000;

export async function imagePrompt(text: string, cwd: string): Promise<
  | { ok: true; content?: UserContent[] }
  | { ok: false; message: string }
> {
  const parts = parseAtMentions(text);
  const images = parts.filter((part) => part.kind === "image");
  if (images.length === 0) return { ok: true };
  const loaded = new Map<string, { mimeType: string; data: string }>();
  for (const image of images) {
    if (loaded.has(image.path)) continue;
    const mimeType = imageMimeType(image.path);
    if (!mimeType) return { ok: false, message: `不支持的图片 ${image.path}` };
    let bytes: Buffer;
    try {
      bytes = await readFile(resolveImagePath(image.path, cwd));
    } catch {
      return { ok: false, message: `找不到图片 ${image.path}` };
    }
    if (bytes.length === 0) return { ok: false, message: `图片是空的 ${image.path}` };
    const data = bytes.toString("base64");
    if (data.length > MAX_IMAGE_CHARS) return { ok: false, message: `图片太大 ${image.path}` };
    loaded.set(image.path, { mimeType, data });
  }
  return { ok: true, content: userContentFromParts(parts, loaded) };
}

function resolveImagePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}
