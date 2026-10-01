import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens, messageText } from "@amazme/ai";
import { type AgentMessage, uuidv7 } from "@amazme/agent";

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
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
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
    const tail = path.slice(Math.max(0, path.length - tailCount));
    const prefix = path.slice(0, path.length - tail.length);
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
