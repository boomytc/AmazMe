import type { Apply, StorageView } from "./storage.ts";
import { value } from "./storage.ts";
import type { HarnessMessage } from "./types.ts";

/** Current session-log generation. Older files are refused and are not rewritten. */
export const SESSION_VERSION = 1;

export const DEFAULT_TOOL_RESULT_LIMIT = 8_000;

const TRUNCATED = "[truncated]";

export function sessionFormatAddress() {
  return value("amazme.session", "format");
}

/**
 * Stamp an empty log as version 1. A log that already has data but no version-1 header
 * is a pre-v1 file: fail closed and write nothing.
 */
export function stampSession(view: StorageView, apply: Apply): void {
  const stored = view.get<{ version?: unknown }>(sessionFormatAddress());
  if (stored?.version === SESSION_VERSION) return;
  const occupied = view.entries().length > 0
    || view.usageRows().length > 0
    || view.lists().length > 0
    || view.values().length > 0;
  if (stored || occupied) throw new Error("pre-v1 session file");
  apply([{ type: "set", address: sessionFormatAddress(), value: { version: SESSION_VERSION } }]);
}

/** Clip one tool-result string for a model request. The stored log entry is not an input. */
export function clipToolText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATED.length) return TRUNCATED.slice(0, Math.max(0, limit));
  const room = limit - TRUNCATED.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return text.slice(0, head) + TRUNCATED + (tail > 0 ? text.slice(text.length - tail) : "");
}

/**
 * Copy a tool result so the request sees a clipped projection.
 * Every other message is returned as stored. This is the only transcript projection.
 */
export function projectForRequest<T extends HarnessMessage>(message: T, toolResultLimit: number): T {
  if (message.role !== "toolResult") return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "text" || block.text.length <= toolResultLimit) return block;
    changed = true;
    return { ...block, text: clipToolText(block.text, toolResultLimit) };
  });
  return changed ? { ...message, content } : message;
}
