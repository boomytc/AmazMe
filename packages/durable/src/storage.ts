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
