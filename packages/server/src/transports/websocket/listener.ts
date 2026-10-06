import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { DEFAULT_MAX_FRAME_LENGTH } from "@amazme/protocol";
import type { ByteConnectionAcceptor } from "../../connection.ts";
import type { ServerListener } from "../../listener.ts";
import { computeAcceptValue } from "./frames.ts";
import type { WebSocketListenerOptions } from "./types.ts";
import { WebSocketByteConnection } from "./connection.ts";

const DEFAULT_PATH = "/amazme";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface ResolvedWebSocketListenerOptions {
	host: string;
	port: number;
	path: string;
	server?: HttpServer;
	maxPendingBytes: number;
	maxMessageBytes: number;
	gracefulCloseTimeoutMs: number;
	loopbackOnly: boolean;
	onError?: (error: Error) => void;
}

function resolveOptions(options: WebSocketListenerOptions): ResolvedWebSocketListenerOptions {
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`WebSocket maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxMessageBytes = options.maxMessageBytes ?? maxFrameLength;
	if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
		throw new TypeError("WebSocket maxMessageBytes must be a positive safe integer");
	}
	const port = options.port ?? 0;
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError("WebSocket port must be an integer between 0 and 65535");
	}
	const path = options.path ?? DEFAULT_PATH;
	if (!path.startsWith("/")) throw new TypeError("WebSocket path must start with /");
	const host = options.host ?? DEFAULT_HOST;
	return {
		host,
		port,
		path,
		...(options.server ? { server: options.server } : {}),
		maxPendingBytes: options.maxPendingBytes ?? resolveDefaultPendingBytes(maxFrameLength),
		maxMessageBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
		loopbackOnly: options.loopbackOnly ?? true,
		...(options.onError ? { onError: options.onError } : {}),
	};
}

function resolveDefaultPendingBytes(maxFrameLength: number): number {
	// Four frames in flight: one being written plus room for a slow loopback peer.
	return Math.max(maxFrameLength, maxFrameLength * 4);
}

/**
 * RFC 6455 listener for the AmazMe byte protocol. It either binds a loopback HTTP
 * server of its own or attaches to one the caller already serves, so the same port
 * can carry the web client's assets and this upgrade.
 */
export class WebSocketListener implements ServerListener {
	private readonly options: ResolvedWebSocketListenerOptions;
	private readonly connections = new Set<WebSocketByteConnection>();
	private server?: HttpServer;
	private ownsServer = false;
	private accept?: ByteConnectionAcceptor;
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(options: WebSocketListenerOptions = {}) {
		this.options = resolveOptions(options);
	}

	/** The bound HTTP server, once started. */
	get httpServer(): HttpServer | undefined {
		return this.server;
	}

	/** The canonical loopback URL of the WebSocket endpoint, once started. */
	address(): { host: string; port: number; url: string } | undefined {
		const server = this.server;
		if (!server || !server.listening) return undefined;
		const bound = server.address();
		if (bound === null || typeof bound === "string") return undefined;
		const host = LOOPBACK_ADDRESSES.has(bound.address) ? bound.address : this.options.host;
		return { host, port: bound.port, url: `ws://${formatHost(host)}:${bound.port}${this.options.path}` };
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("WebSocket listener is already started");
		if (this.closing) throw new Error("WebSocket listener is closing or closed");
		this.accept = accept;

		if (this.options.server) {
			this.server = this.options.server;
			this.ownsServer = false;
		} else {
			const server = createServer((_request, response) => {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				response.end("Not found\n");
			});
			this.server = server;
			this.ownsServer = true;
			server.on("error", (error) => this.reportError(error));
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(this.options.port, this.options.host);
			});
		}
		this.server.on("upgrade", this.onUpgrade);
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private readonly onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
		if (this.closing) {
			rejectUpgrade(socket, 503, "Service Unavailable");
			return;
		}
		if (this.options.loopbackOnly && !isLoopbackRemote(socket.remoteAddress)) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		const path = request.url ?? "";
		const query = path.indexOf("?");
		if ((query === -1 ? path : path.slice(0, query)) !== this.options.path) {
			rejectUpgrade(socket, 404, "Not Found");
			return;
		}
		if ((request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
			rejectUpgrade(socket, 400, "Bad Request");
			return;
		}
		if (request.headers["sec-websocket-version"] !== "13") {
			rejectUpgrade(socket, 426, "Upgrade Required", { "sec-websocket-version": "13" });
			return;
		}
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string" || key.length === 0) {
			rejectUpgrade(socket, 400, "Bad Request");
			return;
		}
		const accept = this.accept;
		if (!accept) {
			rejectUpgrade(socket, 503, "Service Unavailable");
			return;
		}
		socket.setNoDelay(true);
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"upgrade: websocket\r\n" +
				"connection: Upgrade\r\n" +
				`sec-websocket-accept: ${computeAcceptValue(key)}\r\n` +
				"\r\n",
		);
		const connection = new WebSocketByteConnection(socket, {
			maxPendingBytes: this.options.maxPendingBytes,
			maxMessageBytes: this.options.maxMessageBytes,
			gracefulCloseTimeoutMs: this.options.gracefulCloseTimeoutMs,
		});
		this.connections.add(connection);
		const handler = accept(connection);
		if (head.byteLength > 0) {
			connection.handleChunk(new Uint8Array(head.buffer, head.byteOffset, head.byteLength), handler);
		}
		socket.on("data", (chunk) => {
			connection.handleChunk(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), handler);
		});
		socket.on("error", (error) => {
			handler.onError(error);
			socket.destroy();
		});
		socket.once("close", () => {
			connection.markClosed();
			this.connections.delete(connection);
			handler.onClose();
		});
	};

	private async closeInternal(): Promise<void> {
		if (this.server) this.server.off("upgrade", this.onUpgrade);
		await Promise.all([...this.connections].map((connection) => connection.close()));
		this.connections.clear();
		if (this.ownsServer && this.server) {
			const server = this.server;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		}
		this.server = undefined;
	}

	private reportError(error: unknown): void {
		try {
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect listener state.
		}
	}
}

function isLoopbackRemote(remoteAddress: string | undefined): boolean {
	return remoteAddress !== undefined && LOOPBACK_ADDRESSES.has(remoteAddress);
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

function rejectUpgrade(
	socket: Socket,
	status: number,
	reason: string,
	extraHeaders: Record<string, string> = {},
): void {
	const headers = Object.entries(extraHeaders)
		.map(([name, value]) => `${name}: ${value}\r\n`)
		.join("");
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n${headers}content-length: 0\r\n\r\n`);
	socket.end();
}
