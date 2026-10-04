/// <reference types="node" />
import { createConnection, type Socket } from "node:net";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface UnixTransportOptions {
  /** The physical socket path. The logical server identity is still checked by the handshake. */
  path: string;
  /** Bytes accepted by `send` that the socket has not flushed yet. Going over rejects the send. Default 32 MiB. */
  maxQueuedBytes?: number;
  /** Default 10,000 ms. */
  connectTimeoutMs?: number;
}

const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

/** A client transport factory over a Unix domain socket. Each `connect()` opens a fresh socket. */
export function createUnixTransport(options: UnixTransportOptions): ByteTransportFactory {
  if (process.platform === "win32") throw new Error("the Unix socket transport is not supported on Windows");
  if (typeof options.path !== "string" || options.path.length === 0) throw new TypeError("a Unix socket path is required");
  const maxQueued = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxQueued) || maxQueued <= 0) throw new RangeError("maxQueuedBytes must be a positive integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError("connectTimeoutMs is out of range");
  return (handlers) => open(options.path, maxQueued, timeoutMs, handlers);
}

function open(path: string, maxQueued: number, timeoutMs: number, handlers: ByteTransportHandlers): Promise<ByteTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let state: "connecting" | "open" | "closed" = "connecting";
    const transport = new UnixSocketTransport(socket, maxQueued, () => { state = "closed"; });
    const timer = setTimeout(() => {
      if (state !== "connecting") return;
      state = "closed";
      socket.destroy();
      reject(new Error(`connecting to ${path} timed out`));
    }, timeoutMs);
    const terminal = (report: () => void) => {
      if (state !== "open") return;
      state = "closed";
      transport.release();
      report();
    };
    socket.once("connect", () => {
      clearTimeout(timer);
      if (state !== "connecting") return;
      state = "open";
      resolve(transport);
    });
    socket.on("data", (chunk: Buffer) => {
      if (state === "open") handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    socket.once("end", () => terminal(() => handlers.onClose()));
    socket.once("close", () => terminal(() => handlers.onClose()));
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (state === "connecting") {
        state = "closed";
        socket.destroy();
        reject(error);
        return;
      }
      terminal(() => handlers.onError(error));
    });
  });
}

/**
 * Writes in call order, one chunk at a time. A chunk counts as sent once Node accepted it and, when the socket
 * buffer was full, after `drain`. Unflushed bytes are bounded by `maxQueuedBytes`.
 */
class UnixSocketTransport implements ByteTransport {
  private readonly socket: Socket;
  private readonly maxQueued: number;
  private readonly onLocalClose: () => void;
  private queued = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(socket: Socket, maxQueued: number, onLocalClose: () => void) {
    this.socket = socket;
    this.maxQueued = maxQueued;
    this.onLocalClose = onLocalClose;
  }

  send(chunk: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("the Unix socket is closed"));
    if (this.queued + chunk.byteLength > this.maxQueued) {
      return Promise.reject(new Error(`more than ${this.maxQueued} bytes are waiting for the Unix socket`));
    }
    this.queued += chunk.byteLength;
    const bytes = Buffer.from(chunk);
    const write = this.tail.then(() => writeChunk(this.socket, bytes, () => this.closed));
    const tracked = write.finally(() => { this.queued -= bytes.byteLength; });
    this.tail = tracked.catch(() => undefined);
    return tracked;
  }

  close(): void {
    if (this.closed) return;
    this.onLocalClose();
    this.release();
  }

  release(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

/** Resolves once Node accepted the chunk and, if the socket buffer was full, after `drain`. */
function writeChunk(socket: Socket, bytes: Buffer, closed: () => boolean): Promise<void> {
  if (closed() || socket.destroyed || !socket.writable) return Promise.reject(new Error("the Unix socket is closed"));
  return new Promise((resolve, reject) => {
    let flushed = false;
    let drained = true;
    let settled = false;
    const done = (error?: Error | null) => {
      if (settled) return;
      if (error) {
        settled = true;
        cleanup();
        reject(error);
        return;
      }
      if (!flushed || !drained) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onDrain = () => { drained = true; done(); };
    const onClose = () => done(new Error("the Unix socket closed during a write"));
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
    };
    socket.once("close", onClose);
    try {
      drained = socket.write(bytes, (error) => {
        flushed = true;
        done(error ?? undefined);
      });
      if (!drained) socket.once("drain", onDrain);
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
