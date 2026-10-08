import { join } from "node:path";
import type { Context } from "@amazme/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { getAgentDir } from "../config.ts";
import type { McpManagement, McpManagementState } from "../core/mcp/management.ts";
import { getMcpToolExposure, validateMcpServerConfig } from "../core/mcp-servers.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	loadMcpConfig,
	updateMcpServerConfig,
	type LoadedMcpConfig,
	type McpServerConfigPatch,
	type McpServerEntry,
} from "../extensions/mcp/config.ts";
import type * as McpRuntime from "../extensions/mcp/runtime.ts";
import type { McpServerConnection } from "../extensions/mcp/runtime.ts";
import { publicMcpError as publicError } from "../core/mcp/errors.ts";
import { McpLogin } from "./mcp-login.ts";

export interface McpServerSlot {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	ready?: Promise<void>;
	/** Every replacement waits for the previous transport's cleanup. */
	closing?: Promise<void>;
}

export interface McpManagerOptions {
	cwd: string;
	settings: SettingsManager;
	models: ModelRuntime;
	disabled?: boolean;
	report(error: unknown): void;
}

export class McpManager implements McpManagement {
	readonly #options: McpManagerOptions;
	readonly #runtime: typeof McpRuntime;
	readonly #credentials: McpRuntime.McpOAuthCredentialStore;
	readonly #log: McpRuntime.McpServerLog;
	readonly #slots = new Map<string, McpServerSlot>();
	readonly #listeners = new Set<() => void>();
	readonly #queues = new Map<string, Promise<void>>();
	readonly #shutdown = new AbortController();
	#config: LoadedMcpConfig;
	#revision = 0;
	#closing: Promise<void> | undefined;
	readonly #login: McpLogin;

