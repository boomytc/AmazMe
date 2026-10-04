// Portions adapted from Pi packages/protocol/src/cbor/, Copyright (c) 2025 Mario Zechner, MIT License. See NOTICE.
import { ProtocolError, resolveLimits, type ProtocolLimits } from "./errors.ts";
import { assertJsonValue, type JsonObject, type JsonValue } from "./json.ts";

const UINT32_BASE = 0x1_0000_0000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Validates and encodes strict JSON as one definite-length RFC 8949 item: null, booleans, safe integers,
 * float64, text strings, arrays, and text-keyed maps. The output never exceeds `maxFrameBytes`.
 */
export function encodeCbor(value: JsonValue, limits: ProtocolLimits): Uint8Array {
  const resolved = resolveLimits(limits);
  assertJsonValue(value, resolved);
  const writer = new Writer(resolved.maxFrameBytes);
  writeValue(writer, value);
  return writer.finish();
}

/** Decodes exactly one item of the same subset. Tags, byte strings, indefinite lengths and other simple values fail. */
export function decodeCbor(bytes: Uint8Array, limits: ProtocolLimits): JsonValue {
  const resolved = resolveLimits(limits);
  if (bytes.byteLength > resolved.maxFrameBytes) throw limit(`CBOR payload exceeds ${resolved.maxFrameBytes} bytes`);
  const reader = new Reader(bytes, resolved);
  const value = reader.item(0);
  if (!reader.done()) throw invalid("CBOR payload has trailing bytes");
  return value;
}

class Writer {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
    this.buffer = new Uint8Array(Math.min(256, max));
    this.view = new DataView(this.buffer.buffer);
  }

  head(major: number, argument: number): void {
    const prefix = major << 5;
    if (argument < 24) this.byte(prefix | argument);
    else if (argument <= 0xff) { this.byte(prefix | 24); this.byte(argument); }
    else if (argument <= 0xffff) { this.reserve(3); this.buffer[this.offset] = prefix | 25; this.view.setUint16(this.offset + 1, argument); this.offset += 3; }
    else if (argument < UINT32_BASE) { this.reserve(5); this.buffer[this.offset] = prefix | 26; this.view.setUint32(this.offset + 1, argument); this.offset += 5; }
    else {
      this.reserve(9);
      this.buffer[this.offset] = prefix | 27;
      this.view.setUint32(this.offset + 1, Math.floor(argument / UINT32_BASE));
      this.view.setUint32(this.offset + 5, argument % UINT32_BASE);
      this.offset += 9;
    }
  }

  float(value: number): void {
    this.reserve(9);
    this.buffer[this.offset] = 0xfb;
    this.view.setFloat64(this.offset + 1, value);
    this.offset += 9;
  }

  byte(value: number): void {
    this.reserve(1);
    this.buffer[this.offset++] = value;
  }

  bytes(value: Uint8Array): void {
    this.reserve(value.byteLength);
    this.buffer.set(value, this.offset);
    this.offset += value.byteLength;
  }

  text(value: string): void {
    // Count first, stopping at the remaining frame budget before allocating the UTF-8 buffer.
    const available = this.max - this.offset - 1;
    let length = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 0x80) length += 1;
      else if (code < 0x800) length += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { length += 4; index += 1; }
      else length += 3;
      if (length > available) throw limit(`CBOR payload exceeds ${this.max} bytes`);
    }
    this.head(3, length);
    this.reserve(length);
    this.bytes(encoder.encode(value));
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }

  private reserve(count: number): void {
    const required = this.offset + count;
    if (required > this.max) throw limit(`CBOR payload exceeds ${this.max} bytes`);
    if (required <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(Math.min(capacity, this.max));
    grown.set(this.buffer.subarray(0, this.offset));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }
}

