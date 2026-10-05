import type { HarnessMessage } from "./types.ts";

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

export type EntryPayload = { type: "message"; message: HarnessMessage } | { type: "compaction"; summary: string };

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
  /** Absent on old rows, or null when that turn did not report cache reads. Either makes the cumulative total null. */
  cacheRead?: number | null;
  /** Absent on old rows, which makes the cumulative total null. New rows store 0 when the provider did not report it. */
  cacheWrite?: number | null;
  /** Absent on old rows, or null when that turn did not report reasoning tokens. Either makes the cumulative total null. */
  reasoning?: number | null;
  /** Provider and model that produced this row. Absent on older rows, which makes the cumulative cost null. */
  model?: { provider: string; modelId: string };
  /**
   * Present only when this turn did not report usage. `total` is then null.
   * Absent on older rows and on turns with a quote. Those are still priced from token counts.
   * A stored null is an empty quote, not a zero-dollar turn.
   */
  cost?: { total: null };
}

export interface ListItem {
  seq: number;
  item: unknown;
}

export type Write =
  | { type: "entry"; id: string; parentId: string | null; timestamp: number; payload: EntryPayload }
  | {
      type: "usage";
      id: string;
      operationId: string;
      input: number;
      output: number;
      totalTokens: number;
      cacheRead?: number | null;
      cacheWrite?: number | null;
      reasoning?: number | null;
      model?: { provider: string; modelId: string };
      /** Set only when usage was not reported. `total` stays null and is not priced as zero. */
      cost?: { total: null };
    }
  | { type: "set"; address: Address; value: unknown }
  | { type: "delete"; address: Address }
  | { type: "append"; address: Address; item: unknown }
  | { type: "deleteList"; address: Address };

export interface CommitResult {
  seq: number;
}

/** Borrowed reads: callers must not mutate or retain mutable payloads as writable state. */
export interface StorageView {
  /**
   * The storage-wide seq of the last write this view observes. Every write type advances it; a rejected
   * batch does not. Writes of other lanes advance it too, it may skip numbers between two reads,
   * and it is not a durability promise.
   */
  version(): number;
  entry(id: string): Entry | undefined;
  entries(): Entry[];
  get<T>(address: Address): T | undefined;
  items(address: Address): ListItem[];
  usageRows(): UsageRow[];
  values(): Array<{ key: string; value: unknown }>;
  lists(): Array<{ key: string; items: ListItem[] }>;
}

export type Apply = (writes: readonly Write[]) => CommitResult;

/**
 * One serialized mutation line. Each apply is its own atomic, persisted publication;
 * run is not a transaction spanning several applies. Earlier applies survive a later throw.
 * The view observes every successful apply in the callback. Apply expires when that callback settles.
 * Writes transfer payload ownership to storage; subscribers are synchronous invalidation callbacks.
 */
export interface Storage {
  run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T>;
  commit(writes: readonly Write[]): Promise<CommitResult>;
  read<T>(fn: (view: StorageView) => T): Promise<T>;
  subscribe(listener: () => void): () => void;
  whenIdle(): Promise<void>;
}
