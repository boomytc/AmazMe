export type ProtocolErrorCode =
  | "invalid_json"
  | "invalid_message"
  | "invalid_cbor"
  | "invalid_frame"
  | "limit_exceeded"
  | "decoder_failed";

/** A local protocol violation: invalid values, envelopes, CBOR, framing, or exceeded limits. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

const MAX_UINT32 = 0xffff_ffff;
const MAX_DEPTH = 256;

export interface ProtocolLimits {
  /** Upper bound of one CBOR payload; the four-byte length header is not counted. */
  maxFrameBytes: number;
  /** Nested container levels below the top-level value. */
  maxDepth: number;
  /** Total array elements plus map entries in one value. */
  maxItems: number;
}

export const DEFAULT_LIMITS: Readonly<ProtocolLimits> = Object.freeze({
  maxFrameBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxItems: 1_000_000,
});

export function resolveLimits(limits?: Partial<ProtocolLimits>): ProtocolLimits {
  return {
    maxFrameBytes: integer("maxFrameBytes", limits?.maxFrameBytes ?? DEFAULT_LIMITS.maxFrameBytes, 1, MAX_UINT32),
    maxDepth: integer("maxDepth", limits?.maxDepth ?? DEFAULT_LIMITS.maxDepth, 1, MAX_DEPTH),
    maxItems: integer("maxItems", limits?.maxItems ?? DEFAULT_LIMITS.maxItems, 1, MAX_UINT32),
  };
}

function integer(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