	constructor(options: McpManagerOptions, runtime: typeof McpRuntime) {
		this.#options = options;
		this.#runtime = runtime;
		this.#credentials = new runtime.McpOAuthCredentialStore();
		this.#log = new runtime.McpServerLog(join(getAgentDir(), "mcp.log"));
		this.#config = this.#read();
		this.#login = new McpLogin({
			runtime,
			credentials: this.#credentials,
			signal: this.#shutdown.signal,
			connection: (name) => {
				const slot = this.#slot(name);
				return slot.entry.config.enabled === false ? undefined : slot.connection;
			},
			reconnect: (name, context) => this.#replace(name, context, false),
			publish: () => this.#publish(),
		});
	}

	#read(): LoadedMcpConfig {
		return this.#options.disabled
			? { servers: [], errors: [] }
			: loadMcpConfig({
					agentDir: getAgentDir(),
					cwd: this.#options.cwd,
					projectTrusted: this.#options.settings.isProjectTrusted(),
				});
	}

	get autoEnableCodemode(): boolean {
		return this.#config.autoEnableCodemode !== false;
	}
	get servers(): readonly McpServerSlot[] {
		return [...this.#slots.values()];
	}
	get closed(): boolean {
		return this.#shutdown.signal.aborted;
	}

	snapshot(): McpManagementState {
		return {
			revision: this.#revision,
			disabled: this.#options.disabled === true,
			canOverrideProject: this.#config.projectConfig !== undefined,
			errors: this.#config.errors.map(publicError),
			servers: this.servers.map(({ entry, connection }) => ({
				name: entry.name,
				enabled: entry.config.enabled !== false,
				exposure: entry.config.exposure ?? "codemode",
				state:
					entry.config.enabled === false
						? "disabled"
						: (connection?.state ?? (this.#queues.has(entry.name) ? "connecting" : "disconnected")),
				transport: "url" in entry.config ? "http" : "stdio",
				tools: connection?.tools.length ?? 0,
				resources: connection?.resources.length ?? 0,
				templates: connection?.resourceTemplates.length ?? 0,
				scope: entry.override !== undefined || entry.scope === "project" ? "project" : "global",
				canLogin: entry.config.enabled !== false && connection?.oauthUrl !== undefined,
				error: connection?.error ? publicError(connection.error) : null,
			})),
			login: this.#login.snapshot(),
		};
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#publish(): void {
		if (this.closed) return;
		this.#revision++;
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch (error) {
				this.#options.report(error);
			}
		}
	}
	#live(context: Context): void {
		if (this.closed) throw new Error("MCP manager is closed");
		context.abortSignal?.throwIfAborted();
	}
	#slot(name: string): McpServerSlot {
		const slot = this.#slots.get(name);
		if (!slot) throw new Error(`Unknown MCP server ${name}`);
		return slot;
	}

	#serial(name: string, action: () => Promise<void>): Promise<void> {
		const prior = this.#queues.get(name) ?? Promise.resolve();
		const operation = prior.catch(() => {}).then(action);
		const barrier = operation.catch(() => {});
		this.#queues.set(name, barrier);
		void barrier.then(() => {
			if (this.#queues.get(name) === barrier) {
				this.#queues.delete(name);
				this.#publish();
			}
		});
		return operation;
	}

	async #detach(slot: McpServerSlot, cancelLogin = true): Promise<void> {
		if (cancelLogin) this.#login.cancelServer(slot.entry.name);
		const connection = slot.connection;
		slot.connection = undefined;
		this.#publish();
		slot.closing ??= connection?.close();
		await slot.closing;
		slot.closing = undefined;
		await slot.ready;
		slot.ready = undefined;
	}

	#connect(slot: McpServerSlot): Promise<void> {
		if (this.closed || slot.entry.config.enabled === false) return Promise.resolve();
		const entry = slot.entry;
		const connection = new this.#runtime.McpServerConnection({
			entry,
			cwd: this.#options.cwd,
			createTransport: this.#runtime.createDefaultTransport,
			credentials: this.#credentials,
			log: this.#log,
			providerToken: async (provider) => (await this.#options.models.getAuth(provider))?.auth.apiKey,
			authRequiredMessage: () =>
				`MCP server ${entry.name} requires sign-in. Open MCP management to sign in or configure its provider credentials.`,
			onTools: (current) => {
				if (slot.connection === current) this.#publish();
			},
			onChange: (current) => {
				if (slot.connection === current) this.#publish();
			},
		});
		slot.connection = connection;
		this.#publish();
		const ready = connection.getClient().then(
			() => {},
			(error) => {
				if (!this.closed && slot.connection === connection) this.#options.report(new Error(publicError(error)));
			},
		);
		slot.ready = ready;
		return ready;
	}

	async open(): Promise<void> {
		await this.reload(BACKGROUND_CONTEXT);
	}

	async reload(context: Context): Promise<void> {
		this.#live(context);
		const config = this.#read();
		const entries = new Map(config.servers.map((entry) => [entry.name, entry]));
		this.#config = config;
		for (const error of config.errors) this.#options.report(new Error(publicError(error)));
		await Promise.all(
			[...new Set([...this.#slots.keys(), ...entries.keys()])].map((name) =>
				this.#serial(name, async () => {
					this.#live(context);
					const entry = entries.get(name);
					let slot = this.#slots.get(name);
					if (
						slot &&
						entry &&
						JSON.stringify(slot.entry) === JSON.stringify(entry) &&
						(entry.config.enabled === false ? slot.connection === undefined : slot.connection !== undefined)
					)
						return;
					if (slot) await this.#detach(slot);
					this.#live(context);
					if (!entry) this.#slots.delete(name);
					else {
						slot = { entry };
						this.#slots.set(name, slot);
						await this.#connect(slot);
					}
				}),
			),
		);
		this.#publish();
	}

	reconnect(name: string, context: Context): Promise<void> {
		return this.#replace(name, context, true);
	}
	#replace(name: string, context: Context, cancelLogin: boolean): Promise<void> {
		return this.#serial(name, async () => {
			this.#live(context);
			const slot = this.#slot(name);
			if (slot.entry.config.enabled === false) throw new Error(`MCP server ${name} is disabled`);
			await this.#detach(slot, cancelLogin);
			this.#live(context);
			await awaitWithContext(this.#connect(slot), context);
			if (slot.connection?.state === "failed" || slot.connection?.state === "needs-auth")
				throw new Error(publicError(slot.connection.error ?? `MCP server ${name} is not connected`));
		});
	}

	async configure(name: string, patch: McpServerConfigPatch, inProject: boolean, context: Context): Promise<void> {
		if (
			typeof inProject !== "boolean" ||
			patch === null ||
			typeof patch !== "object" ||
			Array.isArray(patch) ||
			Object.keys(patch).some((key) => key !== "enabled" && key !== "exposure")
		)
			throw new TypeError("Invalid MCP configuration change");
		const change = {
			...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
			...(patch.exposure === undefined ? {} : { exposure: patch.exposure }),
		};
		await this.#serial(name, async () => {
			this.#live(context);
			const slot = this.#slot(name);
			const config = validateMcpServerConfig(name, { ...slot.entry.config, ...change });
			if (typeof config === "string") throw new Error(config);
			const path = inProject ? this.#config.projectConfig : (slot.entry.override ?? slot.entry.source);
			if (!path) throw new Error("Project MCP configuration requires project trust");
			updateMcpServerConfig(path, name, change, { override: inProject || slot.entry.override !== undefined });
			slot.entry = { ...slot.entry, config, ...(inProject ? { override: path } : {}) };
			this.#publish();
			// The file is authoritative; reload after the write instead of inventing a second merged configuration.
		});
		await this.reload(BACKGROUND_CONTEXT);
	}

	async callConnection(name: string, tool: string, context: Context): Promise<McpServerConnection> {
		this.#live(context);
		for (;;) {
			const pending = this.#queues.get(name);
			if (!pending) break;
			await awaitWithContext(pending, context);
			if (this.#queues.get(name) === pending) break;
		}
		this.#live(context);
		const slot = this.#slot(name);
		if (slot.entry.config.enabled === false || getMcpToolExposure(slot.entry.config, tool) === "hidden")
			throw new Error(`MCP tool ${name}/${tool} is disabled`);
		if (!slot.connection) throw new Error(`MCP server ${name} is not connected`);
		return slot.connection;
	}

	startLogin(name: string, context: Context): Promise<string> {
		this.#live(context);
		return this.#login.startLogin(name, context);
	}
	submitRedirect(id: string, url: string, context: Context): Promise<boolean> {
		this.#live(context);
		return this.#login.submitRedirect(id, url, context);
	}
	cancelLogin(id: string): Promise<boolean> {
		return this.#login.cancelLogin(id);
	}

	close(): Promise<void> {
		return (this.#closing ??= (async () => {
			this.#shutdown.abort();
			await Promise.allSettled([...this.#slots.values()].map((slot) => this.#detach(slot)));
			await Promise.allSettled(this.#queues.values());
			await this.#login.close();
			this.#listeners.clear();
		})());
	}
}
