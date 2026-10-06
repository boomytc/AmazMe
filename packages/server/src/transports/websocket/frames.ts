import { createHash } from "node:crypto";

/** RFC 6455 handshake constant: the GUID appended to `Sec-WebSocket-Key`. */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Frame opcodes this transport understands. */
export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

/** Close codes a peer can act on. */
export const CLOSE_NORMAL = 1000;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_UNSUPPORTED_DATA = 1003;
export const CLOSE_MESSAGE_TOO_BIG = 1009;

const MAX_CONTROL_PAYLOAD = 125;
const PAYLOAD_LENGTH_EXTENDED_16 = 126;
const PAYLOAD_LENGTH_EXTENDED_64 = 127;

/** One complete frame or message handed to the connection. */
export interface DecodedFrame {
	readonly opcode: number;
	readonly payload: Uint8Array;
}

/** A peer frame the server must reject, carrying the close code to answer with. */
export class WebSocketProtocolError extends Error {
	readonly closeCode: number;

	constructor(message: string, closeCode: number = CLOSE_PROTOCOL_ERROR) {
		super(message);
		this.name = "WebSocketProtocolError";
		this.closeCode = closeCode;
	}
}

/** `Sec-WebSocket-Accept` for one client `Sec-WebSocket-Key`. */
export function computeAcceptValue(key: string): string {
	return createHash("sha1").update(`${key}${HANDSHAKE_GUID}`).digest("base64");
}

/** Encode one unmasked server frame. Messages are sent whole, so `fin` is always set. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const length = payload.byteLength;
	const header = length < PAYLOAD_LENGTH_EXTENDED_16 ? 2 : length <= 0xffff ? 4 : 10;
	const frame = new Uint8Array(header + length);
	frame[0] = 0x80 | opcode;
	if (header === 2) {
		frame[1] = length;
	} else if (header === 4) {
		frame[1] = PAYLOAD_LENGTH_EXTENDED_16;
		frame[2] = (length >>> 8) & 0xff;
		frame[3] = length & 0xff;
	} else {
		frame[1] = PAYLOAD_LENGTH_EXTENDED_64;
		new DataView(frame.buffer).setBigUint64(2, BigInt(length));
	}
	frame.set(payload, header);
	return frame;
}

/** One encoded close frame with an empty reason. */
export function encodeCloseFrame(code: number): Uint8Array {
	const payload = new Uint8Array(2);
	new DataView(payload.buffer).setUint16(0, code);
	return encodeFrame(OPCODE_CLOSE, payload);
}

/**
 * Incremental RFC 6455 reader for the server side. It decodes masked client frames,
 * assembles fragmented messages, and returns whole messages or control frames.
 * Every violation is a `WebSocketProtocolError` carrying the close code to answer with.
 */
export class WebSocketFrameReader {
	private buffer: Uint8Array = new Uint8Array(0);
	private fragmentedOpcode: number | undefined;
	private fragments: Uint8Array[] = [];
	private fragmentedBytes = 0;
	private readonly maxPayloadBytes: number;

