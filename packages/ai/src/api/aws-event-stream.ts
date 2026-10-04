import { crc32 } from "node:zlib";

/**
 * AWS event stream frames, the `application/vnd.amazon.eventstream` body used by
 * Bedrock `ConverseStream`. Layout and header types follow the Smithy event stream
 * spec: prelude, headers, payload, and CRC-32 (ISO-HDLC, the same checksum as zlib).
 * https://smithy.io/2.0/aws/amazon-eventstream.html
 */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const HEADER_TRUE = 0;
const HEADER_FALSE = 1;
const HEADER_BYTE = 2;
const HEADER_SHORT = 3;
const HEADER_INT = 4;
const HEADER_LONG = 5;
const HEADER_BYTES = 6;
const HEADER_STRING = 7;
const HEADER_TIMESTAMP = 8;
const HEADER_UUID = 9;

export interface DecodedAwsEvent {
  headers: Record<string, string>;
  payload: Uint8Array;
}

export function encodeAwsEvent(headers: ReadonlyArray<readonly [string, string]>, payload: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const headerBytes = encodeHeaders(headers);
  const total = 12 + headerBytes.length + payload.length + 4;
  const message = new Uint8Array(total);
  const view = new DataView(message.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, checksum(message.subarray(0, 8)));
  message.set(headerBytes, 12);
  message.set(payload, 12 + headerBytes.length);
  view.setUint32(total - 4, checksum(message.subarray(0, total - 4)));
  return message;
}

/** One Bedrock event: JSON payload with the event-type header the service sends. */
export function encodeBedrockEvents(events: ReadonlyArray<{ type: string; body: unknown }>): Uint8Array<ArrayBuffer> {
  return concat(events.map((event) => encodeAwsEvent(
    [
      [":message-type", "event"],
      [":event-type", event.type],
      [":content-type", "application/json"],
    ],
    utf8(JSON.stringify(event.body)),
  )));
}

export function encodeBedrockException(exceptionType: string, message: string): Uint8Array<ArrayBuffer> {
  return encodeAwsEvent(
    [
      [":message-type", "exception"],
      [":exception-type", exceptionType],
      [":content-type", "application/json"],
    ],
    utf8(JSON.stringify({ message })),
  );
}

type DecodeStep =
  | { event: DecodedAwsEvent; rest: Uint8Array }
  | { need: number }
  | { error: string };

export function nextAwsEvent(buffer: Uint8Array): DecodeStep {
  if (buffer.length < 12) return { need: 12 };
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const total = view.getUint32(0);
  const headersLength = view.getUint32(4);
  const prelude = view.getUint32(8);
  if (total < 16 || total > MAX_MESSAGE_BYTES || headersLength > total - 16) return { error: "invalid event stream prelude" };
  if (checksum(buffer.subarray(0, 8)) !== prelude) return { error: "event stream prelude checksum mismatch" };
  if (buffer.length < total) return { need: total };
  const messageCrc = view.getUint32(total - 4);
  if (checksum(buffer.subarray(0, total - 4)) !== messageCrc) return { error: "event stream message checksum mismatch" };
  const headers = decodeHeaders(buffer.subarray(12, 12 + headersLength));
  if (typeof headers === "string") return { error: headers };
  return {
    event: { headers, payload: buffer.slice(12 + headersLength, total - 4) },
    rest: buffer.subarray(total),
  };
}

export async function readAwsEventStream(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (event: DecodedAwsEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response has no body");
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const chunk = await reader.read();
      if (signal?.aborted) throw abortError();
      if (chunk.done) break;
      buffer = concat([buffer, chunk.value]);
      while (true) {
        if (signal?.aborted) throw abortError();
        const next = nextAwsEvent(buffer);
        if ("need" in next) break;
        if ("error" in next) throw new Error(next.error);
        buffer = next.rest;
        onEvent(next.event);
      }
    }
    if (buffer.length > 0) throw new Error("truncated event stream");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

export function payloadText(payload: Uint8Array): string {
  const text = new TextDecoder().decode(payload);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {
    // The exception body is not always JSON. Keep the raw text.
  }
  return text;
}

function encodeHeaders(headers: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, value] of headers) {
    const nameBytes = utf8(name);
    const valueBytes = utf8(value);
    if (nameBytes.length > 255) throw new Error("event stream header name is too long");
    if (valueBytes.length > 65535) throw new Error("event stream header value is too long");
    const bytes = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = nameBytes.length;
    bytes.set(nameBytes, 1);
    bytes[1 + nameBytes.length] = HEADER_STRING;
    view.setUint16(2 + nameBytes.length, valueBytes.length);
    bytes.set(valueBytes, 4 + nameBytes.length);
    parts.push(bytes);
  }
  return concat(parts);
}

function decodeHeaders(bytes: Uint8Array): Record<string, string> | string {
  const headers: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset];
    if (nameLength === undefined || offset + 1 + nameLength + 1 > bytes.length) return "truncated event stream header";
    const name = new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + nameLength));
    offset += 1 + nameLength;
    const type = bytes[offset];
    if (type === undefined) return "truncated event stream header";
    offset += 1;
    const read = readHeaderValue(type, bytes, view, offset);
    if (typeof read === "string") return read;
    headers[name] = read.value;
    offset = read.offset;
  }
  return headers;
}

function readHeaderValue(
  type: number,
  bytes: Uint8Array,
  view: DataView,
  offset: number,
): { value: string; offset: number } | string {
  switch (type) {
    case HEADER_TRUE:
      return { value: "true", offset };
    case HEADER_FALSE:
      return { value: "false", offset };
    case HEADER_BYTE:
      if (offset >= bytes.length) return "truncated event stream header";
      return { value: String(view.getInt8(offset)), offset: offset + 1 };
    case HEADER_SHORT:
      if (offset + 2 > bytes.length) return "truncated event stream header";
      return { value: String(view.getInt16(offset)), offset: offset + 2 };
    case HEADER_INT:
      if (offset + 4 > bytes.length) return "truncated event stream header";
      return { value: String(view.getInt32(offset)), offset: offset + 4 };
    case HEADER_LONG:
    case HEADER_TIMESTAMP:
      if (offset + 8 > bytes.length) return "truncated event stream header";
      return { value: view.getBigInt64(offset).toString(), offset: offset + 8 };
    case HEADER_BYTES:
    case HEADER_STRING: {
      if (offset + 2 > bytes.length) return "truncated event stream header";
      const length = view.getUint16(offset);
      const start = offset + 2;
      if (start + length > bytes.length) return "truncated event stream header";
      const slice = bytes.subarray(start, start + length);
      const value = type === HEADER_STRING ? new TextDecoder().decode(slice) : bytesToString(slice);
      return { value, offset: start + length };
    }
    case HEADER_UUID:
      if (offset + 16 > bytes.length) return "truncated event stream header";
      return { value: bytesToString(bytes.subarray(offset, offset + 16)), offset: offset + 16 };
    default:
      return "unknown event stream header type";
  }
}

function bytesToString(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checksum(bytes: Uint8Array): number {
  return crc32(bytes) >>> 0;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(parts: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
