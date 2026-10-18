import { openServicePeer } from "./services/peer.ts";
import { serviceFacet, type ServiceValue } from "@amazme/protocol/services";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Context } from "@amazme/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@amazme/chord/context";
import type { PluginArtifact } from "../core/plugins/artifact.ts";
import { Client, ServerError as ClientServerError, DisconnectedError } from "@amazme/client";
import { createUnixTransportFactory, type UnixServerRoute } from "@amazme/client/unix";
import { isServerId, type ServerId } from "@amazme/protocol";
import {
	Server,
	ServerError as RoutedServerError,
	type ServerHost,
	SessionNotFoundError } from "@amazme/server";
import type { ServerListener } from "@amazme/server";
import { createUnixListener, getUnixSocketPath } from "@amazme/server/unix";
import lockfile from "proper-lockfile";
import type { AuthInput } from "../cli/host/command-options.ts";
import { CONFIG_DIR_NAME, getAgentDir, getSettingsPath } from "../config.ts";
import { createCodingSettings } from "../durable/harness-setup.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import { closeAfterSignal } from "../utils/shutdown-signals.ts";
import { CoordinatorConnection, type CoordinatorStartupLease, ensureCoordinator } from "./coordinator.ts";
import { ensureHostSocketDirectory, hostSocketDirectory, removeEmptyRelocatedSocketDirectory } from "./socket-directory.ts";
import { createPresentationFacetData, createServerPluginFacetLoader } from "./plugins/bundled.ts";
import { HostSessions } from "../core/plugins/host-sessions.ts";
import type { HostPromptRequest, HostPromptResult } from "../core/plugins/host-sessions.ts";
import { openPluginRuntime } from "../core/plugins/runtime.ts";
import {
	createServerPluginPackage,
	normalizePluginPackagePaths,
	readSessionPluginPackageProfile,
	removeSessionPluginPackageProfile,
	restoreServerPluginPackageProfile,
	writeSessionPluginPackageProfile } from "./plugins/package.ts";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
	spawnInternalProcess,
	terminateInternalProcess } from "./process.ts";
import { RadiusRelayAuthResolver } from "./radius-auth.ts";
import { RadiusRelayHost, type RadiusRelayHostStatus } from "./radius-relay.ts";
import { createExperimentalServerServices } from "./services/server.ts";
import type { ServerAdministrationOptions } from "./services/server.ts";
import { AgentController } from "../core/plugins/agent-controller.ts";
import type { AgentPromptResult } from "../core/plugins/agent-controller.ts";
import { automaticSessionName } from "./session-lifecycle.ts";
import type { SessionCreateOptions, SessionSource, SessionSummary } from "./services/sessions.ts";
import { ProjectCatalog } from "./project-catalog.ts";
import {
	createSession as createCatalogSession,
	deleteSession,
	listSessions as listCatalogSessions,
	mergeTrackedSession,
	normalizeSessionName,
	readSession,
	type SessionCatalogMetadata,
	writeSessionName,
	writeSessionArchive,
	writeSessionProject } from "./session-catalog.ts";
import { SessionPluginSelectionConflictError, SessionWorkerManager } from "./session-worker-manager.ts";

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
			maxRetryTime: LOCK_WAIT_MS } });
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
	const route = { serverId, path: getUnixSocketPath(serverId, hostSocketDirectory(options.directory)) };
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
							model: options.model }),
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
			maxRetryTime: ACTIVATION_TIMEOUT_MS } });
}

async function connect(route: UnixServerRoute): Promise<Client | undefined> {
	const client = new Client({
		serverId: route.serverId,
		transportFactory: createUnixTransportFactory({ path: route.path }) });
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
	readonly presentationArtifacts: readonly PluginArtifact[];
}

interface StartServerBackendOptions {
	readonly path: string;
	readonly serverId: ServerId;
	readonly sessionDir?: string;
	readonly listeners?: readonly ServerListener[];
	readonly serverPluginManifestPaths: readonly string[];
	resolveSessionPlugins(
		metadata: SessionCatalogMetadata,
		packagePaths: readonly string[] | undefined,
		context: Context,
	): Promise<ResolvedSessionPlugins>;
	removeSessionPlugins(metadata: SessionCatalogMetadata): Promise<void>;
	reloadPresentationFacetBundles(packagePaths: readonly string[]): Promise<readonly PluginArtifact[]>;
	/** The server's default plugin selection, and the write that replaces it. */
	listServerPluginPackages(): readonly string[];
	setServerPluginPackages(packagePaths: readonly string[]): Promise<readonly string[]>;
}

