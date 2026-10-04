import type { ByteConnection, ByteConnectionHandlers } from "../types.ts";

export interface PipeOptions {
  /** Splits each delivery into the chunks the receiver sees. Default: one chunk per delivery. */
  split?: (bytes: Uint8Array) => Uint8Array[];
  /** Merges every chunk waiting in this direction into one delivery before splitting. */
  coalesce?: boolean;
  /** Milliseconds before each delivery. Default 0, a later macrotask. */
  delayMs?: number;
  /**
   * Bytes accepted without waiting for delivery, like a socket buffer. Above it, or while paused,
   * `send` resolves only once its bytes reached the peer. Default 64 KiB.
   */
  highWaterMark?: number;
}

/** Splits a delivery into pieces of at most `size` bytes. */
export function chunksOf(size: number): (bytes: Uint8Array) => Uint8Array[] {
  return (bytes) => {
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < bytes.byteLength; at += size) pieces.push(bytes.subarray(at, at + size));
    return pieces;
  };
}

interface Outgoing {
  bytes: Uint8Array;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * One end of an in-memory ordered byte stream. `pause()` models a peer that stops reading: sends wait
 * until `resume()`. Test controls: pause/resume, destroy with an error, and observed totals.
 */
export class MemoryEnd implements ByteConnection {
  readonly label: string;
  peer!: MemoryEnd;
  /** Errors thrown by this end's handlers while receiving; protocol peers are expected never to throw. */
  readonly handlerErrors: unknown[] = [];
  private handlers: ByteConnectionHandlers | undefined;
  private readonly options: PipeOptions;
  private readonly queue: Outgoing[] = [];
  private paused = false;
  private scheduled = false;
  private ending = false;
  private finished = false;
  private delivered = 0;
  private closeCalls = 0;

  constructor(label: string, options: PipeOptions = {}) {
    this.label = label;
    this.options = options;
  }

  get closed(): boolean {
    return this.finished || this.ending;
  }

  /** Bytes this end delivered to its peer. */
  get deliveredBytes(): number {
    return this.delivered;
  }

  /** Bytes sent by this end that the peer has not received yet. */
  get queuedBytes(): number {
    return this.queue.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  }

  get closeCount(): number {
    return this.closeCalls;
  }

  attach(handlers: ByteConnectionHandlers): void {
    this.handlers = handlers;
    this.schedule();
    this.peer.schedule();
  }

  send(chunk: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`${this.label} is closed`));
    return new Promise((resolve, reject) => {
      const item: Outgoing = {
        bytes: chunk.slice(),
        settled: false,
        resolve: () => { if (!item.settled) { item.settled = true; resolve(); } },
        reject: (error) => { if (!item.settled) { item.settled = true; reject(error); } },
      };
      this.queue.push(item);
      if (!this.paused && this.queuedBytes <= (this.options.highWaterMark ?? 64 * 1024)) item.resolve();
      this.schedule();
    });
  }

  /** Orderly local close: bytes already sent are delivered, then the peer sees `onClose`. */
  close(): void {
    this.closeCalls += 1;
    if (this.closed) return;
    this.ending = true;
    if (this.queue.length === 0) this.finish();
    else this.schedule();
  }

  /** Stops delivering this end's bytes; pending `send` calls stay unresolved until `resume()`. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.schedule();
  }

  /** Abrupt failure: pending sends reject, this end reports `error` and the peer sees `onClose`. */
  destroy(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.ending = true;
    for (const item of this.queue.splice(0)) item.reject(error);
    this.call(() => this.handlers?.onError(error));
    this.peer.remoteClosed();
  }

  private remoteClosed(): void {
    if (this.finished) return;
    this.finished = true;
    this.ending = true;
    const error = new Error(`${this.peer.label} closed`);
    for (const item of this.queue.splice(0)) item.reject(error);
    this.call(() => this.handlers?.onClose());
  }

  private schedule(): void {
    if (this.scheduled || this.paused || this.queue.length === 0 || !this.peer.handlers) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.flush();
    }, this.options.delayMs ?? 0);
  }

  private flush(): void {
    if (this.paused || this.queue.length === 0) return;
    if (this.peer.finished) {
      const error = new Error(`${this.peer.label} closed`);
      for (const item of this.queue.splice(0)) item.reject(error);
      return;
    }
    const items = this.options.coalesce ? this.queue.splice(0) : this.queue.splice(0, 1);
    const bytes = concat(items.map((item) => item.bytes));
    const pieces = this.options.split ? this.options.split(bytes) : [bytes];
    for (const piece of pieces) {
      if (this.peer.finished) {
        const error = new Error(`${this.peer.label} closed during delivery`);
        for (const item of items) item.reject(error);
        return;
      }
      this.peer.call(() => this.peer.handlers?.onData(piece));
      this.delivered += piece.byteLength;
    }
    for (const item of items) item.resolve();
    if (this.queue.length > 0) this.schedule();
    else if (this.ending && !this.finished) this.finish();
  }

  private finish(): void {
    this.finished = true;
    this.peer.remoteClosed();
  }

  private call(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.handlerErrors.push(error);
    }
  }
}

export interface MemoryLink {
  readonly client: MemoryEnd;
  readonly server: MemoryEnd;
}

export function createMemoryLink(options: { clientToServer?: PipeOptions; serverToClient?: PipeOptions } = {}): MemoryLink {
  const client = new MemoryEnd("client", options.clientToServer);
  const server = new MemoryEnd("server", options.serverToClient);
  client.peer = server;
  server.peer = client;
  return { client, server };
}

/**
 * A transport factory for a client: each call creates a link, hands the server end to `accept`
 * and returns the client end. `links` records every link for test control.
 */
export function memoryConnector(
  accept: (connection: ByteConnection) => ByteConnectionHandlers,
  options: { clientToServer?: PipeOptions; serverToClient?: PipeOptions } = {},
): { transport: (handlers: ByteConnectionHandlers) => MemoryEnd; links: MemoryLink[] } {
  const links: MemoryLink[] = [];
  return {
    links,
    transport: (handlers) => {
      const link = createMemoryLink(options);
      link.server.attach(accept(link.server));
      link.client.attach(handlers);
      links.push(link);
      return link.client;
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
