import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { FacetBundleArtifact } from "@amazme/chord/node";
import { Client, ServerError as ClientServerError, DisconnectedError } from "@amazme/client";
import { createUnixTransportFactory, type UnixServerRoute } from "@amazme/client/unix";
import { isServerId, type ServerId } from "@amazme/protocol";
import {
	Server,
	ServerError as RoutedServerError,
	type ServerHost,
	SessionNotFoundError,
} from "@amazme/server";
import type { ServerListener } from "@amazme/server";
import { createUnixListener, getUnixSocketPath } from "@amazme/server/unix";
import lockfile from "proper-lockfile";
import type { AuthInput } from "../cli/experimental/command-options.ts";
import { CONFIG_DIR_NAME, getAgentDir, getSettingsPath } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import { CoordinatorConnection, type CoordinatorStartupLease, ensureCoordinator } from "./coordinator.ts";
import { createPresentationFacetData } from "./plugins/bundled.ts";
import {
	createServerPluginPackage,
	normalizePluginPackagePaths,
	readSessionPluginPackageProfile,
	removeSessionPluginPackageProfile,
	restoreServerPluginPackageProfile,
	writeSessionPluginPackageProfile,
} from "./plugins/package.ts";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
	spawnInternalProcess,
	terminateInternalProcess,
} from "./process.ts";
import { RadiusRelayAuthResolver } from "./radius-auth.ts";
import { RadiusRelayHost, type RadiusRelayHostStatus } from "./radius-relay.ts";
import { createExperimentalServerServices } from "./services/server.ts";
import type { ServerAdministrationOptions } from "./services/server.ts";
import { AgentController } from "./services/agent-controller.ts";
import type { SessionCreateOptions, SessionSource, SessionSummary } from "./services/sessions.ts";
import {
	createSession as createCatalogSession,
	deleteSession,
	listSessions as listCatalogSessions,
	readSession,
	type SessionCatalogMetadata,
} from "./session-catalog.ts";
import { SessionPluginSelectionConflictError, SessionWorkerManager } from "./session-worker-manager.ts";
import { listLocalSessions } from "./session-store.ts";

export const ENV_SERVER_DIR = "AMAZME_SERVER_DIR";
export const ENV_SERVER_ID = "AMAZME_SERVER_ID";

export function resolveServerDirectory(directory?: string): string {
	return resolvePath(directory ?? process.env[ENV_SERVER_DIR] ?? join(homedir(), ".amazme", "server"));
}

export async function ensurePrivateServerDirectory(directory: string): Promise<void> {
	if (typeof process.getuid !== "function") throw new Error("Unix socket directory requires a POSIX user ID");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await lstat(directory);
	if (!stats.isDirectory()) throw new Error(`Unix socket directory is not a directory: ${directory}`);
	if (stats.uid !== process.getuid()) {
		throw new Error(`Unix socket directory is not owned by the current user: ${directory}`);
	}
	await chmod(directory, 0o700);
}

export function resolveSessionDirectory(sessionDir?: string): string {
	return resolvePath(sessionDir ?? join(getAgentDir(), "experimental", "sessions"));
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 30_000;
const DEFAULT_SERVER_ID_FILE = "default-server-id";

export interface ServerProfile {
	readonly serverId: ServerId;
	release(): Promise<void>;
}

/** Lock one logical server ID in a shared experimental server directory. */
export async function acquireServerProfile(directory: string, requestedServerId?: string): Promise<ServerProfile> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let serverId: ServerId;
	if (requestedServerId !== undefined) {
		if (!isServerId(requestedServerId)) throw new Error(`Invalid experimental server ID: ${requestedServerId}`);
		serverId = requestedServerId;
	} else {
		const path = join(directory, DEFAULT_SERVER_ID_FILE);
		try {
			const value = (await readFile(path, "utf8")).trim();
			if (!isServerId(value)) throw new Error(`Invalid default experimental server identity in ${path}`);
			serverId = value;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") throw error;
			const candidate = randomUUID();
			try {
				await writeFile(path, candidate, { encoding: "utf8", mode: 0o600, flag: "wx" });
				serverId = candidate;
			} catch (writeError) {
				const writeCode = writeError instanceof Error && "code" in writeError ? writeError.code : undefined;
				if (writeCode !== "EEXIST") throw writeError;
				const value = (await readFile(path, "utf8")).trim();
				if (!isServerId(value)) throw new Error(`Invalid default experimental server identity in ${path}`);
				serverId = value;
			}
		}
	}

	const release = await lockfile.lock(join(directory, `launcher-${serverId}`), {
		realpath: false,
		stale: LOCK_STALE_MS,
		update: LOCK_STALE_MS / 3,
		retries: {
			retries: Math.ceil(LOCK_WAIT_MS / LOCK_RETRY_MS),
			factor: 1,
			minTimeout: LOCK_RETRY_MS,
			maxTimeout: LOCK_RETRY_MS,
			maxRetryTime: LOCK_WAIT_MS,
		},
	});
	return { serverId, release };
}

