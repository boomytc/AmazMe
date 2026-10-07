import type { Socket } from "node:net";
import type { ByteConnection } from "../../connection.ts";
import {
	CLOSE_NORMAL,
	CLOSE_PROTOCOL_ERROR,
	CLOSE_UNSUPPORTED_DATA,
	encodeCloseFrame,
	encodeFrame,
	OPCODE_BINARY,
	OPCODE_CLOSE,
	OPCODE_PING,
	OPCODE_PONG,
	WebSocketFrameReader,
	WebSocketProtocolError,
} from "./frames.ts";


interface WebSocketConnectionOptions {
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes: number;
	/** Maximum decoded message size accepted from the peer. */
	maxMessageBytes: number;
	gracefulCloseTimeoutMs: number;
}

/**
 * One upgraded loopback socket carrying WebSocket binary messages. Outbound chunks
 * become binary frames; inbound binary messages become chunks, so the protocol keeps
 * its own byte framing and this transport adds none.
 */
export class WebSocketByteConnection implements ByteConnection {
	private readonly socket: Socket;
	private readonly options: WebSocketConnectionOptions;
	private readonly reader: WebSocketFrameReader;
	private pendingBytes = 0;
	private closedValue = false;
	private closing = false;
	private writeTail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private resolveClose?: () => void;

	constructor(socket: Socket, options: WebSocketConnectionOptions) {
		this.socket = socket;
		this.options = options;
		this.reader = new WebSocketFrameReader(options.maxMessageBytes);
	}

	get closed(): boolean {
		return this.closedValue;
	}

	/** Feed one TCP chunk. `handler` receives the chunks the peer sent. */
	handleChunk(chunk: Uint8Array, handler: { onData(chunk: Uint8Array): void; onError(error: Error): void }): void {
		let frames;
		try {
			frames = this.reader.push(chunk);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			const code = error instanceof WebSocketProtocolError ? error.closeCode : CLOSE_PROTOCOL_ERROR;
			void this.closeWithCode(code);
			handler.onError(failure);
			return;
		}
		for (const frame of frames) {
			switch (frame.opcode) {
				case OPCODE_BINARY:
					try {
						handler.onData(frame.payload);
					} catch (error) {
						handler.onError(error instanceof Error ? error : new Error(String(error)));
					}
					break;
				case OPCODE_PING:
					// A peer that vanished cannot take the answer; the write failure closes the connection.
					void this.writeFrame(OPCODE_PONG, frame.payload).catch(() => {});
					break;
				case OPCODE_PONG:
					break;
				case OPCODE_CLOSE:
					void this.finishClose().catch(() => {});
					break;
				default:
					void this.closeWithCode(CLOSE_UNSUPPORTED_DATA);
					handler.onError(new Error("WebSocket transport accepts binary messages only"));
					return;
			}
		}
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) return Promise.reject(new Error("WebSocket connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.options.maxPendingBytes) {
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		}
		return this.writeFrame(OPCODE_BINARY, chunk);
	}

	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.closedValue || this.socket.destroyed) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		const finalBytes = finalChunk?.slice();
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			const timer = setTimeout(() => {
				if (!this.socket.destroyed) this.socket.destroy();
				this.markClosed();
			}, this.options.gracefulCloseTimeoutMs);
			timer.unref();
			this.socket.once("close", () => clearTimeout(timer));
			void this.writeTail.then(() => {
				if (this.socket.destroyed) {
					this.markClosed();
					return;
				}
				try {
					const payloads: Uint8Array[] = [];
					if (finalBytes) payloads.push(encodeFrame(OPCODE_BINARY, finalBytes));
					payloads.push(encodeCloseFrame(CLOSE_NORMAL));
					this.socket.end(Buffer.concat(payloads.map((payload) => Buffer.from(payload))));
				} catch {
					this.socket.destroy();
				}
			});
		});
		return this.closePromise;
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.resolveClose?.();
		this.resolveClose = undefined;
	}

	/**
	 * Answer the peer's close frame and stop writing. The answer is best-effort: a peer that closed
	 * the socket first, or that goes away while the frame is written, has nothing to receive.
	 */
	private async finishClose(): Promise<void> {
		if (!this.closing) {
			await this.writeFrame(OPCODE_CLOSE, new Uint8Array(0)).catch(() => {});
		}
		this.closing = true;
		if (!this.socket.destroyed) this.socket.end();
	}

	private closeWithCode(code: number): Promise<void> {
		if (this.closedValue || this.socket.destroyed) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			const timer = setTimeout(() => {
				if (!this.socket.destroyed) this.socket.destroy();
				this.markClosed();
			}, this.options.gracefulCloseTimeoutMs);
			timer.unref();
			this.socket.once("close", () => clearTimeout(timer));
			void this.writeTail.then(() => {
				if (this.socket.destroyed) {
					this.markClosed();
					return;
				}
				try {
					this.socket.end(Buffer.from(encodeCloseFrame(code)));
				} catch {
					this.socket.destroy();
				}
			});
		});
		return this.closePromise;
	}

	private writeFrame(opcode: number, payload: Uint8Array): Promise<void> {
		if (this.closedValue || this.socket.destroyed || !this.socket.writable) {
			return Promise.reject(new Error("WebSocket connection is closed"));
		}
		const bytes = payload.slice();
		this.pendingBytes += bytes.byteLength;
		const write = this.writeTail.then(() => this.write(encodeFrame(opcode, bytes)));
		const tracked = write.finally(() => {
			this.pendingBytes -= bytes.byteLength;
		});
		this.writeTail = tracked.catch(() => {});
		return tracked;
	}

	private write(frame: Uint8Array): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onClose = (): void => finish(new Error("WebSocket connection closed during write"));
			const finish = (error?: Error | null): void => {
				if (settled) return;
				settled = true;
				this.socket.off("close", onClose);
				if (error) {
					// A write that failed means the peer is gone: take the connection down here, so later
					// writes fail against a closed connection instead of each one repeating the error.
					this.markClosed();
					if (!this.socket.destroyed) this.socket.destroy();
					reject(error);
				} else resolve();
			};
			this.socket.once("close", onClose);
			try {
				this.socket.write(frame, finish);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