class SessionWorkEndedError extends Error {}

interface RunningServerBackend extends RunningServer {
	refreshSessions(): Promise<void>;
	activateHostSessions(): void;
}

async function startServerBackend(
	options: StartServerBackendOptions,
	workers: SessionWorkerManager,
	onConnectionCountChanged?: (count: number) => void,
): Promise<RunningServerBackend> {
	const serverId = options.serverId;
	const { promise: hostReady, resolve: resolveHostReady, reject: rejectHostReady } = Promise.withResolvers<void>();
	void hostReady.catch(() => {});
	const activateHostSessions = (): void => resolveHostReady();
	const sessionDir = resolveSessionDirectory(options.sessionDir);
	const projects = new ProjectCatalog(sessionDir);
	const previousProjects = await projects.list();
	let projectRows = await projects.initialize([
		...(previousProjects.length === 0 ? [process.cwd()] : []),
		...(await listCatalogSessions(sessionDir)).filter(session => session.projectId === undefined).map(session => session.cwd),
	]);
	const defaultCwd = await realpath(process.cwd());
	const defaultProjectId = (projectRows.find(project => !project.removed && (project.workspaces ?? [project.cwd]).includes(defaultCwd))
		?? projectRows.find(project => !project.removed) ?? projectRows[0]!).id;
	const projectForCwd = async (cwd: string) => {
		const path = await realpath(cwd).catch(() => cwd);
		return projectRows.find(project => !project.removed && (project.workspaces ?? [project.cwd]).includes(path))
			?? projectRows.find(project => (project.workspaces ?? [project.cwd]).includes(path));
	};
	const bindSessionProject = async (metadata: SessionCatalogMetadata): Promise<SessionCatalogMetadata> => {
		if (metadata.projectId !== undefined) return metadata;
		const project = await projectForCwd(metadata.cwd);
		// A replacement host can retain workers owned by another session catalog.
		if (project === undefined || await readSession(sessionDir, metadata.id) === undefined) return metadata;
		return writeSessionProject(sessionDir, metadata.id, project.id);
	};
	const listSessions = async (): Promise<SessionCatalogMetadata[]> => {
		const sessions = new Map((await listCatalogSessions(sessionDir)).map((metadata) => [metadata.path, metadata]));
		// A running worker replaces its catalog row. The display name stays the catalog's.
		for (const metadata of workers.trackedSessions) {
			sessions.set(metadata.path, mergeTrackedSession(sessions.get(metadata.path), metadata));
		}
		return Promise.all([...sessions.values()].map(bindSessionProject));
	};
	const resolveSession = async (sessionId: string, _context: Context): Promise<SessionCatalogMetadata> => {
		const catalog = await readSession(sessionDir, sessionId);
		const worker = workers.trackedSessions.find((candidate) => candidate.id === sessionId);
		const metadata = worker === undefined ? catalog : mergeTrackedSession(catalog, worker);
		if (metadata !== undefined) return bindSessionProject(metadata);
		throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
	};
	const createSession = async (createOptions: SessionCreateOptions, context: Context): Promise<SessionCatalogMetadata> => {
		if (createOptions.reuseEmpty && createOptions.id !== undefined) throw new Error("An explicit session ID cannot reuse an empty session");
		projectRows = await projects.list();
		let project = createOptions.projectId === undefined ? await projectForCwd(process.cwd()) : projectRows.find(project => project.id === createOptions.projectId);
		if (project === undefined && createOptions.projectId === undefined) project = await projects.create(process.cwd());
		if (project === undefined || (createOptions.projectId !== undefined && project.removed)) throw new Error("Unknown project");
		if (project.removed) project = await projects.restore(project.id);
		const cwd = createOptions.projectId === undefined ? process.cwd() : project.cwd;
		const projectId = project.id;
		if (createOptions.reuseEmpty) {
			const path = await realpath(cwd).catch(() => resolvePath(cwd));
			const candidates = await Promise.all((await listSessions()).filter(metadata => metadata.archivedAt === undefined && metadata.projectId === projectId).map(async metadata =>
				(await realpath(metadata.cwd).catch(() => resolvePath(metadata.cwd))) === path ? metadata : undefined));
			const latest = candidates.filter(metadata => metadata !== undefined)
				.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))[0];
			if (latest !== undefined) {
				const selected = await options.resolveSessionPlugins(latest, undefined, context);
				if (await workers.isSessionEmpty(latest, context, selected.manifestPaths)) return latest;
			}
		}
		return createCatalogSession(sessionDir, { ...(createOptions.id === undefined ? {} : { id: createOptions.id }), cwd, projectId: project.id });
	};
	const summarize = async (metadata: SessionCatalogMetadata, source: SessionSource = "host", name?: string): Promise<SessionSummary> => {
		const display = (name ?? metadata.name)?.trim() ?? "";
		const projectId = metadata.projectId ?? (await projectForCwd(metadata.cwd))?.id;
		return {
			serverId,
			sessionId: metadata.id,
			createdAt: metadata.createdAt,
			cwd: metadata.cwd,
			...(projectId === undefined ? {} : { projectId }),
			...(metadata.archivedAt === undefined ? {} : { archivedAt: metadata.archivedAt }),
			...(metadata.workEndedAt === undefined ? {} : { workEndedAt: metadata.workEndedAt }),
			source,
			...(display.length === 0 ? {} : { name: display }) };
	};

	/** The session list one client reads: the Durable sessions this host owns. */
	const listSummaries = async (): Promise<SessionSummary[]> => {
		projectRows = await projects.list();
		const metadata = await listSessions();
		const hosted = await Promise.all(metadata.map((metadata) => summarize(metadata, "host", metadata.name)));
		return hosted.sort(
			(left, right) => left.sessionId.localeCompare(right.sessionId) || left.createdAt - right.createdAt,
		);
	};
	const renameSession = async (sessionId: string, name: string): Promise<SessionSummary> => {
		const normalized = normalizeSessionName(name);
		const hosted = await readSession(sessionDir, sessionId);
		if (hosted === undefined) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		const updated = await writeSessionName(sessionDir, sessionId, normalized);
		return summarize(updated);
	};
	/**
	 * Join one plugin-owned prompt through the existing worker and its durable receipt.
	 * Session routing must be ready before a server facet can open an attachment.
	 */
	const openPromptSession = async (sessionId: string, context: Context, allowArchived = false) => {
		await awaitWithContext(hostReady, context);
		const metadata = await resolveSession(sessionId, context);
		if (!allowArchived && metadata.archivedAt !== undefined) throw new SessionWorkEndedError("会话已归档；恢复后才能开始工作。");
		const selected = await options.resolveSessionPlugins(metadata, undefined, context);
		const handle = await workers.openSession(metadata, context, selected.manifestPaths);
		return handle.attachClient(context);
	};
	const runHostPrompt = async (
		sessionId: string,
		request: HostPromptRequest,
		accepted: (operationId: string) => Promise<void>,
		context: Context,
	): Promise<HostPromptResult> => {
		let ended = false;
		const attachment = await openPromptSession(sessionId, context).catch((error: unknown) => {
			if (error instanceof SessionWorkEndedError) { ended = true; return null; }
			if (error instanceof SessionNotFoundError) return null;
			throw error;
		});
		if (attachment === null) return { status: "refused", code: ended ? "session_ended" : "target_missing", message: ended ? "会话已结束并归档；恢复后才能开始工作。" : `Unknown session: ${sessionId}` };
		const cleanupContext = withoutAbortSignal(context);
  let peer: Awaited<ReturnType<typeof openServicePeer>> | undefined;
		let operationId: string | undefined;
  let controller: AgentController | undefined;
		try {
   peer = await openServicePeer(attachment.invokeChannel.bind(attachment), context);
   controller = peer.services.get(AgentController);
   await peer.services.ready(context);
			context.abortSignal?.throwIfAborted();
			const existing: unknown = await controller.findPrompt(request.conversationId, request.requestId, cleanupContext);
			if (existing !== null && typeof existing !== "string") throw new Error("Invalid prompt receipt.");
			if (existing !== null) operationId = existing;
			else {
				context.abortSignal?.throwIfAborted();
				// Finish the admission receipt even if cancellation arrives after the input was committed.
				const submitted: unknown = await controller.prompt({ ...request, images: null }, cleanupContext);
				const submission = readSubmission(submitted);
				if ("refusal" in submission) return { status: "refused", ...submission.refusal };
				operationId = submission.operationId;
			}
			await accepted(operationId);
			context.abortSignal?.throwIfAborted();
			const settled: unknown = await controller.waitForPrompt(operationId, context);
			return readSettlement(settled);
		} catch (error) {
			if (operationId !== undefined && controller) {
				try {
					await controller.cancelPrompt(operationId, cleanupContext);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Scheduled prompt cancellation failed");
				}
			}
			throw error;
		} finally {
			try { await peer?.close(); } finally { await attachment.release(cleanupContext); }
		}
	};
	const cancelHostPrompt = async (sessionId: string, request: HostPromptRequest, context: Context): Promise<AgentPromptResult | null> => {
		const attachment = await openPromptSession(sessionId, context, true).catch((error: unknown) => {
			if (error instanceof SessionNotFoundError) return null;
			throw error;
		});
		if (attachment === null) return null;
		const cleanupContext = withoutAbortSignal(context);
  let peer: Awaited<ReturnType<typeof openServicePeer>> | undefined;
		try {
   peer = await openServicePeer(attachment.invokeChannel.bind(attachment), context);
   const controller = peer.services.get(AgentController);
   await peer.services.ready(context);
			const found: unknown = await controller.findPrompt(request.conversationId, request.requestId, cleanupContext);
			if (found === null) return null;
			if (typeof found !== "string") throw new Error("Invalid prompt receipt.");
			await controller.cancelPrompt(found, cleanupContext);
			const settlement: unknown = await controller.waitForPrompt(found, cleanupContext);
			return readSettlement(settlement);
		} finally { try { await peer?.close(); } finally { await attachment.release(cleanupContext); } }
	};
	// The administration surfaces read and write the agent directory the CLI uses, plus the
	// checkout's project settings: one Settings, Skills, and Plugins instance per server.
	const administrationCwd = process.cwd();
	const administration: ServerAdministrationOptions = {
		diagnosticHost: { id: serverId, directory: dirname(options.path), sessionDir },
		diagnosticResources: options.serverPluginManifestPaths,
		settings: {
			manager: createCodingSettings(administrationCwd),
			agentDir: getAgentDir(),
			cwd: administrationCwd,
			paths: {
				global: getSettingsPath(),
				project: join(administrationCwd, CONFIG_DIR_NAME, "settings.json") } },
		feedback: { agentDir: getAgentDir() },
		pluginPackages: {
			list: () => options.listServerPluginPackages(),
			set: (packagePaths) => options.setServerPluginPackages(packagePaths) } };
	const pluginLoader = createServerPluginFacetLoader(options.serverPluginManifestPaths);
	const plugins = pluginLoader === undefined ? undefined : await openPluginRuntime([
		serviceFacet("amazme.host-sessions", HostSessions, [], async (services) => {
			const implementation: ServiceValue<typeof HostSessions> = {
				agentDir: () => getAgentDir(),
				hostId: () => serverId,
				prompt: runHostPrompt,
				cancelPrompt: cancelHostPrompt,
			};

			return { value: implementation };
		}),
	], pluginLoader);
	const archiveSession = async (sessionId: string, archived: boolean, context: Context): Promise<void> => {
		context.abortSignal?.throwIfAborted();
		const metadata = await resolveSession(sessionId, context);
		if (!archived) {
			projectRows = await projects.list();
			const project = projectRows.find(project => project.id === metadata.projectId) ?? await projectForCwd(metadata.cwd);
			if (project?.removed) await projects.restore(project.id);
		}
		await writeSessionArchive(sessionDir, sessionId, archived);
		if (archived) await workers.stopSessionWork(metadata, BACKGROUND_CONTEXT);
	};
	const serverServices = await createExperimentalServerServices({
		...(plugins === undefined ? {} : { plugins }),
		administration,
		projects: {
			selection: () => projects.selection(),
			remember: selection => projects.remember(selection),
			defaultId: defaultProjectId,
			list: () => projects.list(),
			create: async (cwd, name, workspaces, projectId) => {
				const project = projectId === undefined ? await projects.create(cwd, name, workspaces) : await projects.restore(projectId);
				new ProjectTrustStore(getAgentDir()).setMany((project.workspaces ?? [project.cwd]).map(path => ({ path, decision: true })));
				return project;
			},
			update: async (id, name, workspaces) => {
				for (const session of (await listSummaries()).filter(session => session.projectId === id)) {
					await resolveSession(session.sessionId, BACKGROUND_CONTEXT);
				}
				const project = await projects.update(id, name, workspaces);
				new ProjectTrustStore(getAgentDir()).setMany((project.workspaces ?? [project.cwd]).map(path => ({ path, decision: true })));
				return project;
			},
			rename: (id, name) => projects.rename(id, name),
			archive: archiveSession,
			remove: async (id, context) => {
				context.abortSignal?.throwIfAborted();
				for (const session of (await listSummaries()).filter(session => session.projectId === id)) {
					await archiveSession(session.sessionId, true, context);
				}
				await projects.remove(id);
			} },
		list: () => listSummaries(),
		create: async (createOptions, context) => summarize(await createSession(createOptions, context)),
		rename: (sessionId, name) => renameSession(sessionId, name),
		nameAutomatically: async (sessionId, title, context) => {
			context.abortSignal?.throwIfAborted();
			const metadata = await readSession(sessionDir, sessionId);
			if (metadata === undefined || metadata.name !== undefined || metadata.nameSource === "manual") return;
			const name = automaticSessionName(title);
			if (name.length === 0) return;
			context.abortSignal?.throwIfAborted();
			await writeSessionName(sessionDir, sessionId, name, "automatic");
		},
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
					throw new RoutedServerError("invalid", error.message);
				}
				throw error;
			}
			return {
				packagePaths: selected.packagePaths,
				presentationPlugins: createPresentationFacetData(selected.presentationArtifacts) };
		},
		async reloadPresentationPlugins(packagePaths) {
			return createPresentationFacetData(await options.reloadPresentationFacetBundles(packagePaths));
		} }).catch(async (error: unknown) => {
		try { await plugins?.close(); }
		catch (cleanup) { throw new AggregateError([error, cleanup], "Server services startup and cleanup failed"); }
		throw error;
	});
	const titleLifetime = new AbortController();
	const titleContext = withAbortSignal(titleLifetime.signal, BACKGROUND_CONTEXT);
	const stopTitles = workers.onSessionTitle((metadata, title) => {
		void serverServices.nameAutomatically(metadata.id, title, titleContext).catch((error: unknown) => {
			if (!titleLifetime.signal.aborted) console.error("Session title:", error);
		});
	});
	const stopTitleUpdates = (): void => {
		stopTitles();
		titleLifetime.abort(new Error("Server is closing"));
	};
	const host: ServerHost<SessionCatalogMetadata> = {
		serverServices: serverServices.host,
		resolveSession,
		openSession: async (metadata, context) => {
			const selected = await options.resolveSessionPlugins(metadata, undefined, context);
			return workers.openSession(metadata, context, selected.manifestPaths);
		} };
	const socketPath = options.path;
	const closeCatalog = (): Promise<void> => {
		rejectHostReady(new Error("Host closed before Session routing became ready."));
		stopTitleUpdates();
		return serverServices.dispose();
	};
	const server = new Server(host, {
		serverId,
		listeners: [createUnixListener({ path: socketPath, mode: 0o600 }), ...(options.listeners ?? [])],
		onConnectionCountChanged });
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
		activateHostSessions,
		close() {
			closePromise ??= (async () => {
				stopTitleUpdates();
				// Plugin-owned prompts must settle before the server releases Session handles.
				const pluginCleanup = await Promise.allSettled([plugins?.close()]);
				await server.close().catch(() => {});
				const shutdown = await Promise.allSettled([closed]);
				const errors = [...pluginCleanup, ...shutdown].flatMap((result) => result.status === "rejected" ? [result.reason] : []);
				if (errors.length > 0) throw new AggregateError(errors, "Server plugin and transport shutdown failed");
			})();
			return closePromise;
		} };
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
	let stopCoordinator: (() => Promise<void>) | undefined;
	let workers: SessionWorkerManager | undefined;
	let relay: RadiusRelayHost | undefined;
	let released = false;
	let socketDirectory: string | undefined;
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
				presentationArtifacts: built };
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
		): Promise<readonly PluginArtifact[]> => {
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
		const resolvedSocketDirectory = await ensureHostSocketDirectory(directory);
		socketDirectory = resolvedSocketDirectory;
		const socketPath = getUnixSocketPath(serverId, resolvedSocketDirectory);
		const controlPath = join(resolvedSocketDirectory, `control-${serverId}.sock`);
		const serverNonce = randomUUID().replaceAll("-", "").slice(0, 12);
		const serverPath = join(socketDirectory, `server-${serverId}-${serverNonce}.sock`);
		startupLease = await ensureCoordinator(socketPath, controlPath);
		stopCoordinator = startupLease.stop;
		coordinator = new CoordinatorConnection({ controlPath, endpoint: serverPath });
		const sessionDir = resolveSessionDirectory(options.sessionDir);
		workers = new SessionWorkerManager(coordinator, sessionDir, workerModel, (count) =>
			lifetime.setWorkerCount(count),
		);
		backend = await startServerBackend(
			{
				path: serverPath,
				serverId,
				serverPluginManifestPaths: defaultPluginSelection.manifestPaths,
				sessionDir: options.sessionDir,
				...(options.listeners === undefined ? {} : { listeners: options.listeners }),
				resolveSessionPlugins,
				removeSessionPlugins,
				reloadPresentationFacetBundles,
				listServerPluginPackages: () => defaultPluginSelection.packagePaths,
				setServerPluginPackages },
			workers,
			(count) => lifetime.setConnectionCount(count),
		);
		await coordinator.connect();
		startupLease.close();
		startupLease = undefined;
		await workers.discover(coordinator.peerIds);
		await backend.refreshSessions();
		backend.activateHostSessions();
		relay = new RadiusRelayHost({
			serverId,
			server: backend.server,
			auth: new RadiusRelayAuthResolver(options.relayAuth),
			onStatus: options.onRelayStatus });
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
							if (!activeCoordinator.wasReplaced) await stopCoordinator?.();
							if (socketDirectory !== undefined) await removeEmptyRelocatedSocketDirectory(socketDirectory);
						}
					}
				})();
				return closePromise;
			} };
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
		// Unlink runs in the coordinator. Remove the hash directory only after that exit.
		const stopped = await Promise.allSettled([coordinator?.wasReplaced ? undefined : stopCoordinator?.()]);
		const removed = await Promise.allSettled([
			socketDirectory === undefined ? undefined : removeEmptyRelocatedSocketDirectory(socketDirectory),
		]);
		cleanup.push(...stopped, ...removed);
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
			keepAlive: true });
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