const ACTIVATION_TIMEOUT_MS = 10_000;
const ACTIVATION_RETRY_MS = 10;

export interface ActivatedServer {
	readonly client: Client;
	readonly route: UnixServerRoute;
}

export interface ActivateServerOptions {
	readonly directory: string;
	readonly requestedServerId?: ServerId | string;
	readonly sessionDir: string;
	readonly provider?: string;
	readonly model?: string;
}

/** Ensure the selected logical server is reachable, launching the current Pi installation if needed. */
export async function activateServer(options: ActivateServerOptions): Promise<ActivatedServer> {
	if (options.provider !== undefined && options.model === undefined) {
		throw new Error("Server model provider requires a model");
	}
	await ensurePrivateServerDirectory(options.directory);
	const profile = await acquireServerProfile(options.directory, options.requestedServerId);
	const serverId = profile.serverId;
	await profile.release();
	const route = { serverId, path: getUnixSocketPath(serverId, options.directory) };
	const release = await acquireServerActivation(options.directory, serverId);
	try {
		const existing = await connect(route);
		if (existing) {
			// Another activator won the race, so startup-only selections can no longer be applied.
			if (options.model !== undefined) {
				await existing.dispose();
				throw new Error("Model selection is only valid when automatically activating a new server");
			}
			return { client: existing, route };
		}
		const modelArgs =
			options.model === undefined
				? []
				: [
						JSON.stringify({
							...(options.provider === undefined ? {} : { provider: options.provider }),
							model: options.model,
						}),
					];
		const child = spawnInternalProcess("server", [options.directory, serverId, options.sessionDir, ...modelArgs]);
		let spawnError: Error | undefined;
		child.once("error", (error) => {
			spawnError = error;
		});
		try {
			const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
			while (true) {
				const client = await connect(route);
				if (client) return { client, route };
				if (spawnError) throw new Error("Failed to automatically activate server", { cause: spawnError });
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error("Automatically activated server exited during startup");
				}
				if (Date.now() >= deadline) throw new Error("Timed out waiting for automatically activated server");
				await new Promise<void>((resolve) => setTimeout(resolve, ACTIVATION_RETRY_MS));
			}
		} catch (error) {
			await terminateInternalProcess(child);
			throw error;
		}
	} finally {
		await release();
	}
}

export function acquireServerActivation(directory: string, serverId: ServerId): Promise<() => Promise<void>> {
	return lockfile.lock(join(directory, `activation-${serverId}`), {
		realpath: false,
		stale: ACTIVATION_TIMEOUT_MS * 2,
		update: ACTIVATION_TIMEOUT_MS,
		retries: {
			retries: Math.ceil(ACTIVATION_TIMEOUT_MS / 25),
			factor: 1,
			minTimeout: 25,
			maxTimeout: 25,
			maxRetryTime: ACTIVATION_TIMEOUT_MS,
		},
	});
}

