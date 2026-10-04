import { appendFileSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Apply, Storage, StorageView, Write } from "../storage.ts";
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

abstract class ClosableJsonlStorage extends MemoryStorage {
  private accepting = true;
  private closed: Promise<void> | undefined;

  constructor(text: string) {
    super();
    for (const line of text.split("\n").filter((line) => line.trim().length > 0)) {
      const record = JSON.parse(line) as { writes: Write[] };
      this.state = applyWrites(this.state, record.writes);
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
      const run = this.whenIdle().then(() => this.dispose());
      this.closed = run.catch((error: unknown) => {
        this.closed = undefined;
        throw error;
      });
    }
    return this.closed;
  }

  protected dispose(): void {}
}

/**
 * Low-level Node adapter. Construction replays and repairs a torn tail without a lock.
 * Cross-process writers use `openJsonlOwner`, which holds locks and pins the inode before replay.
 */
export class JsonlStorage extends ClosableJsonlStorage {
  private readonly file: string;

  constructor(file: string) {
    super(existsSync(file) ? repairTornTail(file, readFileSync(file, "utf8")) : "");
    this.file = file;
  }

  protected override persist(writes: readonly Write[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ writes })}\n`);
  }
}

/** Managed storage keeps the locked inode open; path replacement never redirects I/O. */
class OwnedJsonlStorage extends ClosableJsonlStorage {
  private descriptor: number | undefined;
  private readonly assertOwned: () => void;

  constructor(fd: number, assertOwned: () => void) {
    super(readOwnedFile(fd, assertOwned));
    this.descriptor = fd;
    this.assertOwned = assertOwned;
  }

  override run<T>(fn: (view: StorageView, apply: Apply) => Promise<T> | T): Promise<T> {
    return super.run((view, apply) => {
      this.assertOwned();
      return fn(view, apply);
    });
  }

  protected override persist(writes: readonly Write[]): void {
    this.assertOwned();
    if (this.descriptor === undefined) throw new Error("storage is closed");
    appendFileSync(this.descriptor, `${JSON.stringify({ writes })}\n`);
  }

  protected override dispose(): void {
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor);
      this.descriptor = undefined;
    }
  }
}

/** Owned JSONL file. `close` stops storage, `deleteData` unlinks that inode, and `release` drops the locks. */
export interface JsonlOwner {
  readonly storage: Storage & { close(): Promise<void> };
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
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) throw new Error("storage must be a regular file");
    inodeLock = acquireLock(inodeLockDirectory(stat.dev, stat.ino), `inode:${stat.dev}:${stat.ino}`);
    const heldInode = inodeLock;
    const storage = new OwnedJsonlStorage(descriptor, () => {
      pathLock.assertHeld();
      heldInode.assertHeld();
    });
    return bindOwner(storage, path, stat.dev, stat.ino, pathLock, inodeLock);
  } catch (error) {
    const cleanup: unknown[] = [];
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (cause) { cleanup.push(cause); }
    }
    if (inodeLock) {
      try { inodeLock.release(); } catch (cause) { cleanup.push(cause); }
    }
    try { pathLock.release(); } catch (cause) { cleanup.push(cause); }
    if (cleanup.length === 0) throw error;
    throw new AggregateError([error, ...cleanup], "opening storage failed and releasing the lock failed");
  }
}

function bindOwner(storage: OwnedJsonlStorage, path: string, ownedDev: bigint, ownedIno: bigint, pathLock: HeldLock, inodeLock: HeldLock): JsonlOwner {
  let released = false;
  let dataDeleted = false;
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
    if (!closing) {
      closing = storage.close().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      // Admission stops immediately, even when this wait is queued behind another owner operation.
      void closing.catch(() => undefined);
    }
    return closing;
  };
  const deleteData = async (stopping: Promise<void>): Promise<void> => {
    if (released) throw new Error("storage ownership was released");
    await stopping;
    if (released) throw new Error("storage ownership was released");
    // A delete that already completed must not be repeated after a partial unlock. The old path
    // may now name a later owner's data; only retry releasing this owner's remaining locks.
    if (dataDeleted) return;
    pathLock.assertHeld();
    inodeLock.assertHeld();
    try {
      const current = statSync(path, { bigint: true });
      if (current.dev !== ownedDev || current.ino !== ownedIno) {
        dataDeleted = true;
        return;
      }
      unlinkSync(path);
      dataDeleted = true;
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        dataDeleted = true;
        return;
      }
      throw error;
    }
  };
  const release = async (stopping: Promise<void>): Promise<void> => {
    if (released) return;
    await stopping;
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
      if (!closeOnce) {
        closeOnce = enqueue(() => stopping).catch((error: unknown) => {
          closeOnce = undefined;
          throw error;
        });
      }
      return closeOnce;
    },
    deleteData() {
      const stopping = stopAdmission();
      return enqueue(() => deleteData(stopping));
    },
    release() {
      if (releaseOnce) return releaseOnce;
      const stopping = stopAdmission();
      const run = enqueue(() => release(stopping));
      releaseOnce = run.then(() => undefined, (error: unknown) => {
        releaseOnce = undefined;
        return Promise.reject(error);
      });
      return releaseOnce;
    },
  };
}

function readOwnedFile(fd: number, assertOwned: () => void): string {
  assertOwned();
  const text = readFileSync(fd, "utf8");
  assertOwned();
  if (text.length === 0 || text.endsWith("\n")) return text;
  const cut = text.lastIndexOf("\n");
  const kept = cut === -1 ? "" : text.slice(0, cut + 1);
  ftruncateSync(fd, Buffer.byteLength(kept));
  return kept;
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
