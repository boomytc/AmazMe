import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { encodeClientMessage, PROTOCOL_VERSION, ServerMessageDecoder, type ServerMessage } from "@amazme/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { Server } from "../src/server.ts";
import { ProtocolTestClient, TestServerHost, type WireChannel } from "../src/testing/index.ts";
import { WebSocketListener } from "../src/transports/websocket/index.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const listeners = new Set<WebSocketListener>();
const servers = new Set<Server>();
const rawSockets = new Set<Socket>();

/** The standard WebSocket surface, reached through a cast because this package has no DOM types. */
interface GlobalWebSocket {
	binaryType: string;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "open" | "close" | "error", listener: (event: unknown) => void): void;
}

function webSocketConstructor(): new (url: string) => GlobalWebSocket {
	const socket = (globalThis as { WebSocket?: new (url: string) => GlobalWebSocket }).WebSocket;
	if (!socket) throw new Error("This runtime has no global WebSocket");
	return socket;
}

async function startListener(): Promise<{ listener: WebSocketListener; url: string; server: Server }> {
	const listener = new WebSocketListener({ port: 0, path: "/amazme-test" });
	listeners.add(listener);
	const host = new TestServerHost();
	await host.seed("session-1");
	const server = new Server(host, { listeners: [listener], serverId });
	servers.add(server);
	await server.start();
	const address = listener.address();
	if (!address) throw new Error("Listener did not bind");
	return { listener, url: address.url, server };
}

function channelFor(socket: GlobalWebSocket): WireChannel {
	return {
		send: (chunk) => {
			socket.send(chunk);
			return Promise.resolve();
		},
		async sendFragmented(chunk, splitAt) {
			socket.send(chunk.subarray(0, splitAt));
			socket.send(chunk.subarray(splitAt));
		},
		async close() {
			socket.close(1000);
		},
	};
}

async function connectClient(url: string): Promise<ProtocolTestClient> {
	const SocketConstructor = webSocketConstructor();
	const socket = new SocketConstructor(url);
	socket.binaryType = "arraybuffer";
	const client = new ProtocolTestClient(channelFor(socket));
	socket.addEventListener("message", (event) => {
		const data = event.data;
		if (data instanceof ArrayBuffer) client.receive(new Uint8Array(data));
		else if (ArrayBuffer.isView(data)) client.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		else client.fail(new Error("Unexpected text frame"));
	});
	socket.addEventListener("close", () => client.markClosed());
	socket.addEventListener("error", () => client.fail(new Error("WebSocket failed")));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", reject);
	});
	return client;
}

/** A masked client frame, as RFC 6455 requires from a client. */
function clientFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
	const mask = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
	const header = payload.byteLength < 126 ? 2 : 4;
	const frame = new Uint8Array(header + 4 + payload.byteLength);
	frame[0] = (fin ? 0x80 : 0x00) | opcode;
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

interface RawUpgrade {
	readonly socket: Socket;
	/** Everything the server sent, from the handshake response onward. */
	bytes(): Buffer;
	text(): string;
	waitForClose(): Promise<void>;
}

async function upgrade(path: string, url: string): Promise<RawUpgrade> {
	const address = new URL(url);
	const socket = createConnection({ host: address.hostname, port: Number(address.port) });
	rawSockets.add(socket);
	const chunks: Buffer[] = [];
	socket.on("data", (chunk: Buffer) => chunks.push(chunk));
	await once(socket, "connect");
	socket.write(
		`GET ${path} HTTP/1.1\r\n` +
			`host: ${address.host}\r\n` +
			"upgrade: websocket\r\n" +
			"connection: Upgrade\r\n" +
			"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
			"sec-websocket-version: 13\r\n" +
			"\r\n",
	);
	await new Promise<void>((resolve) => {
		const check = (): void => {
			if (chunks.length > 0) resolve();
		};
		socket.on("data", check);
		check();
	});
	return {
		socket,
		bytes: () => Buffer.concat(chunks),
		text: () => Buffer.concat(chunks).toString("utf8"),
		waitForClose: async () => {
			if (!socket.closed) await once(socket, "close");
		},
	};
}

/** Decode the protocol messages the server sent, skipping the handshake response and frame headers. */
function serverMessages(bytes: Buffer): ServerMessage[] {
	const separator = bytes.indexOf("\r\n\r\n");
	let cursor = separator + 4;
	const decoder = new ServerMessageDecoder();
	const messages: ServerMessage[] = [];
	while (cursor + 2 <= bytes.byteLength) {
		expect(bytes[cursor]! & 0x0f).toBe(0x2);
		let length = bytes[cursor + 1]! & 0x7f;
		cursor += 2;
		if (length === 126) {
			length = bytes.readUInt16BE(cursor);
			cursor += 2;
		}
		if (cursor + length > bytes.byteLength) break;
		messages.push(...decoder.push(new Uint8Array(bytes.subarray(cursor, cursor + length))));
		cursor += length;
	}
	return messages;
}

/** A close frame the server sent, matched on its leading opcode byte. */
function closeFrameFrom(bytes: Buffer): { code: number } | undefined {
	const index = bytes.indexOf(0x88);
	if (index === -1 || bytes.byteLength < index + 4) return undefined;
	return { code: bytes.readUInt16BE(index + 2) };
}