async function connect(route: UnixServerRoute): Promise<Client | undefined> {
	const client = new Client({
		serverId: route.serverId,
		transportFactory: createUnixTransportFactory({ path: route.path }),
	});
	try {
		await client.connect();
		return client;
	} catch (error) {
		await client.dispose();
		if (error instanceof DisconnectedError || (error instanceof ClientServerError && error.code === "version")) {
			return undefined;
		}
		let current = error;
		const seen = new Set<unknown>();
		while (current instanceof Error && !seen.has(current)) {
			seen.add(current);
			if (
				"code" in current &&
				["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(String(current.code))
			) {
				return undefined;
			}
			current = current.cause;
		}
		throw error;
	}
}

const AUTO_SERVER_STARTUP_GRACE_MS = 10_000;
const AUTO_SERVER_IDLE_GRACE_MS = 1_000;

/** Reconcile operator, startup, client, and worker holds for one server generation. */
export class ServerLifetime {
	readonly #keepAlive: boolean;
	#connectionCount = 0;
	#workerCount = 0;
	#startupHeld: boolean;
	#startupTimer: NodeJS.Timeout | undefined;
	#retirementTimer: NodeJS.Timeout | undefined;
	#retire: (() => void) | undefined;
	#stopped = false;

	constructor(keepAlive: boolean) {
		this.#keepAlive = keepAlive;
		this.#startupHeld = !keepAlive;
	}

	start(retire: () => void): void {
		this.#retire = retire;
		if (this.#startupHeld) {
			this.#startupTimer = setTimeout(() => {
				this.#startupTimer = undefined;
				this.#startupHeld = false;
				this.#reconcile();
			}, AUTO_SERVER_STARTUP_GRACE_MS);
			this.#startupTimer.unref();
		}
		this.#reconcile();
	}

	setConnectionCount(count: number): void {
		this.#connectionCount = count;
		if (count > 0 && this.#startupHeld) {
			this.#startupHeld = false;
			if (this.#startupTimer) clearTimeout(this.#startupTimer);
			this.#startupTimer = undefined;
		}
		this.#reconcile();
	}

	setWorkerCount(count: number): void {
		this.#workerCount = count;
		this.#reconcile();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#startupTimer) clearTimeout(this.#startupTimer);
		if (this.#retirementTimer) clearTimeout(this.#retirementTimer);
		this.#startupTimer = undefined;
		this.#retirementTimer = undefined;
	}

	#reconcile(): void {
		if (
			this.#stopped ||
			this.#keepAlive ||
			this.#startupHeld ||
			this.#connectionCount !== 0 ||
			this.#workerCount !== 0
		) {
			if (this.#retirementTimer) clearTimeout(this.#retirementTimer);
			this.#retirementTimer = undefined;
			return;
		}
		const retire = this.#retire;
		if (this.#retirementTimer || !retire) return;
		this.#retirementTimer = setTimeout(() => {
			this.#retirementTimer = undefined;
			if (!this.#stopped && !this.#startupHeld && this.#connectionCount === 0 && this.#workerCount === 0) {
				retire();
			}
		}, AUTO_SERVER_IDLE_GRACE_MS);
		this.#retirementTimer.unref();
	}
}

