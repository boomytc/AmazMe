import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Apply, StorageView, Write } from "../storage.ts";
import {
  acquireLock,
  canonicalStoragePath,
  inodeLockDirectory,
  pathLockDirectory,
  prepareLockHome,
  StorageBusyError,
} from "./jsonl-lock.ts";
import type { HeldLock } from "./jsonl-lock.ts";
import { applyWrites, MemoryStorage } from "./memory.ts";

/**
 * Node filesystem adapter. Each newline-terminated record is one atomic apply.
 * The constructor replays and repairs a torn tail immediately. It does not take a lock;
 * cross-process writers use `openJsonlOwner` so that repair happens only after the lock is held.
 */
export class JsonlStorage extends MemoryStorage {
  private readonly file: string;
  private accepting = true;
  private closed: Promise<void> | undefined;

  constructor(file: string) {
    super();
    this.file = file;
    if (existsSync(file)) {
      const text = repairTornTail(file, readFileSync(file, "utf8"));
      for (const line of text.split("\n").filter((line) => line.trim().length > 0)) {
        const record = JSON.parse(line) as { writes: Write[] };
        this.state = applyWrites(this.state, record.writes);
      }
    }
  }

  override run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error("storage is closed"));
    return super.run(fn);
  }

  /** Stop new callbacks and wait for the queue that is already admitted. Does not delete or unlock. */
  close(): Promise<void> {
    if (!this.closed) {
      this.accepting = false;
      this.closed = this.whenIdle();
    }
    return this.closed;
  }

  protected override persist(writes: readonly Write[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ writes })}\n`);
  }
}

/** Owned JSONL file. `close` stops storage, `deleteData` unlinks that inode, and `release` drops the locks. */
export interface JsonlOwner {
  readonly storage: JsonlStorage;
  close(): Promise<void>;
  deleteData(): Promise<void>;
  release(): Promise<void>;
}

export { StorageBusyError };

/**
 * Open one writable JSONL file. The path lock and the inode lock are both held before the file is repaired.
 * `close` waits for admitted storage work and keeps the locks. `deleteData` unlinks the file only when it is
 * still the opened inode. `release` waits for storage to stop, then drops both locks. A failed `release`
 * can be retried; after it succeeds, another call does nothing. Do not await these from inside `storage.run`.
 */
export function openJsonlOwner(file: string): JsonlOwner {
  const path = canonicalStoragePath(file);
  prepareLockHome();
  const pathLock = acquireLock(pathLockDirectory(path), `path:${path}`);
  let inodeLock: HeldLock | undefined;
  try {
    ensureDataFile(path);
    const stat = statSync(path, { bigint: true });
    inodeLock = acquireLock(inodeLockDirectory(stat.dev, stat.ino), `inode:${stat.dev}:${stat.ino}`);
    const storage = new JsonlStorage(path);
    return bindOwner(storage, path, stat.dev, stat.ino, pathLock, inodeLock);
  } catch (error) {
    const cleanup: unknown[] = [];
    if (inodeLock) {
      try { inodeLock.release(); } catch (cause) { cleanup.push(cause); }
    }
    try { pathLock.release(); } catch (cause) { cleanup.push(cause); }
    if (cleanup.length === 0) throw error;
    throw new AggregateError([error, ...cleanup], "opening storage failed and releasing the lock failed");
  }
}

function bindOwner(storage: JsonlStorage, path: string, ownedDev: bigint, ownedIno: bigint, pathLock: HeldLock, inodeLock: HeldLock): JsonlOwner {
  let released = false;
  let closing: Promise<void> | undefined;
  let closeOnce: Promise<void> | undefined;
  let releaseOnce: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const stopAdmission = (): Promise<void> => {
    closing ??= storage.close();
    return closing;
  };
  const deleteData = async (): Promise<void> => {
    if (released) throw new Error("storage ownership was released");
    await stopAdmission();
    if (released) throw new Error("storage ownership was released");
    try {
      const current = statSync(path, { bigint: true });
      if (current.dev !== ownedDev || current.ino !== ownedIno) return;
      unlinkSync(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
  };
  const release = async (): Promise<void> => {
    if (released) return;
    await stopAdmission();
    if (released) return;
    const errors: unknown[] = [];
    try { inodeLock.release(); } catch (error) { errors.push(error); }
    try { pathLock.release(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "storage lock release failed");
    released = true;
  };
  return {
    storage,
    close() {
      const stopping = stopAdmission();
      closeOnce ??= enqueue(() => stopping);
      return closeOnce;
    },
    deleteData() {
      stopAdmission();
      return enqueue(() => deleteData());
    },
    release() {
      stopAdmission();
      if (releaseOnce) return releaseOnce;
      const run = enqueue(() => release());
      releaseOnce = run.then(() => undefined, (error: unknown) => {
        releaseOnce = undefined;
        return Promise.reject(error);
      });
      return releaseOnce;
    },
  };
}

function ensureDataFile(path: string): void {
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
}

function repairTornTail(file: string, text: string): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  const cut = text.lastIndexOf("\n");
  const kept = cut === -1 ? "" : text.slice(0, cut + 1);
  truncateSync(file, Buffer.byteLength(kept));
  return kept;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
