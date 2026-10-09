import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { discoverUnixServers, type UnixServerRoute } from "@amazme/client/unix";
import type { ServerId } from "@amazme/protocol";
import { WebSocketListener } from "@amazme/server/websocket";
import type { WebBootManifest, WebBootPreferences, WebMode } from "@amazme/web";
import { contentTypeFor, PAGE_DOCUMENT, PAGE_SCRIPT, readPageDocument, resolvePageAsset } from "@amazme/web/assets";
import { APP_NAME, VERSION } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	acquireServerActivation,
	acquireServerProfile,
	ENV_SERVER_ID,
	ensurePrivateServerDirectory,
	resolveServerDirectory,
	startServer,
	type RunningServer,
} from "../server.ts";
import { buildBootManifest, DEFAULT_BOOT_PREFERENCES, serveDocument } from "./boot.ts";
import { createServerBridge, type ServerBridge } from "./bridge.ts";
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
	/** Selected server/session/presentation packages; undefined restores the host profile. */
	readonly pluginPackages?: readonly string[];
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
	/** The Unix socket of the server this host's pages talk to. */
	readonly socketPath: string;
	/**
	 * Whether this host started that server (`true`) or forwards its pages to one that was already
	 * running in the same server directory (`false`). A second launch attaches to the first.
	 */
	readonly ownsServer: boolean;
	readonly httpServer: HttpServer;
	/** Resolves when the server this host uses closes, for a server this host owns. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

const repositoryRootFromModule = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * The stored interface preferences, read fresh for every document: the page's language and palette
 * are written by the settings service, so a host that cached them would serve the previous answer.
 * A manager of its own keeps the HTTP server independent of the runtime's lifetime.
 */
async function readPreferences(): Promise<WebBootPreferences> {
	try {
		const manager = SettingsManager.create(process.cwd());
		await manager.reload();
		return { locale: manager.getLocalePreference(), appearance: manager.getAppearancePreference() };
	} catch {
		// An unreadable settings file leaves the page on the browser's language and the system's palette.
		return DEFAULT_BOOT_PREFERENCES;
	}
}

/**
 * The server this host's pages talk to: one this host started, or one that was already running in
 * the same server directory.
 */
interface HostedServer {
	readonly serverId: string;
	readonly socketPath: string;
	readonly owns: boolean;
	/** The server this host started; undefined when it forwards to a running one. */
	readonly runtime: RunningServer | undefined;
	/** The forwarding bridge; undefined when this host owns the server. */
	readonly bridge: ServerBridge | undefined;
	/** Resolves when the server closes, for a server this host started. */
	readonly closed: Promise<void>;
}

/** The server already listening in this directory under `serverId`, if any. */
async function findRunningServer(directory: string, serverId: string): Promise<UnixServerRoute | undefined> {
	// The same probe a terminal client uses, so a page host finds exactly the servers it finds.
	const routes = await discoverUnixServers({ directory });
	return routes.find((route) => route.serverId === serverId);
}

/**
 * The server this host's pages talk to. A server already running under this directory's logical
 * server id is reused: the page's WebSocket endpoint stays this host's, and every connection is
 * forwarded to that server, so a second launch shares one session list and one live state instead
 * of starting a second runtime. Holding the activation lock across the decision keeps two
 * simultaneous launches from racing into two servers.
 */
async function hostServer(options: WebHostOptions, listener: WebSocketListener): Promise<HostedServer> {
	const directory = resolveServerDirectory(options.directory);
	await ensurePrivateServerDirectory(directory);
	const profile = await acquireServerProfile(directory, options.serverId ?? process.env[ENV_SERVER_ID]);
	const serverId = profile.serverId;
	await profile.release();
	const release = await acquireServerActivation(directory, serverId);
	try {
		const running = await findRunningServer(directory, serverId);
		if (running !== undefined) {
			const bridge = createServerBridge(running);
			await listener.start(bridge.accept);
			return {
				serverId,
				socketPath: running.path,
				owns: false,
				runtime: undefined,
				bridge,
				// A server in another process closes on its own terms; this host only stops forwarding.
				closed: new Promise<void>(() => {}),
			};
		}
		const runtime = await startServer({
			directory,
			serverId,
			...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
			...(options.pluginPackages === undefined ? {} : { pluginPackages: options.pluginPackages }),
			listeners: [listener],
			keepAlive: true,
		});
		return {
			serverId,
			socketPath: runtime.socketPath,
			owns: true,
			runtime,
			bridge: undefined,
			closed: runtime.closed,
		};
	} finally {
		await release();
	}
}