export interface RunningServer {
	readonly serverId: string;
	readonly sessionDir: string;
	readonly socketPath: string;
	readonly server: Server;
	readonly workerPids: ReadonlyMap<string, number>;
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

export interface StartServerOptions {
	/** Server profile and socket directory. Defaults to AMAZME_SERVER_DIR or ~/.amazme/server. */
	readonly directory?: string;
	/** Logical service ID. Defaults to AMAZME_SERVER_ID or the directory's default-server-id. */
	readonly serverId?: ServerId;
	/** Durable session directory. Defaults to the experimental directory under the configured agent directory. */
	readonly sessionDir?: string;
	/** Optional provider for an explicitly selected Session worker model. */
	readonly provider?: string;
	/** Optional model override for newly started Session workers. */
	readonly model?: string;
	/** Hold the server open without client or Session demand. Defaults to true for foreground servers. */
	readonly keepAlive?: boolean;
	/** Extra listeners composed alongside the Unix socket, e.g. the loopback WebSocket endpoint. */
	readonly listeners?: readonly ServerListener[];
	/** Optional explicit Radius credential. Stored Radius auth is used when omitted. */
	readonly relayAuth?: AuthInput;
	/** Explicit plugin packages. Undefined restores the logical server profile; an empty list clears it. */
	readonly pluginPackages?: readonly string[];
	readonly onRelayStatus?: (status: RadiusRelayHostStatus) => void;
}

interface ResolvedSessionPlugins {
	readonly packagePaths: readonly string[];
	readonly manifestPaths: readonly string[];
	readonly presentationArtifacts: readonly FacetBundleArtifact[];
}

interface StartServerBackendOptions {
	readonly path: string;
	readonly serverId: ServerId;
	readonly sessionDir?: string;
	readonly listeners?: readonly ServerListener[];
	resolveSessionPlugins(
		metadata: SessionCatalogMetadata,
		packagePaths: readonly string[] | undefined,
		context: Context,
	): Promise<ResolvedSessionPlugins>;
	removeSessionPlugins(metadata: SessionCatalogMetadata): Promise<void>;
	reloadPresentationFacetBundles(packagePaths: readonly string[]): Promise<readonly FacetBundleArtifact[]>;
	/** The server's default plugin selection, and the write that replaces it. */
	listServerPluginPackages(): readonly string[];
	setServerPluginPackages(packagePaths: readonly string[]): Promise<readonly string[]>;
}

interface RunningServerBackend extends RunningServer {
	refreshSessions(): Promise<void>;
}

async function startServerBackend(
	options: StartServerBackendOptions,
	workers: SessionWorkerManager,
	onConnectionCountChanged?: (count: number) => void,
): Promise<RunningServerBackend> {
	const serverId = options.serverId;
	const sessionDir = resolveSessionDirectory(options.sessionDir);
	const listSessions = async (): Promise<SessionCatalogMetadata[]> => {
		const sessions = new Map((await listCatalogSessions(sessionDir)).map((metadata) => [metadata.path, metadata]));
		for (const metadata of workers.trackedSessions) sessions.set(metadata.path, metadata);
		return [...sessions.values()];
	};
	const resolveSession = async (sessionId: string, _context: Context): Promise<SessionCatalogMetadata> => {
		const metadata =
			workers.trackedSessions.find((candidate) => candidate.id === sessionId) ??
			(await readSession(sessionDir, sessionId));
		if (metadata !== undefined) return metadata;
		// A terminal session the host has not opened yet: adopting it stores it under its own id with
		// the working directory its header records, and its worker seeds the transcript from the file.
		const local = (await listLocalSessions(process.cwd())).find((session) => session.id === sessionId);
		if (local === undefined) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		const adopted = await createCatalogSession(sessionDir, { id: sessionId, cwd: local.cwd });
		return adopted;
	};
	const createSession = (createOptions: SessionCreateOptions): Promise<SessionCatalogMetadata> =>
		createCatalogSession(sessionDir, { ...createOptions, cwd: process.cwd() });
	const summarize = (metadata: SessionCatalogMetadata, source: SessionSource = "host"): SessionSummary => ({
		serverId,
		sessionId: metadata.id,
		createdAt: metadata.createdAt,
		cwd: metadata.cwd,
		source,
	});

	/**
	 * The session list one client reads: the Sessions this host owns, plus the terminal sessions it
	 * could adopt. A Session that a host owns shadows the terminal file it mirrors, so one session is
	 * one row whichever side made it.
	 */
	const listSummaries = async (): Promise<SessionSummary[]> => {
		const hosted = (await listSessions()).map((metadata) => summarize(metadata));
		const owned = new Set(hosted.map((summary) => summary.sessionId));
		const locals = (await listLocalSessions(process.cwd()))
			.filter((session) => !owned.has(session.id))
			.map((session) =>
				summarize(
					{
						id: session.id,
						createdAt: session.createdAt,
						cwd: session.cwd,
						path: session.path,
					},
					"local",
				),
			);
		return [...hosted, ...locals].sort(
			(left, right) => left.sessionId.localeCompare(right.sessionId) || left.createdAt - right.createdAt,
		);
	};
	/**
	 * Run one planned prompt against its session: attach a client to the session's worker, submit
	 * the prompt, wait for the turn to settle, and release the attachment. The returned note is the
	 * schedule's last outcome, so it reports how the run ended rather than only that it started.
	 */
	const runScheduledPrompt = async (sessionId: string, prompt: string, context: Context): Promise<string> => {
		const metadata = await resolveSession(sessionId, context);
		const selected = await options.resolveSessionPlugins(metadata, undefined, context);
		const handle = await workers.openSession(metadata, context, selected.manifestPaths);
		const attachment = await handle.attachClient(context);
		try {
			const submitted: unknown = await attachment.invokeService(
				{ serviceId: AgentController.id, member: "prompt", args: [{ message: prompt, images: null }] },
				() => {},
				context,
			);
			const submission = readSubmission(submitted);
			if ("refusal" in submission) throw new Error(submission.refusal);
			const settled: unknown = await attachment.invokeService(
				{ serviceId: AgentController.id, member: "waitForPrompt", args: [submission.operationId] },
				() => {},
				context,
			);
			return readSettlement(settled) ?? "Answered.";
		} finally {
			await attachment.release(context);
		}
	};
	// The administration surfaces read and write the agent directory the CLI uses, plus the
	// checkout's project settings: one Settings, Skills, and Plugins instance per server.
	const administrationCwd = process.cwd();
	const administration: ServerAdministrationOptions = {
		settings: {
			manager: SettingsManager.create(administrationCwd),
			agentDir: getAgentDir(),
			cwd: administrationCwd,
			paths: {
				global: getSettingsPath(),
				project: join(administrationCwd, CONFIG_DIR_NAME, "settings.json"),
			},
		},
		feedback: { agentDir: getAgentDir() },
		schedules: { agentDir: getAgentDir(), run: runScheduledPrompt },
		pluginPackages: {
			list: () => options.listServerPluginPackages(),
			set: (packagePaths) => options.setServerPluginPackages(packagePaths),
		},
	};
	const serverServices = await createExperimentalServerServices({
		administration,
		list: () => listSummaries(),
		create: async (createOptions) => summarize(await createSession(createOptions)),
		remove: async (sessionId, context) => {
			const metadata = await resolveSession(sessionId, context);
			await workers.closeSession(metadata, context);
			await deleteSession(metadata);
			await options.removeSessionPlugins(metadata);
		},
		async prepareSessionPlugins(sessionId, packagePaths, context) {
			const metadata = await resolveSession(sessionId, context);
			let selected: ResolvedSessionPlugins;
			try {
				selected = await options.resolveSessionPlugins(metadata, packagePaths, context);
				workers.assertSessionPluginManifestPaths(metadata, selected.manifestPaths);
			} catch (error) {
				if (error instanceof SessionPluginSelectionConflictError) {
					throw new RoutedServerError("service_invalid_value", error.message);
				}
				throw error;
			}
			return {
				packagePaths: selected.packagePaths,
				presentationPlugins: createPresentationFacetData(selected.presentationArtifacts),
			};
		},
		async reloadPresentationPlugins(packagePaths) {
			return createPresentationFacetData(await options.reloadPresentationFacetBundles(packagePaths));
		},
	});
	const host: ServerHost<SessionCatalogMetadata> = {
		serverServices: serverServices.host,
		resolveSession,
		openSession: async (metadata, context) => {
			const selected = await options.resolveSessionPlugins(metadata, undefined, context);
			return workers.openSession(metadata, context, selected.manifestPaths);
		},
	};
	const socketPath = options.path;
	const closeCatalog = (): Promise<void> => serverServices.dispose();
	const server = new Server(host, {
		serverId,
		listeners: [createUnixListener({ path: socketPath, mode: 0o600 }), ...(options.listeners ?? [])],
		onConnectionCountChanged,
	});
	try {
		await server.start();
	} catch (error) {
		const cleanup = await Promise.allSettled([server.close(), closeCatalog()]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Experimental server startup and cleanup failed");
		}
		throw error;
	}

	let closePromise: Promise<void> | undefined;
	const closed = server.closed.then(
		() => closeCatalog(),
		async (serverError: unknown) => {
			try {
				await closeCatalog();
			} catch (repoError) {
				throw new AggregateError([serverError, repoError], "Server and repository shutdown failed");
			}
			throw serverError;
		},
	);
	return {
		serverId,
		sessionDir,
		socketPath,
		server,
		workerPids: workers.workerPids,
		closed,
		refreshSessions: () => serverServices.refresh(BACKGROUND_CONTEXT),
		close() {
			closePromise ??= server.close().then(
				() => closed,
				() => closed,
			);
			return closePromise;
		},
	};
}

/** Start a replaceable experimental server behind the stable coordinator endpoint. */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
	if (options.provider !== undefined && options.model === undefined) {
		throw new Error("Server model provider requires a model");
	}
	const workerModel =
		options.model === undefined
			? undefined
			: { ...(options.provider === undefined ? {} : { provider: options.provider }), model: options.model };
	const directory = resolveServerDirectory(options.directory);
	const { serverId, release } = await acquireServerProfile(directory, options.serverId ?? process.env[ENV_SERVER_ID]);
	const lifetime = new ServerLifetime(options.keepAlive ?? true);
	let backend: RunningServerBackend | undefined;
	let coordinator: CoordinatorConnection | undefined;
	let startupLease: CoordinatorStartupLease | undefined;
	let workers: SessionWorkerManager | undefined;
	let relay: RadiusRelayHost | undefined;
	let released = false;
	try {
		await ensurePrivateServerDirectory(directory);
		const pluginPackagePaths = await restoreServerPluginPackageProfile(directory, serverId, options.pluginPackages);
		const pluginPackages = new Map<string, ReturnType<typeof createServerPluginPackage>>();
		const getPluginPackage = (packagePath: string): ReturnType<typeof createServerPluginPackage> => {
			let plugin = pluginPackages.get(packagePath);
			if (plugin === undefined) {
				plugin = createServerPluginPackage(directory, serverId, packagePath);
				pluginPackages.set(packagePath, plugin);
			}
			return plugin;
		};
		const buildPluginSelection = async (packagePaths: readonly string[]): Promise<ResolvedSessionPlugins> => {
			const normalizedPackagePaths = normalizePluginPackagePaths(packagePaths);
			const plugins = normalizedPackagePaths.map(getPluginPackage);
			const built = (await Promise.all(plugins.map((plugin) => plugin.build()))).flat();
			return {
				packagePaths: normalizedPackagePaths,
				manifestPaths: plugins.map((plugin) => plugin.manifestPath),
				presentationArtifacts: built,
			};
		};
		let defaultPluginSelection = await buildPluginSelection(pluginPackagePaths);
		const sessionPluginSelections = new Map<string, ResolvedSessionPlugins>();
		const resolveSessionPlugins = async (
			metadata: SessionCatalogMetadata,
			requestedPackagePaths: readonly string[] | undefined,
			_context: Context,
		): Promise<ResolvedSessionPlugins> => {
			if (requestedPackagePaths !== undefined) {
				const normalizedPackagePaths = normalizePluginPackagePaths(requestedPackagePaths);
				const current = sessionPluginSelections.get(metadata.path);
				if (current !== undefined && sameStrings(current.packagePaths, normalizedPackagePaths)) return current;
				const requestedManifestPaths = normalizedPackagePaths.map(
					(packagePath) => getPluginPackage(packagePath).manifestPath,
				);
				workers?.assertSessionPluginManifestPaths(metadata, requestedManifestPaths);
				const candidate = await buildPluginSelection(normalizedPackagePaths);
				workers?.assertSessionPluginManifestPaths(metadata, candidate.manifestPaths);
				await writeSessionPluginPackageProfile(directory, serverId, metadata.path, candidate.packagePaths);
				sessionPluginSelections.set(metadata.path, candidate);
				return candidate;
			}
			const cached = sessionPluginSelections.get(metadata.path);
			if (cached !== undefined) return cached;
			const storedPackagePaths = await readSessionPluginPackageProfile(directory, serverId, metadata.path);
			const selected =
				storedPackagePaths === undefined ? defaultPluginSelection : await buildPluginSelection(storedPackagePaths);
			if (storedPackagePaths === undefined) {
				await writeSessionPluginPackageProfile(directory, serverId, metadata.path, selected.packagePaths);
			}
			sessionPluginSelections.set(metadata.path, selected);
			return selected;
		};
		const removeSessionPlugins = async (metadata: SessionCatalogMetadata): Promise<void> => {
			sessionPluginSelections.delete(metadata.path);
			await removeSessionPluginPackageProfile(directory, serverId, metadata.path);
		};
		const reloadPresentationFacetBundles = async (
			packagePaths: readonly string[],
		): Promise<readonly FacetBundleArtifact[]> => {
			const reloaded = await buildPluginSelection(packagePaths);
			if (sameStrings(defaultPluginSelection.packagePaths, reloaded.packagePaths)) {
				defaultPluginSelection = reloaded;
			}
			for (const [sessionPath, selected] of sessionPluginSelections) {
				if (sameStrings(selected.packagePaths, reloaded.packagePaths)) {
					sessionPluginSelections.set(sessionPath, reloaded);
				}
			}
			return reloaded.presentationArtifacts;
		};
		// The plugin management surface writes the server's default selection, so Sessions opened
		// afterwards load the new packages. A running worker keeps the generation it started with.
		const setServerPluginPackages = async (packagePaths: readonly string[]): Promise<readonly string[]> => {
			const selected = await buildPluginSelection(packagePaths);
			await restoreServerPluginPackageProfile(directory, serverId, selected.packagePaths);
			defaultPluginSelection = selected;
			return selected.packagePaths;
		};
		const socketPath = getUnixSocketPath(serverId, directory);
		const controlPath = join(directory, `control-${serverId}.sock`);
		const serverNonce = randomUUID().replaceAll("-", "").slice(0, 12);
		const serverPath = join(directory, `server-${serverId}-${serverNonce}.sock`);
		startupLease = await ensureCoordinator(socketPath, controlPath);
		coordinator = new CoordinatorConnection({ controlPath, endpoint: serverPath });
		const sessionDir = resolveSessionDirectory(options.sessionDir);
		workers = new SessionWorkerManager(coordinator, sessionDir, workerModel, (count) =>
			lifetime.setWorkerCount(count),
		);
		backend = await startServerBackend(
			{
				path: serverPath,
				serverId,
				sessionDir: options.sessionDir,
				...(options.listeners === undefined ? {} : { listeners: options.listeners }),
				resolveSessionPlugins,
				removeSessionPlugins,
				reloadPresentationFacetBundles,
				listServerPluginPackages: () => defaultPluginSelection.packagePaths,
				setServerPluginPackages,
			},
			workers,
			(count) => lifetime.setConnectionCount(count),
		);
		await coordinator.connect();
		startupLease.close();
		startupLease = undefined;
		await workers.discover(coordinator.peerIds);
		await backend.refreshSessions();
		relay = new RadiusRelayHost({
			serverId,
			server: backend.server,
			auth: new RadiusRelayAuthResolver(options.relayAuth),
			onStatus: options.onRelayStatus,
		});
		relay.start();

		const activeBackend = backend;
		const activeCoordinator = coordinator;
		const activeWorkers = workers;
		const activeRelay = relay;
		void activeCoordinator.replaced
			.then(async () => {
				lifetime.stop();
				activeWorkers.detach();
				await activeRelay.close();
				await activeBackend.close();
			})
			.finally(() => activeCoordinator.close())
			.catch(() => {});
		let closePromise: Promise<void> | undefined;
		const runtime: RunningServer = {
			serverId,
			sessionDir: activeBackend.sessionDir,
			socketPath,
			server: activeBackend.server,
			workerPids: activeWorkers.workerPids,
			closed: activeBackend.closed.finally(() => activeRelay.close()),
			close() {
				lifetime.stop();
				closePromise ??= (async () => {
					try {
						await activeRelay.close();
						await activeBackend.close();
					} finally {
						try {
							if (activeCoordinator.wasReplaced) activeWorkers.detach();
							else await activeWorkers.shutdown();
						} finally {
							activeCoordinator.close();
						}
					}
				})();
				return closePromise;
			},
		};
		lifetime.start(() => {
			void runtime.close().catch(() => {});
		});
		released = true;
		await release();
		return runtime;
	} catch (error) {
		lifetime.stop();
		startupLease?.close();
		if (coordinator?.wasReplaced) workers?.detach();
		const cleanup = await Promise.allSettled([
			relay?.close(),
			backend?.close(),
			coordinator?.wasReplaced ? undefined : workers?.shutdown(),
			Promise.resolve(coordinator?.close()),
			released ? undefined : release(),
		]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Server runtime startup and cleanup failed");
		}
		throw error;
	}
}

