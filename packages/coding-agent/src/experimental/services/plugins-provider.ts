import { join } from "node:path";
import { type Context, type MutableReplicatedState } from "@amazme/chord";
import { mcpNamespace, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	type McpServerConfig,
	type McpServerEntry,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../../extensions/mcp/config.ts";
import type { McpServerPatch, McpServerSummary, PluginsState } from "./plugins.ts";

export interface PluginsServiceOptions {
	readonly agentDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	/** The server's default plugin package selection, read and replaced through the host. */
	readonly packages: {
		readonly list: () => readonly string[];
		readonly set: (paths: readonly string[]) => Promise<readonly string[]>;
	};
}

function detailOf(config: McpServerConfig): string {
	if ("command" in config) return [config.command, ...(config.args ?? [])].join(" ");
	return config.url;
}

function summarize(entry: McpServerEntry): McpServerSummary {
	return {
		name: entry.name,
		detail: detailOf(entry.config),
		scope: entry.scope ?? "global",
		enabled: entry.config.enabled !== false,
		exposure: entry.config.exposure ?? "codemode",
		editable: entry.scope !== "extension",
	};
}

/**
 * The plugin management surface over the server's plugin package profile and the coding agent's
 * `mcp.json`. MCP entries are validated and written with the same helpers the CLI and TUI use, so
 * the three surfaces agree on one file format.
 */
export function createPluginsService(
	options: PluginsServiceOptions,
	createState: (initial: PluginsState) => MutableReplicatedState<PluginsState>,
) {
	const globalPath = join(options.agentDir, "mcp.json");
	const state = createState({
		revision: 0,
		packages: [],
		mcp: { servers: [], errors: [], globalPath },
	});
	const loaded = () => loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted: options.projectTrusted });
	const entryOf = (name: string): McpServerEntry => {
		const entry = loaded().servers.find((candidate) => candidate.name === name);
		if (entry === undefined) throw new Error(`Unknown MCP server: ${name}`);
		if (entry.scope === "extension") throw new Error(`MCP server ${name} is registered by an extension and cannot be changed`);
		return entry;
	};
	/** The file an edit belongs in: a project override wins, then the file that defines the entry. */
	const fileFor = (entry: McpServerEntry): { readonly path: string; readonly override: boolean } => {
		if (entry.override !== undefined) return { path: entry.override, override: true };
		if (entry.scope === "project") return { path: entry.source, override: false };
		return { path: globalPath, override: false };
	};
	const reload = (context: Context): void => {
		const config = loaded();
		state.change(context, (draft) => {
			draft.revision += 1;
			draft.packages = [...options.packages.list()];
			draft.mcp = {
				servers: config.servers.map(summarize),
				errors: [...config.errors],
				globalPath,
				...(config.projectConfig === undefined ? {} : { projectPath: config.projectConfig }),
			};
		});
	};

	return {
		service: {
			state,
			async setPackages(paths: readonly string[], context: Context): Promise<void> {
				// The host builds every package first; a path that cannot build is rejected here.
				await options.packages.set(paths);
				reload(context);
			},
			async setMcpServer(name: string, patch: McpServerPatch, context: Context): Promise<void> {
				if (patch.exposure !== undefined && !["codemode", "deferred", "direct", "hidden"].includes(patch.exposure)) {
					throw new Error(`Unknown MCP exposure: ${patch.exposure}`);
				}
				const entry = entryOf(name);
				const { path, override } = fileFor(entry);
				updateMcpServerConfig(
					path,
					name,
					{
						...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
						...(patch.exposure === undefined ? {} : { exposure: patch.exposure as McpServerConfig["exposure"] }),
					},
					{ override },
				);
				reload(context);
			},
			async addMcpServer(name: string, json: string, context: Context): Promise<void> {
				if (name.trim().length === 0) throw new Error("An MCP server needs a name");
				let parsed: unknown;
				try {
					parsed = JSON.parse(json);
				} catch (error) {
					throw new Error(`MCP server entry is not valid JSON: ${error instanceof Error ? error.message : error}`);
				}
				const config = validateMcpServerConfig(name, parsed);
				if (typeof config === "string") throw new Error(config);
				const existing = loaded().servers.find(
					(candidate) => candidate.name !== name && mcpNamespace(candidate.name) === mcpNamespace(name),
				);
				if (existing !== undefined) throw new Error(`MCP server ${name} conflicts with ${existing.name}`);
				addMcpServerConfig(globalPath, name, config);
				reload(context);
			},
			async removeMcpServer(name: string, context: Context): Promise<void> {
				const entry = entryOf(name);
				const { path } = fileFor(entry);
				if (!removeMcpServerConfig(path, name)) throw new Error(`MCP server ${name} is not defined in ${path}`);
				reload(context);
			},
			async reload(context: Context): Promise<void> {
				reload(context);
			},
		},
		/** Publish the effective configuration; the host calls this once the service is reachable. */
		reload,
	};
}
