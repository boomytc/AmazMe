import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Another writer holds this storage. The caller must not steal or overwrite it. */
export class StorageBusyError extends Error {
  readonly code = "storage_busy" as const;
  constructor(message = "storage is busy") {
    super(message);
    this.name = "StorageBusyError";
  }
}

interface OwnerRecord {
  token: string;
  pid: number;
  hostname: string;
}

export interface HeldLock {
  readonly directory: string;
  readonly token: string;
  release(): void;
}

const holders = new Map<string, string>();

/**
 * Exclusive directory lock for one local filesystem.
 * A live pid is never stolen, even when the directory is old.
 * An empty, unreadable, or foreign-host lock stays busy.
 * Directories live under the system temp dir so deleting the data file or its parent does not remove them.
 */
export function acquireLock(directory: string, key: string): HeldLock {
  if (holders.has(key)) throw new StorageBusyError("storage is busy");
  const token = randomUUID();
  holders.set(key, token);
  let ownedDirectory = false;
  try {
    takeDirectory(directory);
    ownedDirectory = true;
    const record: OwnerRecord = { token, pid: process.pid, hostname: hostname() };
    writeFileSync(join(directory, "owner"), JSON.stringify(record), { flag: "wx" });
  } catch (error) {
    if (holders.get(key) === token) holders.delete(key);
    if (ownedDirectory) {
      try { unlinkSync(join(directory, "owner")); } catch { /* the owner file was not written */ }
      try { rmdirSync(directory); } catch { /* an unconfirmed directory stays busy */ }
    }
    if (error instanceof StorageBusyError) throw error;
    if (isCode(error, "EEXIST")) throw new StorageBusyError("storage is busy");
    throw error;
  }
  let released = false;
  return {
    directory,
    token,
    release() {
      if (released) return;
      unlock(directory, key, token);
      released = true;
    },
  };
}

/** Real path of a data file. Symlinks collapse; hard links do not. A broken symlink is refused. */
export function canonicalStoragePath(file: string): string {
  const absolute = resolve(file);
  mkdirSync(dirname(absolute), { recursive: true });
  const candidate = join(realpathSync(dirname(absolute)), basename(absolute));
  try {
    return realpathSync(candidate);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  try {
    if (lstatSync(candidate).isSymbolicLink()) throw new Error(`storage path is a broken symlink: ${candidate}`);
  } catch (error) {
    if (isCode(error, "ENOENT")) return candidate;
    throw error;
  }
  try {
    return realpathSync(candidate);
  } catch (error) {
    if (isCode(error, "ENOENT")) return candidate;
    throw error;
  }
}

export function pathLockDirectory(canonicalPath: string): string {
  return join(lockHome(), "path", createHash("sha256").update(canonicalPath).digest("hex"));
}

export function inodeLockDirectory(dev: bigint, ino: bigint): string {
  return join(lockHome(), "inode", `${dev}-${ino}`);
}

export function prepareLockHome(): void {
  mkdirSync(join(lockHome(), "path"), { recursive: true });
  mkdirSync(join(lockHome(), "inode"), { recursive: true });
}

function lockHome(): string {
  return join(tmpdir(), "amazme-jsonl-locks", String(userInfo().uid));
}

function takeDirectory(directory: string): void {
  try {
    mkdirSync(directory);
    return;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  reclaimDead(directory);
  try {
    mkdirSync(directory);
  } catch (error) {
    if (isCode(error, "EEXIST")) throw new StorageBusyError("storage is busy");
    throw error;
  }
}

function reclaimDead(directory: string): void {
  const ownerPath = join(directory, "owner");
  const raw = readOwner(ownerPath);
  const record = parseRecord(raw);
  if (!record || record.hostname !== hostname() || !pidDead(record.pid)) throw new StorageBusyError("storage is busy");
  const grave = join(directory, `owner.dead.${randomUUID()}`);
  try {
    renameSync(ownerPath, grave);
  } catch (error) {
    if (isCode(error, "ENOENT")) throw new StorageBusyError("lock owner is missing");
    throw error;
  }
  let moved: string;
  try {
    moved = readFileSync(grave, "utf8");
  } catch {
    throw new StorageBusyError("could not clear a dead lock");
  }
  if (moved !== raw || !pidDead(record.pid)) {
    try { renameSync(grave, ownerPath); } catch { /* the next open stays busy */ }
    throw new StorageBusyError("storage is busy");
  }
  try {
    unlinkSync(grave);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw new StorageBusyError("could not clear a dead lock");
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw new StorageBusyError("could not clear a dead lock");
  }
}

function unlock(directory: string, key: string, token: string): void {
  if (holders.get(key) !== token) return;
  const ownerPath = join(directory, "owner");
  let raw: string | undefined;
  try {
    raw = readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  if (raw !== undefined) {
    const record = parseRecord(raw);
    if (!record || record.token !== token) {
      holders.delete(key);
      return;
    }
    unlinkSync(ownerPath);
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  if (holders.get(key) === token) holders.delete(key);
}

function readOwner(ownerPath: string): string {
  try {
    return readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) throw new StorageBusyError("lock owner is missing");
    throw error;
  }
}

function parseRecord(raw: string): OwnerRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<OwnerRecord>;
    const pid = value.pid;
    if (typeof value.token !== "string" || typeof pid !== "number" || !Number.isInteger(pid) || typeof value.hostname !== "string") return undefined;
    return { token: value.token, pid, hostname: value.hostname };
  } catch {
    return undefined;
  }
}

/** `true` only when the kernel reports that no process has this pid. */
function pidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isCode(error, "ESRCH");
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