/** Start an operator-held server while serializing against automatic cold activation. */
export async function startForegroundServer(
	options: Omit<StartServerOptions, "keepAlive"> = {},
): Promise<RunningServer> {
	const directory = resolveServerDirectory(options.directory);
	await ensurePrivateServerDirectory(directory);
	const profile = await acquireServerProfile(directory, options.serverId ?? process.env[ENV_SERVER_ID]);
	const serverId = profile.serverId;
	await profile.release();
	const release = await acquireServerActivation(directory, serverId);
	try {
		return await startServer({
			...options,
			directory,
			serverId,
			keepAlive: true,
		});
	} finally {
		await release();
	}
}

function parseServerModelOptions(value: string | undefined): { provider?: string; model: string } | undefined {
	if (value === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Internal server received invalid model options", { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Internal server received invalid model options");
	}
	const keys = Object.keys(parsed);
	const model = "model" in parsed ? parsed.model : undefined;
	const provider = "provider" in parsed ? parsed.provider : undefined;
	if (
		keys.some((key) => key !== "provider" && key !== "model") ||
		typeof model !== "string" ||
		model.length === 0 ||
		(provider !== undefined && (typeof provider !== "string" || provider.length === 0))
	) {
		throw new Error("Internal server received invalid model options");
	}
	return provider === undefined ? { model } : { provider, model };
}

