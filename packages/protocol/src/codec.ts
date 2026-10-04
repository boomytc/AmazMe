import { Check } from "typebox/value";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "./envelope.ts";
import { ProtocolError, resolveLimits, type ProtocolLimits } from "./errors.ts";
import { encodeFrame, FrameDecoder } from "./framing.ts";
import { assertJsonValue } from "./json.ts";

/** Strict JSON first, so the schema check never runs accessors or sees non-data values; unknown envelope fields fail. */
export function parseClientMessage(value: unknown, limits?: Partial<ProtocolLimits>): ClientMessage {
  return parse(value, ClientMessageSchema, "client", resolveLimits(limits)) as ClientMessage;
}

export function parseServerMessage(value: unknown, limits?: Partial<ProtocolLimits>): ServerMessage {
  return parse(value, ServerMessageSchema, "server", resolveLimits(limits)) as ServerMessage;
}

/** Validates and encodes one complete length-prefixed frame. */
export function encodeClientMessage(message: ClientMessage, limits?: Partial<ProtocolLimits>): Uint8Array {
  const resolved = resolveLimits(limits);
  return encode(parse(message, ClientMessageSchema, "client", resolved), resolved);
}

export function encodeServerMessage(message: ServerMessage, limits?: Partial<ProtocolLimits>): Uint8Array {
  const resolved = resolveLimits(limits);
  return encode(parse(message, ServerMessageSchema, "server", resolved), resolved);
}

export function isSupportedVersion(version: number): version is typeof PROTOCOL_VERSION {
  return version === PROTOCOL_VERSION;
}

/** Incrementally decodes framed client messages from arbitrary chunks. The first failure is final. */
export class ClientMessageDecoder {
  private readonly decoder: MessageDecoder;
  constructor(limits?: Partial<ProtocolLimits>) {
    this.decoder = new MessageDecoder(ClientMessageSchema, "client", resolveLimits(limits));
  }
  get failed(): boolean { return this.decoder.failed; }
  push(chunk: Uint8Array): ClientMessage[] { return this.decoder.push(chunk) as ClientMessage[]; }
  end(): void { this.decoder.end(); }
}

export class ServerMessageDecoder {
  private readonly decoder: MessageDecoder;
  constructor(limits?: Partial<ProtocolLimits>) {
    this.decoder = new MessageDecoder(ServerMessageSchema, "server", resolveLimits(limits));
  }
  get failed(): boolean { return this.decoder.failed; }
  push(chunk: Uint8Array): ServerMessage[] { return this.decoder.push(chunk) as ServerMessage[]; }
  end(): void { this.decoder.end(); }
}

type Schema = typeof ClientMessageSchema | typeof ServerMessageSchema;

class MessageDecoder {
  private readonly frames: FrameDecoder;
  private readonly schema: Schema;
  private readonly kind: string;
  private readonly limits: ProtocolLimits;
  private broken = false;

  constructor(schema: Schema, kind: string, limits: ProtocolLimits) {
    this.frames = new FrameDecoder(limits.maxFrameBytes);
    this.schema = schema;
    this.kind = kind;
    this.limits = limits;
  }

  get failed(): boolean {
    return this.broken;
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.broken) throw new ProtocolError("decoder_failed", `${this.kind} message decoder has failed`);
    try {
      return this.frames.push(chunk).map((frame) => parse(decodeCbor(frame, this.limits), this.schema, this.kind, this.limits));
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }

  end(): void {
    if (this.broken) throw new ProtocolError("decoder_failed", `${this.kind} message decoder has failed`);
    try {
      this.frames.end();
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }
}

function parse(value: unknown, schema: Schema, kind: string, limits: ProtocolLimits): unknown {
  assertJsonValue(value, limits);
  if (!Check(schema, value)) throw new ProtocolError("invalid_message", `invalid ${kind} protocol message`);
  return value;
}

function encode(value: unknown, limits: ProtocolLimits): Uint8Array {
  return encodeFrame(encodeCbor(value as Parameters<typeof encodeCbor>[0], limits), limits.maxFrameBytes);
}
