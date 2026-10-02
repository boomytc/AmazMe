import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens, messageText, uuidv7 } from "@amazme/ai";
import type { AgentMessage } from "@amazme/agent";

export interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

export interface SessionCompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
}

export interface SessionSelectEntry {
  type: "select";
  targetId: string | null;
  timestamp: string;
}

export type SessionEntry = SessionHeader | SessionMessageEntry | SessionCompactionEntry | SessionSelectEntry;
export type TreeEntry = SessionMessageEntry | SessionCompactionEntry;

/**
 * Append-only JSONL tree. The active branch is the path from the current tip
 * to the root. A later `select` record moves the tip without rewriting history.
 */
export class SessionStore {
  private readonly entries = new Map<string, TreeEntry>();
  private tipId: string | null = null;
  readonly header: SessionHeader;

  private readonly file: string;

  private constructor(file: string, header: SessionHeader) {
    this.file = file;
    this.header = header;
  }

  static create(file: string, cwd: string): SessionStore {
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: uuidv7(),
      timestamp: new Date().toISOString(),
      cwd,
    };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(header)}\n`);
    return new SessionStore(file, header);
  }

  static open(file: string): SessionStore {
    if (!existsSync(file)) throw new Error(`session not found: ${file}`);
    const lines = completeLines(repairTornTail(file, readFileSync(file, "utf8")));
    const header = JSON.parse(lines[0] ?? "") as SessionHeader;
    if (header.type !== "session" || header.version !== 3) throw new Error("unsupported session header");
    const store = new SessionStore(file, header);
    for (const line of lines.slice(1)) store.remember(JSON.parse(line) as SessionEntry);
    return store;
  }

  get tip(): string | null {
    return this.tipId;
  }

  appendMessage(message: AgentMessage): SessionMessageEntry {
    const entry: SessionMessageEntry = {
      type: "message",
      id: uuidv7(),
      parentId: this.tipId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.write(entry);
    return entry;
  }

  /**
   * Summarize the prefix and copy the tail forward under the summary.
   * Older entries stay in the file on the abandoned path.
   */
  compact(summary: string, tailCount: number): SessionCompactionEntry {
    const path = this.branch();
    const tail = closedTail(path, tailCount);
    const firstKept = tail[0];
    const prefix = firstKept ? path.slice(0, path.indexOf(firstKept)) : path;
    const parentId = prefix.length > 0 ? (prefix[prefix.length - 1]?.id ?? null) : null;
    const compaction: SessionCompactionEntry = {
      type: "compaction",
      id: uuidv7(),
      parentId,
      timestamp: new Date().toISOString(),
      summary,
    };
    this.write(compaction);
    for (const entry of tail) {
      if (entry.type !== "message") continue;
      this.write({
        type: "message",
        id: uuidv7(),
        parentId: this.tipId,
        timestamp: new Date().toISOString(),
        message: entry.message,
      });
    }
    return compaction;
  }

  select(targetId: string | null): void {
    if (targetId !== null && !this.entries.has(targetId)) throw new Error(`unknown entry ${targetId}`);
    const record: SessionSelectEntry = { type: "select", targetId, timestamp: new Date().toISOString() };
    this.write(record);
  }

  branch(): TreeEntry[] {
    const chain: TreeEntry[] = [];
    let current = this.tipId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) break;
      seen.add(current);
      const entry = this.entries.get(current);
      if (!entry) break;
      chain.push(entry);
      current = entry.parentId;
    }
    return chain.reverse();
  }

  /** Model context: a compaction replaces every entry before it and stays in front of the tail. */
  modelMessages(): AgentMessage[] {
    const path = this.branch();
    let start = 0;
    for (let index = path.length - 1; index >= 0; index--) {
      if (path[index]?.type === "compaction") {
        start = index;
        break;
      }
    }
    const messages: AgentMessage[] = [];
    for (const entry of path.slice(start)) {
      if (entry.type === "compaction") {
        messages.push({ role: "user", content: entry.summary, timestamp: Date.parse(entry.timestamp) });
        continue;
      }
      messages.push(entry.message);
    }
    return messages;
  }

  estimate(): number {
    return this.modelMessages().reduce((sum, message) => {
      if (message.role === "custom") return sum + estimateTokens(message.content);
      return sum + estimateTokens(messageText(message));
    }, 0);
  }

  private write(entry: SessionEntry): void {
    if (entry.type !== "session") this.remember(entry);
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  private remember(entry: SessionEntry): void {
    if (entry.type === "message" || entry.type === "compaction") {
      this.entries.set(entry.id, entry);
      this.tipId = entry.id;
      return;
    }
    if (entry.type === "select") this.tipId = entry.targetId;
  }
}

/** Keep a tool call and its results together when the requested tail would split them. */
function closedTail(path: TreeEntry[], tailCount: number): SessionMessageEntry[] {
  let origin = 0;
  for (let index = path.length - 1; index >= 0; index--) {
    if (path[index]?.type === "compaction") {
      origin = index + 1;
      break;
    }
  }
  const messages = path.slice(origin).filter((entry): entry is SessionMessageEntry => entry.type === "message");
  if (tailCount <= 0 || messages.length === 0) return [];
  let start = Math.max(0, messages.length - tailCount);
  let end = messages.length;
  for (let guard = 0; guard < messages.length; guard++) {
    let moved = false;
    for (let keptIndex = start; keptIndex < end; keptIndex++) {
      const entry = messages[keptIndex];
      if (!entry || entry.message.role !== "toolResult") continue;
      const owner = nearestToolCall(messages, keptIndex, entry.message.toolCallId);
      if (owner >= 0 && owner < start) {
        start = owner;
        moved = true;
      }
    }
    for (let index = start; index < end; index++) {
      const entry = messages[index];
      if (!entry || entry.message.role !== "assistant") continue;
      const ids = entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
      if (ids.length === 0) continue;
      for (let follow = index + 1; follow < messages.length; follow++) {
        const next = messages[follow];
        if (!next || next.message.role !== "toolResult" || !ids.includes(next.message.toolCallId)) break;
        if (follow >= end) {
          end = follow + 1;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return messages.slice(start, end);
}

/** The tool result belongs to the closest preceding call with that id. */
function nearestToolCall(messages: SessionMessageEntry[], before: number, toolCallId: string): number {
  for (let index = before - 1; index >= 0; index--) {
    const message = messages[index]?.message;
    if (message?.role !== "assistant") continue;
    if (message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)) return index;
  }
  return -1;
}

/** Keep only newline-terminated records, and cut a torn tail off the file before the next append. */
function repairTornTail(file: string, text: string): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  const cut = text.lastIndexOf("\n");
  const kept = cut === -1 ? "" : text.slice(0, cut + 1);
  truncateSync(file, Buffer.byteLength(kept));
  return kept;
}

function completeLines(text: string): string[] {
  const kept = text.endsWith("\n") || text.length === 0 ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return kept.split("\n").filter((line) => line.trim().length > 0);
}