/** Run an automatically activated server until its client and Session demand disappears. */
export async function runServerProcess(args: readonly string[]): Promise<void> {
	const [directory, serverId, sessionDir, serializedModel] = args;
	if (args.length > 4) throw new Error("Internal server received unexpected arguments");
	if (!directory || !isAbsolute(directory)) throw new Error("Internal server requires an absolute server directory");
	if (!isServerId(serverId)) throw new Error("Internal server requires a canonical server ID");
	if (!sessionDir || !isAbsolute(sessionDir))
		throw new Error("Internal server requires an absolute Session directory");
	const workerModel = parseServerModelOptions(serializedModel);

	const runtime = await startServer({
		directory,
		serverId,
		sessionDir,
		keepAlive: false,
		...workerModel,
	});
	const close = (): void => {
		void runtime.close().catch(() => {});
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	try {
		await runtime.closed;
	} finally {
		process.off("SIGINT", close);
		process.off("SIGTERM", close);
		await runtime.close();
	}
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The accepted prompt's operation, or why the session refused it. */
function readSubmission(value: unknown): { readonly operationId: string } | { readonly refusal: string } {
	if (typeof value !== "object" || value === null) return { refusal: "The session did not answer the prompt." };
	const response = value as { accepted?: unknown; operationId?: unknown; error?: { message?: unknown } | null };
	if (response.accepted === true && typeof response.operationId === "string") {
		return { operationId: response.operationId };
	}
	const message = response.error?.message;
	return { refusal: typeof message === "string" ? message : "The session refused the prompt." };
}

/** Why the turn produced no answer, or undefined when it answered. */
function readSettlement(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const settled = value as { status?: unknown; reason?: unknown };
	if (settled.status !== "unanswered") return undefined;
	return `No answer: ${typeof settled.reason === "string" ? settled.reason : "the host did not say why"}`;
}

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "server") throw new Error("Server entrypoint requires an internal server invocation");
	void runServerProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
