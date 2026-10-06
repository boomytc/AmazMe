import type { Server as HttpServer } from "node:http";

/** Options for the loopback WebSocket listener. */
export interface WebSocketListenerOptions {
	/** Attach to an HTTP server the caller already serves instead of binding one. */
	server?: HttpServer;
	/** Bind address for the owned HTTP server. Defaults to loopback. */
	host?: string;
	/** Bind port for the owned HTTP server. Defaults to an OS-assigned port. */
	port?: number;
	/** Upgrade path. Defaults to `/amazme`. */
	path?: string;
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes?: number;
	/** Maximum decoded message size accepted from the peer. Defaults to `maxFrameLength`. */
	maxMessageBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Reject upgrades whose peer address is not loopback. Defaults to true. */
	loopbackOnly?: boolean;
	/** Used to derive and validate maxPendingBytes. Must match the server when customized. */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}
