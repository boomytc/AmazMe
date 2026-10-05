import type { Address, Apply, CommitResult, Entry, ListItem, Storage, StorageView, UsageRow, Write } from "../storage.ts";

interface State {
  seq: number;
  entries: Map<string, Entry>;
  values: Map<string, unknown>;
  lists: Map<string, ListItem[]>;
  usage: UsageRow[];
}

function addressKey(address: Address): string {
  if (!address.namespace) throw new Error("namespace is required");
  if (address.namespace.includes("\0") || address.key.includes("\0")) throw new Error("address contains a reserved separator");
  return `${address.kind}\0${address.namespace}\0${address.key}`;
}

/** Shared write reducer for the in-memory reference and the Node JSONL adapter. */
export function applyWrites(state: State, writes: readonly Write[]): State {
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
      entries.set(write.id, { id: write.id, parentId: write.parentId, seq, timestamp: write.timestamp, payload: write.payload });
    } else if (write.type === "usage") {
      const row: UsageRow = {
        id: write.id,
        seq,
        operationId: write.operationId,
        input: write.input,
        output: write.output,
        totalTokens: write.totalTokens,
      };
      if ("cacheRead" in write) row.cacheRead = write.cacheRead ?? null;
      if ("cacheWrite" in write) row.cacheWrite = write.cacheWrite ?? null;
      if ("reasoning" in write) row.reasoning = write.reasoning ?? null;
      if (write.model) row.model = { provider: write.model.provider, modelId: write.model.modelId };
      if (write.cost) row.cost = { total: null };
      usage.push(row);
    } else if (write.type === "set") {
      values.set(addressKey(write.address), write.value);
    } else if (write.type === "delete") {
      values.delete(addressKey(write.address));
    } else if (write.type === "append") {
      if (write.address.kind !== "list") throw new Error("append requires a list address");
      const key = addressKey(write.address);
      lists.set(key, [...(lists.get(key) ?? []), { seq, item: write.item }]);
    } else if (write.type === "deleteList") {
      lists.delete(addressKey(write.address));
    }
  }
  return { seq, entries, values, lists, usage };
}

class MemoryView implements StorageView {
  private readonly current: { state: State };
  constructor(current: { state: State }) { this.current = current; }

  version(): number { return this.current.state.seq; }
  entry(id: string): Entry | undefined { return this.current.state.entries.get(id); }
  entries(): Entry[] { return [...this.current.state.entries.values()].sort((a, b) => a.seq - b.seq); }
  get<T>(address: Address): T | undefined { return this.current.state.values.get(addressKey(address)) as T | undefined; }
  items(address: Address): ListItem[] { return this.current.state.lists.get(addressKey(address)) ?? []; }
  usageRows(): UsageRow[] { return this.current.state.usage; }
  values(): Array<{ key: string; value: unknown }> {
    return [...this.current.state.values.entries()].map(([key, value]) => ({ key, value }));
  }
  lists(): Array<{ key: string; items: ListItem[] }> {
    return [...this.current.state.lists.entries()].map(([key, items]) => ({ key, items }));
  }
}

export class MemoryStorage implements Storage {
  protected state: State = { seq: 0, entries: new Map(), values: new Map(), lists: new Map(), usage: [] };
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    const run = this.chain.then(async () => {
      const box = { state: this.state };
      let active = true;
      const apply: Apply = (writes) => {
        if (!active) throw new Error("apply used outside storage.run");
        const next = applyWrites(box.state, writes);
        this.persist(writes);
        box.state = next;
        this.state = next;
        for (const listener of this.listeners) listener();
        return { seq: next.seq };
      };
      try {
        const result = fn(new MemoryView(box), apply);
        if (result && typeof (result as PromiseLike<T>).then === "function") return await result;
        return result;
      } finally {
        active = false;
      }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  commit(writes: readonly Write[]): Promise<CommitResult> { return this.run((_view, apply) => apply(writes)); }
  read<T>(fn: (view: StorageView) => T): Promise<T> { return this.run((view) => fn(view)); }
  whenIdle(): Promise<void> { return this.chain; }
  protected persist(_writes: readonly Write[]): void {}
}