/**
 * Close after SIGINT or SIGTERM.
 *
 * The listener stays installed. `process.once` removes it as soon as the signal
 * arrives, and `signal-exit` (loaded by proper-lockfile) then re-sends SIGTERM
 * and kills the process before socket cleanup. Removing the listener after
 * `close` leaves the same window. Callers exit immediately after this returns:
 * once the loop drains, Node drops the signal watchers and restores the default
 * action, and a SIGTERM in that gap becomes the process's death signal.
 *
 * A second SIGINT while `close` is still running force-exits. A second SIGTERM
 * does not: that is the re-send described above.
 */
export async function closeWhenSignaled(
	closed: Promise<void>,
	close: () => Promise<void>,
	arm?: (finish: () => void) => void,
): Promise<void> {
	await closeAfterSignal(closed, close, arm);
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
		...workerModel });
	await closeWhenSignaled(runtime.closed, () => runtime.close());
	process.exit(process.exitCode ?? 0);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The accepted prompt's operation, or why the session refused it. */
function readSubmission(value: unknown): { readonly operationId: string } | { readonly refusal: { code: string; message: string } } {
	if (typeof value !== "object" || value === null) throw new Error("Invalid prompt admission receipt.");
	const response = value as { accepted?: unknown; operationId?: unknown; error?: { code?: unknown; message?: unknown } | null };
	if (response.accepted === true && typeof response.operationId === "string") {
		return { operationId: response.operationId };
	}
	if (response.accepted !== false || typeof response.error?.code !== "string" || typeof response.error.message !== "string")
		throw new Error("Invalid prompt admission receipt.");
	return { refusal: { code: response.error.code, message: response.error.message } };
}

/** Validate the actual settlement; a malformed receipt must never look successful. */
function readSettlement(value: unknown): AgentPromptResult {
	if (typeof value === "object" && value !== null) {
		if ("status" in value && value.status === "done" && "text" in value && typeof value.text === "string")
			return { status: "done", text: value.text, reason: null };
		if ("status" in value && value.status === "unanswered" && "reason" in value && typeof value.reason === "string")
			return { status: "unanswered", text: null, reason: value.reason };
	}
	throw new Error("Invalid prompt settlement receipt.");
}

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "server") throw new Error("Server entrypoint requires an internal server invocation");
	void runServerProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
