/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import type { ByteConnection, ByteConnectionHandlers } from "./types.ts";

export interface UnixListenerOptions {
  /** The physical socket path, chosen by the caller. Unrelated to the logical server ID. */
  path: string;
  /** Bytes accepted by a connection's `send` that the socket has not flushed yet. Default 32 MiB. */
  maxQueuedBytes?: number;
  /** How long a graceful connection close may wait for buffered bytes before destroying. Default 5,000 ms. */
  closeTimeoutMs?: number;
  /** Socket and cleanup errors. Its own errors are ignored. */
  onError?: (error: Error) => void;
}

export interface UnixListener {
  readonly path: string;
  readonly connectionCount: number;
  /** Stops accepting, destroys open sockets and removes the socket path if it is still this listener's. Repeatable. */
  close(): Promise<void>;
}

interface Acceptor {
  accept(connection: ByteConnection): ByteConnectionHandlers;
}

interface Identity {
  dev: number;
  ino: number;
}

const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

/**
 * Listens on a Unix domain socket and hands each accepted socket to `acceptor.accept`. Directories it creates are
 * 0700 and the socket is 0600; an existing caller directory keeps its mode. Any existing path fails.
 * The socket is bound inside a private
 * 0700 directory, made 0600 there, and hard-linked into place: publishing never replaces a file, nobody can connect
 * before the mode is set, and libuv's close-time unlink only touches the private name. A second private link keeps
 * the socket inode alive until cleanup finishes, including on filesystems without creation timestamps.
 */
export async function listenUnix(acceptor: Acceptor, options: UnixListenerOptions): Promise<UnixListener> {
  if (process.platform === "win32") throw new Error("the Unix socket listener is not supported on Windows");
  if (typeof options.path !== "string" || options.path.length === 0) throw new TypeError("a Unix socket path is required");
  const maxQueued = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(maxQueued) || maxQueued <= 0) throw new RangeError("maxQueuedBytes must be a positive integer");
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs <= 0 || closeTimeoutMs > 2_147_483_647) throw new RangeError("closeTimeoutMs is out of range");
  const report = (error: unknown) => {
    try {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Diagnostics cannot change listener state.
    }
  };
  const path = resolve(options.path);
  const directory = dirname(path);
  await makePrivateDirectory(directory);
  await checkExisting(path);

  const connections = new Set<UnixConnection>();
  let published = false;
  const server = createServer((socket) => {
    if (!published) {
      socket.on("error", () => undefined);
      socket.destroy();
      return;
    }
    const connection = new UnixConnection(socket, maxQueued, closeTimeoutMs);
    connections.add(connection);
    socket.once("close", () => connections.delete(connection));
    let handlers: ByteConnectionHandlers;
    try {
      handlers = acceptor.accept(connection);
    } catch (error) {
      report(error);
      connection.destroy();
      return;
    }
    connection.attach(handlers, report);
  });
  const privateDirectory = await mkdtemp(join(directory, ".amazme-bind-"));
  const bindPath = join(privateDirectory, "s");
  let identity: Identity;
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(bindPath, () => {
        server.off("error", fail);
        done();
      });
    });
    await chmod(bindPath, 0o600);
    const bound = await lstat(bindPath);
    if (!bound.isSocket()) throw new Error(`bind path is not a socket: ${bindPath}`);
    await link(bindPath, join(privateDirectory, "owned"));
    await link(bindPath, path);
    identity = identityOf(bound);
  } catch (error) {
    await closeNetServer(server);
    await rm(privateDirectory, { recursive: true, force: true }).catch(report);
    throw error;
  }
  server.on("error", report);
  published = true;

  let closing: Promise<void> | undefined;
  return {
    path,
    get connectionCount() {
      return connections.size;
    },
    close() {
      closing ??= (async () => {
        const stopped = closeNetServer(server);
        for (const connection of [...connections]) connection.destroy();
        await stopped;
        try {
          await removeOwned(path, identity).catch(report);
        } finally {
          await rm(privateDirectory, { recursive: true, force: true }).catch(report);
        }
      })();
      return closing;
    },
  };
}

async function makePrivateDirectory(directory: string): Promise<void> {
  const first = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!first) return;
  const created: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    created.push(current);
    if (current === first || dirname(current) === current) break;
  }
  for (const entry of created) await chmod(entry, 0o700);
}