/**
 * Start the AmazMe host for the web client: the same server, sessions, and services the TUI
 * uses, plus a loopback HTTP document that carries the boot manifest and a WebSocket endpoint
 * that speaks the byte protocol. The page keeps no business logic; the host owns sessions,
 * tools, and model calls.
 *
 * When a server already runs in this directory under the requested (or default) server id, this
 * host serves its pages against that server instead of starting a second one.
 */
export async function startWebHost(options: WebHostOptions = {}): Promise<WebHost> {
	const repositoryRoot = options.repositoryRoot ?? repositoryRootFromModule;
	const path = options.path ?? WEB_SOCKET_PATH;
	const [document, bundle] = await Promise.all([readPageDocument(), bundlePageEntry(repositoryRoot)]);
	// The HTTP socket binds before the server runtime exists, and the document carries the boot
	// manifest the runtime provides. A request answered in that window would serve an unbootable
	// page, so responses wait for the manifest the way a browser reload would.
	let releaseReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		releaseReady = resolve;
	});
	const httpServer = createServer((request, response) => {
		void serveRequest(request, response, {
			document,
			script: bundle.code,
			manifest: () => manifest,
			ready,
			preferences: () => readPreferences(),
		});
	});
	let manifest: WebBootManifest | undefined;
	const listener = new WebSocketListener({ server: httpServer, path });
	await listen(httpServer, options.port ?? 0);
	const port = boundPort(httpServer);
	try {
		const hosted = await hostServer(options, listener);
		manifest = buildBootManifest({
			appName: APP_NAME,
			version: VERSION,
			serverId: hosted.serverId,
			transportUrl: `ws://${WEB_HOST}:${port}${path}`,
			transportPath: path,
		});
		releaseReady();
		const url = `http://${WEB_HOST}:${port}/`;
		let closePromise: Promise<void> | undefined;
		return {
			url,
			webSocketUrl: manifest.transport.url,
			mode: manifest.mode,
			serverId: hosted.serverId,
			socketPath: hosted.socketPath,
			ownsServer: hosted.owns,
			httpServer,
			closed: hosted.closed,
			close: () => {
				closePromise ??= closeHost(hosted, listener, httpServer);
				return closePromise;
			},
		};
	} catch (error) {
		// Nothing will ever carry a manifest now; let the waiting responses through and close.
		releaseReady();
		await Promise.allSettled([listener.close(), closeServer(httpServer)]);
		throw error;
	}
}

/** Stop serving pages, then hand back the server: close it when owned, drop the bridge when not. */
async function closeHost(hosted: HostedServer, listener: WebSocketListener, httpServer: HttpServer): Promise<void> {
	const results = await Promise.allSettled([
		listener.close(),
		hosted.bridge?.close(),
		hosted.runtime?.close(),
		closeServer(httpServer),
	]);
	const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, "Web host shutdown failed");
}

interface PageAssets {
	readonly document: string;
	readonly script: string;
	readonly manifest: () => WebBootManifest | undefined;
	/** Resolves once the runtime that provides the manifest exists. */
	readonly ready: Promise<void>;
	/** The stored interface preferences, read per document so a change lands on the next load. */
	readonly preferences: () => Promise<WebBootPreferences>;
}

async function serveRequest(request: IncomingMessage, response: ServerResponse, assets: PageAssets): Promise<void> {
	try {
		// The document and its script are only meaningful with the manifest, so they wait for it.
		await assets.ready;
		if (request.method !== "GET" && request.method !== "HEAD") {
			respond(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
			return;
		}
		const urlPath = (request.url ?? "/").split("?")[0] ?? "/";
		if (urlPath === "/") {
			// The identity comes from the runtime; the preferences are read per document, so a
			// language or palette switch lands on the next load along with the shell's copy.
			const manifest = assets.manifest();
			const preferences = await assets.preferences();
			const document = serveDocument(
				assets.document,
				manifest === undefined ? undefined : { ...manifest, preferences },
				request.headers["accept-language"],
			);
			respond(response, 200, contentTypeFor(PAGE_DOCUMENT), document);
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
