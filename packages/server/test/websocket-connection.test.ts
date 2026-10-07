import type { Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketByteConnection } from "../src/transports/websocket/connection.ts";
import { OPCODE_CLOSE, OPCODE_PING } from "../src/transports/websocket/frames.ts";

/**
 * A socket whose write fails the way a vanished peer reports it: Node throws `write EPIPE` out of
 * `socket.write` when the peer is already gone.
 */
class VanishedSocket {
	destroyed = false;
	writable = true;
	readonly #closeListeners = new Set<() => void>();
	readonly writes: number[] = [];

	once(event: string, listener: () => void): this {
		if (event === "close") this.#closeListeners.add(listener);
		return this;
	}

	off(event: string, listener: () => void): this {
		if (event === "close") this.#closeListeners.delete(listener);
		return this;
	}

	write(chunk: Uint8Array): boolean {
		this.writes.push(chunk.byteLength);
		throw new Error("write EPIPE");
	}

	end(): void {
		this.destroyed = true;
	}

	destroy(): void {
		this.destroyed = true;
	}
}

/** A masked client frame, as RFC 6455 requires from a client. */
function clientFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const mask = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
	const header = payload.byteLength < 126 ? 2 : 4;
	const frame = new Uint8Array(header + 4 + payload.byteLength);
	frame[0] = 0x80 | opcode;
	if (header === 2) frame[1] = 0x80 | payload.byteLength;
	else {
		frame[1] = 0x80 | 126;
		frame[2] = (payload.byteLength >>> 8) & 0xff;
		frame[3] = payload.byteLength & 0xff;
	}
	frame.set(mask, header);
	for (let index = 0; index < payload.byteLength; index++) {
		frame[header + 4 + index] = payload[index]! ^ mask[index % 4]!;
	}
	return frame;
}

const handler = { onData: (): void => {}, onError: (): void => {} };
const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => {
	rejections.push(reason);
};

function connectionOver(socket: VanishedSocket): WebSocketByteConnection {
	return new WebSocketByteConnection(socket as unknown as Socket, {
		maxPendingBytes: 4096,
		maxMessageBytes: 4096,
		gracefulCloseTimeoutMs: 20,
	});
}

afterEach(() => {
	rejections.length = 0;
	process.off("unhandledRejection", onRejection);
});

describe("WebSocket connection over a peer that vanished", () => {
	test("a close frame answered into a dead socket leaves no unhandled rejection", async () => {
		process.on("unhandledRejection", onRejection);
		const socket = new VanishedSocket();
		const connection = connectionOver(socket);
		connection.handleChunk(clientFrame(OPCODE_CLOSE, new Uint8Array(0)), handler);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The failed answer is the connection's own business: it takes the connection down and reports
		// nothing, instead of rejecting a promise nobody holds.
		expect(rejections).toEqual([]);
		expect(connection.closed).toBe(true);
		expect(socket.destroyed).toBe(true);
	});

	test("a ping answered into a dead socket leaves no unhandled rejection", async () => {
		process.on("unhandledRejection", onRejection);
		const socket = new VanishedSocket();
		const connection = connectionOver(socket);
		connection.handleChunk(clientFrame(OPCODE_PING, new Uint8Array([1, 2, 3])), handler);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(rejections).toEqual([]);
		expect(connection.closed).toBe(true);
		// The pong was attempted before the connection came down.
		expect(socket.writes.length).toBe(1);
	});

	test("send reports the failure to its caller and closes the connection", async () => {
		process.on("unhandledRejection", onRejection);
		const socket = new VanishedSocket();
		const connection = connectionOver(socket);
		await expect(connection.send(new Uint8Array([9]))).rejects.toThrow("write EPIPE");
		expect(rejections).toEqual([]);
		expect(connection.closed).toBe(true);
		// A later send fails against the closed connection rather than writing again.
		await expect(connection.send(new Uint8Array([9]))).rejects.toThrow(/closed/);
		expect(socket.writes.length).toBe(1);
	});
});
