import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ServerId } from "@amazme/protocol";
import { WebSocketListener } from "@amazme/server/websocket";
import type { WebBootManifest, WebMode } from "@amazme/web";
import { contentTypeFor, PAGE_DOCUMENT, PAGE_SCRIPT, readPageDocument, resolvePageAsset } from "@amazme/web/assets";
import { APP_NAME, VERSION } from "../../config.ts";
import { startForegroundServer, type RunningServer } from "../server.ts";
import { buildBootManifest, injectBootManifest } from "./boot.ts";
import { bundlePageEntry } from "./bundle.ts";
/** Canonical loopback address the page and the WebSocket endpoint are served on. */
const WEB_HOST = "127.0.0.1";
const WEB_SOCKET_PATH = "/amazme";
const NOT_FOUND = "Not found\n";

export interface WebHostOptions {
	/** Loopback port. Defaults to an OS-assigned port so launches cannot collide. */
	readonly port?: number;
	readonly serverId?: ServerId;
	readonly sessionDir?: string;
	readonly directory?: string;
	/** Upgrade path for the byte protocol. Defaults to `/amazme`. */
	readonly path?: string;
	/** Repository root used for the page bundle's tsconfig paths. */
	readonly repositoryRoot?: string;
}

export interface WebHost {
	/** Canonical loopback URL of the served page. */
	readonly url: string;
	/** Canonical loopback URL of the WebSocket endpoint. */
	readonly webSocketUrl: string;
	readonly mode: WebMode;
	readonly serverId: string;
	readonly socketPath: string;
	readonly httpServer: HttpServer;
	/** Undefined for the lifetime of the host unless the server closed on its own. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

const repositoryRootFromModule = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * Start the AmazMe host for the web client: the same server, sessions, and services the TUI
 * uses, plus a loopback HTTP document that carries the boot manifest and a WebSocket endpoint
 * that speaks the byte protocol. The page keeps no business logic; the host owns sessions,
 * tools, and model calls.
 */
export async function startWebHost(options: WebHostOptions = {}): Promise<WebHost> {
	const repositoryRoot = options.repositoryRoot ?? repositoryRootFromModule;
	const path = options.path ?? WEB_SOCKET_PATH;
	const [document, bundle] = await Promise.all([readPageDocument(), bundlePageEntry(repositoryRoot)]);
	const httpServer = createServer((request, response) => {
		void serveRequest(request, response, { document, script: bundle.code, manifest: () => manifest });
	});
	let manifest: WebBootManifest | undefined;
	const listener = new WebSocketListener({ server: httpServer, path });
	await listen(httpServer, options.port ?? 0);
	const port = boundPort(httpServer);
	try {
		const runtime = await startForegroundServer({
			...(options.directory === undefined ? {} : { directory: options.directory }),
			...(options.serverId === undefined ? {} : { serverId: options.serverId }),
			...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
			listeners: [listener],
		});
		manifest = buildBootManifest({
			appName: APP_NAME,
			version: VERSION,
			serverId: runtime.serverId,
			transportUrl: `ws://${WEB_HOST}:${port}${path}`,
			transportPath: path,
		});
		const url = `http://${WEB_HOST}:${port}/`;
		let closePromise: Promise<void> | undefined;
		return {
			url,
			webSocketUrl: manifest.transport.url,
			mode: manifest.mode,
			serverId: runtime.serverId,
			socketPath: runtime.socketPath,
			httpServer,
			closed: runtime.closed,
			close: () => {
				closePromise ??= closeHost(runtime, listener, httpServer);
				return closePromise;
			},
		};
	} catch (error) {
		await Promise.allSettled([listener.close(), closeServer(httpServer)]);
		throw error;
	}
}

async function closeHost(runtime: RunningServer, listener: WebSocketListener, httpServer: HttpServer): Promise<void> {
	const results = await Promise.allSettled([runtime.close(), listener.close(), closeServer(httpServer)]);
	const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, "Web host shutdown failed");
}

interface PageAssets {
	readonly document: string;
	readonly script: string;
	readonly manifest: () => WebBootManifest | undefined;
}

async function serveRequest(request: IncomingMessage, response: ServerResponse, assets: PageAssets): Promise<void> {
	try {
		if (request.method !== "GET" && request.method !== "HEAD") {
			respond(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
			return;
		}
		const urlPath = (request.url ?? "/").split("?")[0] ?? "/";
		if (urlPath === "/") {
			respond(response, 200, contentTypeFor(PAGE_DOCUMENT), injectBootManifest(assets.document, assets.manifest()));
			return;
		}
		if (urlPath === PAGE_SCRIPT) {
			respond(response, 200, "text/javascript; charset=utf-8", assets.script);
			return;
		}
		// Every other path serves the page directory untouched, so `/index.html` is the
		// document without its boot manifest: exactly the unbootable case the page reports.
		const asset = resolvePageAsset(urlPath);
		if (asset === undefined) {
			respond(response, 404, "text/plain; charset=utf-8", NOT_FOUND);
			return;
		}
		let body: Buffer;
		try {
			body = await readFile(asset);
		} catch {
			respond(response, 404, "text/plain; charset=utf-8", NOT_FOUND);
			return;
		}
		respond(response, 200, contentTypeFor(asset), body);
	} catch (error) {
		respond(response, 500, "text/plain; charset=utf-8", `${error instanceof Error ? error.message : error}\n`);
	}
}

function respond(response: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
	response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
	response.end(body);
}

function listen(server: HttpServer, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
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
		server.listen(port, WEB_HOST);
	});
}

function boundPort(server: HttpServer): number {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Web host did not bind a TCP port");
	return address.port;
}

function closeServer(server: HttpServer): Promise<void> {
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections?.();
	});
}