async function checkExisting(path: string): Promise<void> {
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket()) throw new Error(`refusing to replace a path that is not a socket: ${path}`);
  throw new Error(`a socket already exists at ${path}; release it before listening`);
}

function identityOf(stats: Stats): Identity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(stats: Stats, identity: Identity): boolean {
  return stats.isSocket() && stats.dev === identity.dev && stats.ino === identity.ino;
}

/** Moves the entry aside, checks it is still `identity`, and only then unlinks it. Anything else is put back. */
async function removeOwned(path: string, identity: Identity): Promise<void> {
  const aside = join(dirname(path), `.${basename(path)}.${randomUUID()}.remove`);
  try {
    if (!sameIdentity(await lstat(path), identity)) return;
    await rename(path, aside);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  if (sameIdentity(await lstat(aside), identity)) {
    await unlink(aside);
    return;
  }
  try {
    await link(aside, path);
  } catch {
    throw new Error(`${path} was replaced during cleanup and could not be restored; the replacement is at ${aside}`);
  }
  await unlink(aside);
}

function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((done) => server.close(() => done()));
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** A server-side socket: ordered, drain-aware writes with a byte bound, and exactly one terminal handler call. */
class UnixConnection implements ByteConnection {
  private readonly socket: Socket;
  private readonly maxQueued: number;
  private readonly closeTimeoutMs: number;
  private queued = 0;
  private tail: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";

  constructor(socket: Socket, maxQueued: number, closeTimeoutMs: number) {
    this.socket = socket;
    this.maxQueued = maxQueued;
    this.closeTimeoutMs = closeTimeoutMs;
    socket.on("error", () => undefined);
  }

  attach(handlers: ByteConnectionHandlers, report: (error: unknown) => void): void {
    const call = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        report(error);
      }
    };
    this.socket.on("data", (chunk: Buffer) => {
      if (this.state === "open") call(() => handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    });
    const terminal = (fn: () => void) => {
      if (this.state === "closed") return;
      const local = this.state === "closing";
      this.state = "closed";
      if (!local) call(fn);
    };
    this.socket.once("end", () => terminal(() => handlers.onClose()));
    this.socket.once("close", () => terminal(() => handlers.onClose()));
    this.socket.on("error", (error) => {
      terminal(() => handlers.onError(error));
      this.socket.destroy();
    });
  }

  send(chunk: Uint8Array): Promise<void> {
    if (this.state !== "open") return Promise.reject(new Error("the Unix socket is closed"));
    if (this.queued + chunk.byteLength > this.maxQueued) {
      return Promise.reject(new Error(`more than ${this.maxQueued} bytes are waiting for the Unix socket`));
    }
    this.queued += chunk.byteLength;
    const bytes = Buffer.from(chunk);
    const write = this.tail.then(() => writeChunk(this.socket, bytes));
    const tracked = write.finally(() => { this.queued -= bytes.byteLength; });
    this.tail = tracked.catch(() => undefined);
    return tracked;
  }

  /** Graceful: ends the socket after the bytes already accepted, destroying it if that takes too long. */
  close(): void {
    if (this.state !== "open") return;
    this.state = "closing";
    const timer = setTimeout(() => this.socket.destroy(), this.closeTimeoutMs);
    timer.unref();
    this.socket.once("close", () => clearTimeout(timer));
    void this.tail.then(() => {
      if (!this.socket.destroyed) this.socket.end();
    });
  }

  /** Listener shutdown: unlike `close()`, the server still learns about it through `onClose`. */
  destroy(): void {
    this.socket.destroy();
  }
}

function writeChunk(socket: Socket, bytes: Buffer): Promise<void> {
  if (socket.destroyed || !socket.writable) return Promise.reject(new Error("the Unix socket is closed"));
  return new Promise((done, fail) => {
    let flushed = false;
    let drained = true;
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      if (error) {
        settled = true;
        cleanup();
        fail(error);
        return;
      }
      if (!flushed || !drained) return;
      settled = true;
      cleanup();
      done();
    };
    const onDrain = () => { drained = true; finish(); };
    const onClose = () => finish(new Error("the Unix socket closed during a write"));
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
    };
    socket.once("close", onClose);
    try {
      drained = socket.write(bytes, (error) => {
        flushed = true;
        finish(error ?? undefined);
      });
      if (!drained) socket.once("drain", onDrain);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