function writeValue(writer: Writer, value: JsonValue): void {
  if (value === null) return writer.byte(0xf6);
  if (value === true) return writer.byte(0xf5);
  if (value === false) return writer.byte(0xf4);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
      if (value >= 0) writer.head(0, value);
      else writer.head(1, -1 - value);
    } else {
      writer.float(value);
    }
    return;
  }
  if (typeof value === "string") return writer.text(value);
  if (Array.isArray(value)) {
    writer.head(4, value.length);
    for (const item of value) writeValue(writer, item);
    return;
  }
  const keys = Object.keys(value);
  writer.head(5, keys.length);
  for (const key of keys) {
    writer.text(key);
    writeValue(writer, (value as JsonObject)[key]!);
  }
}

class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly limits: ProtocolLimits;
  private offset = 0;
  private items = 0;

  constructor(bytes: Uint8Array, limits: ProtocolLimits) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.limits = limits;
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  item(depth: number): JsonValue {
    const initial = this.byte();
    const major = initial >>> 5;
    const info = initial & 0x1f;
    if (major === 7) return this.simple(info);
    if (major === 6) throw invalid("CBOR tags are not supported");
    if (info === 31) throw invalid("indefinite-length CBOR items are not supported");
    const argument = this.argument(info);
    if (major === 0) return safe(argument);
    if (major === 1) return safe(-1 - argument);
    if (major === 2) throw invalid("CBOR byte strings are not JSON");
    if (major === 3) return this.text(argument);
    if ((major === 4 ? argument : argument * 2) > this.remaining()) throw invalid("truncated CBOR payload");
    if (depth >= this.limits.maxDepth) throw limit(`nesting exceeds ${this.limits.maxDepth} levels`);
    this.count(argument);
    if (major === 4) {
      const result: JsonValue[] = [];
      for (let index = 0; index < argument; index++) result.push(this.item(depth + 1));
      return result;
    }
    const result: JsonObject = {};
    for (let index = 0; index < argument; index++) {
      const head = this.byte();
      if (head >>> 5 !== 3 || (head & 0x1f) === 31) throw invalid("CBOR map keys must be definite text strings");
      const key = this.text(this.argument(head & 0x1f));
      if (Object.hasOwn(result, key)) throw invalid("CBOR map has a duplicate key");
      Object.defineProperty(result, key, { value: this.item(depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }

  private simple(info: number): JsonValue {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 27) {
      const value = this.view.getFloat64(this.take(8));
      if (!Number.isFinite(value)) throw invalid("CBOR float is not finite");
      return value;
    }
    throw invalid("unsupported CBOR simple value or float width");
  }

  private text(length: number): string {
    if (length > this.remaining()) throw invalid("truncated CBOR payload");
    const start = this.take(length);
    try {
      return decoder.decode(this.bytes.subarray(start, start + length));
    } catch {
      throw invalid("CBOR text is not valid UTF-8");
    }
  }

  private argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return this.view.getUint16(this.take(2));
    if (info === 26) return this.view.getUint32(this.take(4));
    if (info === 27) {
      const at = this.take(8);
      const high = this.view.getUint32(at);
      if (high > 0x1f_ffff) throw invalid("CBOR integer or length exceeds the safe range");
      return high * UINT32_BASE + this.view.getUint32(at + 4);
    }
    throw invalid("malformed CBOR additional information");
  }

  private count(items: number): void {
    this.items += items;
    if (this.items > this.limits.maxItems) throw limit(`value exceeds ${this.limits.maxItems} items`);
  }

  private remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  private byte(): number {
    return this.bytes[this.take(1)]!;
  }

  private take(count: number): number {
    if (count > this.remaining()) throw invalid("truncated CBOR payload");
    const at = this.offset;
    this.offset += count;
    return at;
  }
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw invalid("CBOR integer exceeds the safe range");
  return value;
}

function invalid(message: string): ProtocolError {
  return new ProtocolError("invalid_cbor", message);
}

function limit(message: string): ProtocolError {
  return new ProtocolError("limit_exceeded", message);
}
