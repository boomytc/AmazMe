import { Server } from "@amazme/server";
import { TestServerHost } from "@amazme/server/testing";
import { WebSocketListener } from "@amazme/server/websocket";
import { describe, expect, test } from "vitest";
import { Client } from "../src/index.ts";
import type { ByteTransportHandlers } from "../src/transport.ts";
import { createWebSocketTransportFactory, type WebSocketLike } from "../src/websocket.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

/** A scripted socket that records what the transport sent and lets the test open or fail it. */
class FakeSocket implements WebSocketLike {
	readonly sent: Uint8Array[] = [];
	closed: { code?: number } | undefined;
	binaryType = "blob";
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code?: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	send(data: ArrayBufferView): void {
		this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
	}

	close(code?: number): void {
		this.closed = { ...(code === undefined ? {} : { code }) };
	}

	open(): void {
		this.onopen?.(undefined);
	}

	deliver(data: unknown): void {
		this.onmessage?.({ data });
	}

	fail(): void {
		this.onerror?.(undefined);
	}

	finish(code: number): void {
		this.onclose?.({ code });
	}
}

describe("WebSocket client transport", () => {
	test("queues chunks until the socket opens, then sends them in order", async () => {
		const socket = new FakeSocket();
		const factory = createWebSocketTransportFactory({
			url: "ws://127.0.0.1:1/amazme",
			createSocket: () => socket,
		});
		const received: Uint8Array[] = [];
		let closes = 0;
		const handlers: ByteTransportHandlers = {
			onData: (chunk) => received.push(chunk),
			onClose: () => closes++,
			onError: (error) => {
				throw error;
			},
		};
		const transport = await factory(handlers);
		await transport.send(new Uint8Array([1]));
		await transport.send(new Uint8Array([2]));
		expect(socket.sent).toEqual([]);
		socket.open();
		expect(socket.sent.map((chunk) => chunk[0])).toEqual([1, 2]);

		socket.deliver(new Uint8Array([9]).buffer);
		expect(Array.from(received[0] ?? [])).toEqual([9]);

		transport.close();
		expect(socket.closed?.code).toBe(1000);
		expect(closes).toBe(0);
		transport.close();
		expect(closes).toBe(0);
	});

	test("reports one terminal error and rejects later sends", async () => {
		const socket = new FakeSocket();
		const factory = createWebSocketTransportFactory({
			url: "ws://127.0.0.1:1/amazme",
			createSocket: () => socket,
		});
		const errors: Error[] = [];
		let closes = 0;
		const transport = await factory({
			onData: () => {},
			onClose: () => closes++,
			onError: (error) => errors.push(error),
		});
		socket.fail();
		expect(errors).toHaveLength(1);
		await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/closed/);
		socket.finish(1006);
		expect(closes).toBe(0);
		expect(errors).toHaveLength(1);
	});

	test("reports an orderly close once", async () => {
		const socket = new FakeSocket();
		const factory = createWebSocketTransportFactory({
			url: "ws://127.0.0.1:1/amazme",
			createSocket: () => socket,
		});
		let closes = 0;
		const transport = await factory({
			onData: () => {},
			onClose: () => closes++,
			onError: () => {},
		});
		socket.finish(1000);
		expect(closes).toBe(1);
		expect(transport);
	});

	test("refuses to queue past its pending limit before the socket opens", async () => {
		const socket = new FakeSocket();
		const factory = createWebSocketTransportFactory({
			url: "ws://127.0.0.1:1/amazme",
			maxPendingBytes: 4,
			createSocket: () => socket,
		});
		const transport = await factory({ onData: () => {}, onClose: () => {}, onError: () => {} });
		await transport.send(new Uint8Array(4));
		await expect(transport.send(new Uint8Array(1))).rejects.toThrow(/pending byte limit/);
	});

	test("dials a live listener, routes a service call, and reports a refused connection", async () => {
		const listener = new WebSocketListener({ port: 0, path: "/amazme-ws-test" });
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = new Server(host, { listeners: [listener], serverId });
		await server.start();
		const address = listener.address();
		expect(address?.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/amazme-ws-test$/);

		const client = await Client.connect({
			serverId,
			transportFactory: createWebSocketTransportFactory({ url: address!.url }),
		});
		expect(client.connected).toBe(true);
		expect(client.hello).toMatchObject({ serverId });
		await client.request(
			{ serverId },
			{ serviceId: "amazme.session-management", member: "attach", args: ["session-1"] },
		);
		expect(client.attachment).toMatchObject({ sessionId: "session-1" });
		await client.dispose();
		await server.close();

		const deadUrl = `ws://127.0.0.1:${address!.port}/amazme-ws-test`;
		const errors: Error[] = [];
		await createWebSocketTransportFactory({ url: deadUrl })({
			onData: () => {},
			onClose: () => {},
			onError: (error) => errors.push(error),
		});
		for (let attempt = 0; attempt < 50 && errors.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(errors).toHaveLength(1);
		await expect(
			Client.connect({ serverId, transportFactory: createWebSocketTransportFactory({ url: deadUrl }) }),
		).rejects.toBeInstanceOf(Error);
	});
});