afterEach(async () => {
	for (const socket of rawSockets) socket.destroy();
	rawSockets.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...listeners].map((listener) => listener.close()));
	listeners.clear();
});

describe("WebSocket transport", () => {
	test("answers the RFC 6455 handshake on its path and carries a routed protocol call", async () => {
		const { url, server } = await startListener();
		expect(url.startsWith("ws://127.0.0.1:")).toBe(true);
		const client = await connectClient(url);

		expect(await client.hello()).toMatchObject({ type: "hello", serverId });
		const attachment = client.next((message) => message.type === "attachment");
		expect(await client.attach(serverId, "session-1")).toMatchObject({ type: "response", ok: true });
		expect(await attachment).toMatchObject({ type: "attachment", attachment: { sessionId: "session-1" } });

		await client.close();
		await server.close();
	});

	test("delivers one protocol message split across two WebSocket messages", async () => {
		const { url, server } = await startListener();
		const client = await connectClient(url);
		const response = client.next((message) => message.type === "hello" || message.type === "hello_error");
		await client.sendFragmentedMessage({ type: "hello", version: PROTOCOL_VERSION }, 3);
		expect(await response).toMatchObject({ type: "hello" });
		await client.close();
		await server.close();
	});

	test("reassembles a client message sent as three WebSocket frames", async () => {
		const { url, server } = await startListener();
		const raw = await upgrade("/amazme-test", url);
		const hello = Buffer.from(encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION }));
		raw.socket.write(Buffer.from(clientFrame(0x2, hello.subarray(0, 2), false)));
		raw.socket.write(Buffer.from(clientFrame(0x0, hello.subarray(2, 5), false)));
		raw.socket.write(Buffer.from(clientFrame(0x0, hello.subarray(5), true)));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(serverMessages(raw.bytes()).some((message) => message.type === "hello")).toBe(true);
		await server.close();
	});

	test("answers a ping with a pong", async () => {
		const { url, server } = await startListener();
		const raw = await upgrade("/amazme-test", url);
		raw.socket.write(Buffer.from(clientFrame(0x9, new Uint8Array([1, 2, 3]))));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(raw.bytes().indexOf(Buffer.from([0x8a, 0x03, 0x01, 0x02, 0x03]))).toBeGreaterThan(-1);
		await server.close();
	});

	test("binds loopback only, so a non-loopback address of this machine refuses the connection", async () => {
		const { listener, server } = await startListener();
		const port = listener.address()?.port;
		const external = Object.values(networkInterfaces())
			.flat()
			.find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
		expect(port).toBeGreaterThan(0);
		if (!external) {
			await server.close();
			return;
		}
		const socket = createConnection({ host: external.address, port: port! });
		rawSockets.add(socket);
		const error = await new Promise<Error | undefined>((resolve) => {
			socket.once("error", (failure) => resolve(failure));
			socket.once("connect", () => resolve(undefined));
		});
		expect(error).toBeInstanceOf(Error);
		socket.destroy();
		await server.close();
	});

	test("attaches to a caller's HTTP server without taking over its requests", async () => {
		const server = createHttpServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			response.end("page bodies stay with the caller\n");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const bound = server.address();
		if (bound === null || typeof bound === "string") throw new Error("HTTP server did not bind");
		const listener = new WebSocketListener({ server, path: "/amazme-attached" });
		listeners.add(listener);
		const routing = new Server(new TestServerHost(), { listeners: [listener], serverId });
		servers.add(routing);
		await routing.start();
		expect(listener.address()).toMatchObject({ port: bound.port });
		expect(listener.httpServer).toBe(server);

		const client = await connectClient(`ws://127.0.0.1:${bound.port}/amazme-attached`);
		expect(await client.hello()).toMatchObject({ type: "hello", serverId });

		const page = await fetch(`http://127.0.0.1:${bound.port}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("page bodies stay with the caller");

		await client.close();
		await routing.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test("rejects a wrong path and a plain HTTP request without upgrading", async () => {
		const { url, server } = await startListener();
		const wrongPath = await upgrade("/other", url);
		expect(wrongPath.text()).toContain("404 Not Found");

		const address = new URL(url);
		const plain = createConnection({ host: address.hostname, port: Number(address.port) });
		rawSockets.add(plain);
		const chunks: Buffer[] = [];
		plain.on("data", (chunk: Buffer) => chunks.push(chunk));
		await once(plain, "connect");
		plain.write(`GET /amazme-test HTTP/1.1\r\nhost: ${address.host}\r\nconnection: close\r\n\r\n`);
		await once(plain, "close");
		expect(Buffer.concat(chunks).toString("utf8")).toContain("404 Not Found");
		await server.close();
	});

	test("closes a peer that sends an unmasked frame or a text frame", async () => {
		const { url, server } = await startListener();
		const unmasked = await upgrade("/amazme-test", url);
		unmasked.socket.write(Buffer.from([0x82, 0x02, 0x01, 0x02]));
		await unmasked.waitForClose();
		expect(closeFrameFrom(unmasked.bytes())?.code).toBe(1002);

		const text = await upgrade("/amazme-test", url);
		text.socket.write(Buffer.from(clientFrame(0x1, new TextEncoder().encode("hello"))));
		await text.waitForClose();
		expect(closeFrameFrom(text.bytes())?.code).toBe(1003);
		await server.close();
	});
});