	constructor(maxPayloadBytes: number) {
		if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
			throw new TypeError("WebSocket max payload must be a positive safe integer");
		}
		this.maxPayloadBytes = maxPayloadBytes;
	}

	/** Feed one TCP chunk. Returns every message completed by it, in order. */
	push(chunk: Uint8Array): DecodedFrame[] {
		if (this.buffer.byteLength === 0) {
			this.buffer = chunk;
		} else {
			const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
			merged.set(this.buffer, 0);
			merged.set(chunk, this.buffer.byteLength);
			this.buffer = merged;
		}
		const frames: DecodedFrame[] = [];
		for (;;) {
			const frame = this.readFrame();
			if (!frame) return frames;
			frames.push(...this.acceptFrame(frame));
		}
	}

	private readFrame():
		| { readonly fin: boolean; readonly opcode: number; readonly payload: Uint8Array; readonly masked: boolean }
		| undefined {
		const buffer = this.buffer;
		if (buffer.byteLength < 2) return undefined;
		const first = buffer[0]!;
		const second = buffer[1]!;
		const fin = (first & 0x80) !== 0;
		if ((first & 0x70) !== 0) throw new WebSocketProtocolError("Reserved frame bits must be zero");
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		const shortLength = second & 0x7f;
		let offset = 2;
		let length = shortLength;
		if (shortLength === PAYLOAD_LENGTH_EXTENDED_16 || shortLength === PAYLOAD_LENGTH_EXTENDED_64) {
			const width = shortLength === PAYLOAD_LENGTH_EXTENDED_16 ? 2 : 8;
			if (buffer.byteLength < offset + width) return undefined;
			length =
				width === 2
					? new DataView(buffer.buffer, buffer.byteOffset + offset, 2).getUint16(0)
					: Number(new DataView(buffer.buffer, buffer.byteOffset + offset, 8).getBigUint64(0));
			offset += width;
		}
		if (length > this.maxPayloadBytes) {
			throw new WebSocketProtocolError("Frame payload exceeds the configured limit", CLOSE_MESSAGE_TOO_BIG);
		}
		let mask: Uint8Array | undefined;
		if (masked) {
			if (buffer.byteLength < offset + 4) return undefined;
			mask = buffer.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buffer.byteLength < offset + length) return undefined;
		let payload = buffer.subarray(offset, offset + length);
		if (mask) {
			const unmasked = new Uint8Array(length);
			for (let index = 0; index < length; index++) unmasked[index] = payload[index]! ^ mask[index % 4]!;
			payload = unmasked;
		} else {
			payload = payload.slice();
		}
		this.buffer = buffer.subarray(offset + length);
		return { fin, opcode, payload, masked };
	}

	private acceptFrame(frame: {
		readonly fin: boolean;
		readonly opcode: number;
		readonly payload: Uint8Array;
		readonly masked: boolean;
	}): DecodedFrame[] {
		if (!frame.masked) throw new WebSocketProtocolError("Client frames must be masked");
		const control = (frame.opcode & 0x8) !== 0;
		if (control) {
			if (!frame.fin) throw new WebSocketProtocolError("Control frames cannot be fragmented");
			if (frame.payload.byteLength > MAX_CONTROL_PAYLOAD) {
				throw new WebSocketProtocolError("Control frame payload exceeds 125 bytes");
			}
			switch (frame.opcode) {
				case OPCODE_CLOSE:
				case OPCODE_PING:
				case OPCODE_PONG:
					return [{ opcode: frame.opcode, payload: frame.payload }];
				default:
					throw new WebSocketProtocolError(`Unsupported control opcode ${frame.opcode}`);
			}
		}
		if (frame.opcode === OPCODE_CONTINUATION) {
			if (this.fragmentedOpcode === undefined) {
				throw new WebSocketProtocolError("Continuation frame without a fragmented message");
			}
			this.fragmentedBytes += frame.payload.byteLength;
			if (this.fragmentedBytes > this.maxPayloadBytes) {
				throw new WebSocketProtocolError("Fragmented message exceeds the configured limit", CLOSE_MESSAGE_TOO_BIG);
			}
			this.fragments.push(frame.payload);
			if (!frame.fin) return [];
			const message = new Uint8Array(this.fragmentedBytes);
			let offset = 0;
			for (const fragment of this.fragments) {
				message.set(fragment, offset);
				offset += fragment.byteLength;
			}
			const opcode = this.fragmentedOpcode;
			this.fragmentedOpcode = undefined;
			this.fragments = [];
			this.fragmentedBytes = 0;
			return [{ opcode, payload: message }];
		}
		if (frame.opcode !== OPCODE_BINARY && frame.opcode !== OPCODE_TEXT) {
			throw new WebSocketProtocolError(`Unsupported data opcode ${frame.opcode}`);
		}
		if (this.fragmentedOpcode !== undefined) {
			throw new WebSocketProtocolError("Interleaved message while a fragmented message is open");
		}
		if (frame.fin) return [{ opcode: frame.opcode, payload: frame.payload }];
		this.fragmentedOpcode = frame.opcode;
		this.fragments = [frame.payload];
		this.fragmentedBytes = frame.payload.byteLength;
		return [];
	}
}
