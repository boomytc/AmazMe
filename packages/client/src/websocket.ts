import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * The WebSocket surface both browsers and Node's global `WebSocket` implement.
 * Event properties are used instead of `addEventListener` so the transport needs
 * no DOM types and no event-target shim.
 */
export interface WebSocketLike {
	binaryType: string;
	send(data: ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

export interface WebSocketTransportOptions {
	/** `ws://` or `wss://` URL whose path the server upgrades. */
	url: string;
	/** Maximum bytes queued before the socket opens. Defaults to 4 MiB. */
	maxPendingBytes?: number;
	/** Socket constructor. Defaults to the global WebSocket (browsers, Node 22+). */
	createSocket?: (url: string) => WebSocketLike;
}

/** The default constructor: the global WebSocket every modern runtime provides. */
export function defaultWebSocketFactory(url: string): WebSocketLike {
	const socket = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
	if (!socket) {
		throw new Error("No global WebSocket in this runtime; pass createSocket to the transport options");
	}
	return new socket(url);
}

function toBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	}
	throw new TypeError("WebSocket transport received a non-binary message");
}

/** One ordered byte transport over a WebSocket: binary messages carry protocol chunks. */
class WebSocketTransport implements ByteTransport {
	private readonly socket: WebSocketLike;
	private readonly maxPendingBytes: number;
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private opened = false;
	private settled = false;

	constructor(socket: WebSocketLike, handlers: ByteTransportHandlers, maxPendingBytes: number) {
		this.socket = socket;
		this.maxPendingBytes = maxPendingBytes;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			this.opened = true;
			const queued = this.pending;
			this.pending = [];
			this.pendingBytes = 0;
			for (const chunk of queued) this.socket.send(chunk);
		};
		socket.onmessage = (event) => {
			if (this.settled) return;
			let bytes: Uint8Array;
			try {
				bytes = toBytes(event.data);
			} catch (error) {
				this.fail(handlers, error instanceof Error ? error : new Error(String(error)));
				return;
			}
			handlers.onData(bytes);
		};
		socket.onerror = () => {
			this.fail(handlers, new Error("WebSocket transport failed"));
		};
		socket.onclose = (event) => {
			if (this.settled) return;
			this.settled = true;
			if (event.code === 1000 || event.code === undefined) handlers.onClose();
			else handlers.onError(new Error(`WebSocket closed with code ${event.code}`));
		};
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket transport chunks must be Uint8Array"));
		}
		if (this.settled) return Promise.reject(new Error("WebSocket transport is closed"));
		if (this.opened) {
			this.socket.send(chunk);
			return Promise.resolve();
		}
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("WebSocket transport exceeded its pending byte limit"));
		}
		const bytes = chunk.slice();
		this.pending.push(bytes);
		this.pendingBytes += bytes.byteLength;
		return Promise.resolve();
	}

	close(): void {
		if (this.settled) return;
		this.settled = true;
		this.pending = [];
		this.pendingBytes = 0;
		try {
			this.socket.close(1000);
		} catch {
			// A socket that already failed needs no close frame.
		}
	}

	private fail(handlers: ByteTransportHandlers, error: Error): void {
		if (this.settled) return;
		this.settled = true;
		this.pending = [];
		this.pendingBytes = 0;
		handlers.onError(error);
		try {
			this.socket.close();
		} catch {
			// Nothing left to close.
		}
	}
}

/** Create a byte transport factory that dials one WebSocket URL. */
export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	const url = options.url;
	if (typeof url !== "string" || !/^wss?:\/\//.test(url)) {
		throw new TypeError("WebSocket transport url must be a ws:// or wss:// URL");
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("WebSocket transport maxPendingBytes must be a positive safe integer");
	}
	const createSocket = options.createSocket ?? defaultWebSocketFactory;
	return (handlers) => new WebSocketTransport(createSocket(url), handlers, maxPendingBytes);
}
