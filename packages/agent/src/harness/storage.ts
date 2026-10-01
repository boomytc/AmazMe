import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "../types.ts";

export interface Address {
  kind: "value" | "list";
  namespace: string;
  key: string;
}

export function value(namespace: string, key = ""): Address {
  return { kind: "value", namespace, key };
}

export function list(namespace: string, key = ""): Address {
  return { kind: "list", namespace, key };
}

export type EntryPayload = { type: "message"; message: AgentMessage } | { type: "compaction"; summary: string };

export interface Entry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  payload: EntryPayload;
}

export interface UsageRow {
  id: string;
  seq: number;
  operationId: string;
  input: number;
  output: number;
  totalTokens: number;
}

export interface ListItem {
  seq: number;
  item: unknown;
}

export type Write =
  | { type: "entry"; id: string; parentId: string | null; timestamp: number; payload: EntryPayload }
  | { type: "usage"; id: string; operationId: string; input: number; output: number; totalTokens: number }
  | { type: "set"; address: Address; value: unknown }
  | { type: "delete"; address: Address }
  | { type: "append"; address: Address; item: unknown }
  | { type: "deleteList"; address: Address };

export interface CommitResult {
  seq: number;
}

interface State {
  seq: number;
  entries: Map<string, Entry>;
  values: Map<string, unknown>;
  lists: Map<string, ListItem[]>;
  usage: UsageRow[];
}

function emptyState(): State {
  return { seq: 0, entries: new Map(), values: new Map(), lists: new Map(), usage: [] };
}

function addressKey(address: Address): string {
  if (!address.namespace) throw new Error("namespace is required");
  if (address.namespace.includes("\0") || address.key.includes("\0")) throw new Error("address contains a reserved separator");
  return `${address.kind}\0${address.namespace}\0${address.key}`;
}

export function applyWrites(state: State, writes: Write[]): State {
  let seq = state.seq;
  const entries = new Map(state.entries);
  const values = new Map(state.values);
  const lists = new Map(state.lists);
  const usage = [...state.usage];
  for (const write of writes) {
    seq += 1;
    if (write.type === "entry") {
      if (entries.has(write.id)) throw new Error(`duplicate entry ${write.id}`);
      if (write.parentId !== null && !entries.has(write.parentId)) throw new Error(`missing parent ${write.parentId}`);
      entries.set(write.id, {
        id: write.id,
        parentId: write.parentId,
        seq,
        timestamp: write.timestamp,
        payload: write.payload,
      });
    } else if (write.type === "usage") {
      usage.push({
        id: write.id,
        seq,
        operationId: write.operationId,
        input: write.input,
        output: write.output,
        totalTokens: write.totalTokens,
      });
    } else if (write.type === "set") {
      values.set(addressKey(write.address), write.value);
    } else if (write.type === "delete") {
      values.delete(addressKey(write.address));
    } else if (write.type === "append") {
      if (write.address.kind !== "list") throw new Error("append requires a list address");
      const key = addressKey(write.address);
      const current = lists.get(key) ?? [];
      lists.set(key, [...current, { seq, item: write.item }]);
    } else if (write.type === "deleteList") {
      lists.delete(addressKey(write.address));
    }
  }
  return { seq, entries, values, lists, usage };
}

export class StorageView {
  private readonly current: { state: State };

  constructor(current: { state: State }) {
    this.current = current;
  }

  entry(id: string): Entry | undefined {
    return this.current.state.entries.get(id);
  }

  entries(): Entry[] {
    return [...this.current.state.entries.values()].sort((a, b) => a.seq - b.seq);
  }

  get<T>(address: Address): T | undefined {
    return this.current.state.values.get(addressKey(address)) as T | undefined;
  }

  items(address: Address): ListItem[] {
    return this.current.state.lists.get(addressKey(address)) ?? [];
  }

  usageRows(): UsageRow[] {
    return this.current.state.usage;
  }

  values(): Array<{ key: string; value: unknown }> {
    return [...this.current.state.values.entries()].map(([key, value]) => ({ key, value }));
  }

  lists(): Array<{ key: string; items: ListItem[] }> {
    return [...this.current.state.lists.entries()].map(([key, items]) => ({ key, items }));
  }
}

/**
 * Atomic commits over entries, replaceable values, append-only lists, and a usage ledger.
 * Callers share one mutation line. `apply` is for code that already holds the line.
 */
export class MemoryStorage {
  protected state: State = emptyState();
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run<T>(fn: (view: StorageView, apply: (writes: Write[]) => CommitResult) => Promise<T> | T): Promise<T> {
    const run = this.chain.then(async () => {
      const box = { state: this.state };
      const apply = (writes: Write[]): CommitResult => {
        const next = applyWrites(box.state, writes);
        this.persist(writes);
        box.state = next;
        this.state = next;
        for (const listener of this.listeners) listener();
        return { seq: next.seq };
      };
      return fn(new StorageView(box), apply);
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  commit(writes: Write[]): Promise<CommitResult> {
    return this.run((_view, apply) => apply(writes));
  }

  read<T>(fn: (view: StorageView) => T): Promise<T> {
    return this.run((view) => fn(view));
  }

  whenIdle(): Promise<void> {
    return this.chain;
  }

  protected persist(_writes: Write[]): void {}
}

export class JsonlStorage extends MemoryStorage {
  private readonly file: string;

  constructor(file: string) {
    super();
    this.file = file;
    if (existsSync(file)) {
      const text = repairTornTail(file, readFileSync(file, "utf8"));
      for (const line of completeLines(text)) {
        const record = JSON.parse(line) as { writes: Write[] };
        this.state = applyWrites(this.state, record.writes);
      }
    }
  }

  protected override persist(writes: Write[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ writes })}\n`);
  }
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
