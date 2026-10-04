// Portions adapted from Pi packages/protocol/src/framing.ts, Copyright (c) 2025 Mario Zechner, MIT License. See NOTICE.
import { ProtocolError, resolveLimits } from "./errors.ts";

export const FRAME_HEADER_BYTES = 4;
const INITIAL_CAPACITY = 4096;
const EMPTY = new Uint8Array(0);

/** Prefixes a non-empty payload with its unsigned 32-bit big-endian length. */
export function encodeFrame(payload: Uint8Array, maxFrameBytes: number): Uint8Array {
  maxFrameBytes = resolveLimits({ maxFrameBytes }).maxFrameBytes;
  if (payload.byteLength === 0) throw new ProtocolError("invalid_frame", "frame payload is empty");
  if (payload.byteLength > maxFrameBytes) throw new ProtocolError("limit_exceeded", `frame payload exceeds ${maxFrameBytes} bytes`);
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Splits an ordered byte stream into payloads. Memory grows with bytes actually received, never with a
 * declared length; a header above the limit fails as soon as its four bytes arrive. Any failure is final.
 */
export class FrameDecoder {
  private readonly maxFrameBytes: number;
  private readonly header = new Uint8Array(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private expected: number | undefined;
  private payload = EMPTY;
  private received = 0;
  private state: "open" | "ended" | "failed" = "open";

  constructor(maxFrameBytes: number) {
    this.maxFrameBytes = resolveLimits({ maxFrameBytes }).maxFrameBytes;
  }

  get failed(): boolean {
    return this.state === "failed";
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.assertOpen();
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.expected === undefined) {
        const take = Math.min(FRAME_HEADER_BYTES - this.headerBytes, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + take), this.headerBytes);
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < FRAME_HEADER_BYTES) break;
        const length = new DataView(this.header.buffer).getUint32(0);
        this.headerBytes = 0;
        if (length === 0) this.fail("invalid_frame", "frame payload is empty");
        if (length > this.maxFrameBytes) this.fail("limit_exceeded", `frame length ${length} exceeds ${this.maxFrameBytes} bytes`);
        this.expected = length;
      }
      const take = Math.min(this.expected - this.received, chunk.byteLength - offset);
      this.reserve(this.received + take, this.expected);
      this.payload.set(chunk.subarray(offset, offset + take), this.received);
      this.received += take;
      offset += take;
      if (this.received === this.expected) frames.push(this.complete());
    }
    return frames;
  }

  /** Marks the end of the stream; a partial header or payload fails as truncated. */
  end(): void {
    this.assertOpen();
    if (this.headerBytes > 0 || this.expected !== undefined) this.fail("invalid_frame", "stream ended inside a frame");
    this.state = "ended";
  }

  private reserve(required: number, expected: number): void {
    if (required <= this.payload.byteLength) return;
    let capacity = Math.max(this.payload.byteLength * 2, INITIAL_CAPACITY);
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(Math.min(capacity, expected));
    grown.set(this.payload.subarray(0, this.received));
    this.payload = grown;
  }

  private complete(): Uint8Array {
    const payload = this.payload.byteLength === this.received ? this.payload : this.payload.slice(0, this.received);
    this.payload = EMPTY;
    this.received = 0;
    this.expected = undefined;
    return payload;
  }

  private assertOpen(): void {
    if (this.state === "failed") throw new ProtocolError("decoder_failed", "frame decoder has failed");
    if (this.state === "ended") throw new ProtocolError("decoder_failed", "frame decoder has ended");
  }

  private fail(code: "invalid_frame" | "limit_exceeded", message: string): never {
    this.state = "failed";
    this.payload = EMPTY;
    this.received = 0;
    this.expected = undefined;
    this.headerBytes = 0;
    throw new ProtocolError(code, message);
  }
}
