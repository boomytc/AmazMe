import type { ByteTransport } from "@amazme/client";
import { createUnixTransportFactory, type UnixServerRoute } from "@amazme/client/unix";
import type { ByteConnection, ByteConnectionAcceptor, ByteConnectionHandler } from "@amazme/server";

/**
 * One page connection forwarded to a server that runs elsewhere, byte for byte: the page speaks the
 * same ordered byte protocol over the loopback WebSocket that the server's Unix socket carries, so a
 * second client — another browser tab, a second web launch, the terminal client — uses the running
 * host instead of starting one of its own.
 *
 * The page's bytes are buffered until the upstream socket connects, so a page that writes first
 * loses nothing.
 */
class BridgedConnection {
	readonly #page: ByteConnection;
	readonly #path: string;
	#upstream: ByteTransport | undefined;
	#pending: Uint8Array[] = [];
	#closed = false;

	constructor(page: ByteConnection, path: string) {
		this.#page = page;
		this.#path = path;
	}

	/** The page side: bytes go upstream, and a close on either side closes the other. */
	readonly handler: ByteConnectionHandler = {
		onData: (chunk: Uint8Array): void => {
			if (this.#closed) return;
			const upstream = this.#upstream;
			if (upstream === undefined) {
				this.#pending.push(chunk);
				return;
			}
			void upstream.send(chunk).catch(() => this.end());
		},
		onClose: (): void => this.end(),
		onError: (): void => this.end(),
	};

	/** Dial the server and start forwarding. Call once, after `handler` has been handed back. */
	async connect(): Promise<void> {
		let transport: ByteTransport;
		try {
			transport = await createUnixTransportFactory({ path: this.#path })({
				onData: (chunk) => {
					if (!this.#closed) void this.#page.send(chunk).catch(() => this.end());
				},
				onClose: () => this.end(),
				onError: () => this.end(),
			});
		} catch {
			// The server is gone or refused the dial: the page learns through its own close.
			this.end();
			return;
		}
		if (this.#closed) {
			transport.close();
			return;
		}
		this.#upstream = transport;
		const pending = this.#pending;
		this.#pending = [];
		for (const chunk of pending) {
			try {
				await transport.send(chunk);
			} catch {
				this.end();
				return;
			}
		}
	}

	/** Close both directions once; repeated calls are harmless. */
	end(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#pending = [];
		this.#upstream?.close();
		void Promise.resolve(this.#page.close()).catch(() => undefined);
	}
}

/**
 * The bridge a page host uses when the server already runs elsewhere: the WebSocket endpoint stays
 * this host's, and every connection it accepts is forwarded to the running server.
 */
export interface ServerBridge {
	/** The acceptor the page host starts its WebSocket listener with. */
	readonly accept: ByteConnectionAcceptor;
	/** Stop forwarding: every page connection this bridge holds is closed. */
	close(): Promise<void>;
}

export function createServerBridge(route: UnixServerRoute): ServerBridge {
	const connections = new Set<BridgedConnection>();
	const drop = (bridged: BridgedConnection): void => {
		connections.delete(bridged);
	};
	return {
		accept(page: ByteConnection): ByteConnectionHandler {
			const bridged = new BridgedConnection(page, route.path);
			connections.add(bridged);
			void bridged.connect();
			return {
				onData: (chunk) => bridged.handler.onData(chunk),
				onClose: () => {
					bridged.handler.onClose();
					drop(bridged);
				},
				onError: (error) => {
					bridged.handler.onError(error);
					drop(bridged);
				},
			};
		},
		async close(): Promise<void> {
			for (const connection of [...connections]) connection.end();
			connections.clear();
		},
	};
}
