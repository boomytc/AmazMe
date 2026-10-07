import { type Context, defineService, type JsonValue, type ReplicatedState } from "@amazme/chord";

/** Server-built plugin generations available to presentations. */
export interface PresentationPlugins {
	prepareSession(
		request: { readonly sessionId: string; readonly packagePaths: readonly string[] | null },
		context: Context,
	): Promise<JsonValue>;
	reload(context: Context): Promise<JsonValue>;
}

export const PresentationPlugins = defineService<PresentationPlugins>("amazme.presentation-plugins");

/** Plugin facets hosted in the currently attached Session worker. */
export interface SessionPlugins {
	reload(context: Context): Promise<void>;
}

export const SessionPlugins = defineService<SessionPlugins>("amazme.session-plugins");

/** One MCP server as the effective configuration defines it. */
export interface McpServerSummary {
	name: string;
	/** One line describing the entry: its command line, or its URL. */
	detail: string;
	scope: "global" | "project" | "extension";
	enabled: boolean;
	/** `codemode`, `deferred`, `direct`, or `hidden`. */
	exposure: string;
	/** A `mcp.json` entry can be changed; one an extension registered cannot. */
	editable: boolean;
}

export interface McpServerPatch {
	readonly enabled?: boolean;
	readonly exposure?: string;
}

export interface PluginsState {
	revision: number;
	/** The server's default plugin packages: a Session that selects none loads these. */
	packages: string[];
	mcp: {
		servers: McpServerSummary[];
		errors: string[];
		globalPath: string;
		projectPath?: string;
	};
}

/**
 * The host's plugin configuration: the plugin packages a Session loads, and the MCP servers the
 * coding agent's own tools read. The experimental host builds plugin packages; MCP entries are
 * configuration for the CLI and TUI, which connect servers themselves.
 */
export interface Plugins {
	readonly state: ReplicatedState<PluginsState>;
	/** Replace the server's default plugin package selection. Every package is built before it lands. */
	setPackages(paths: readonly string[], context: Context): Promise<void>;
	setMcpServer(name: string, patch: McpServerPatch, context: Context): Promise<void>;
	/** Add or replace an MCP server in the agent's `mcp.json`; `json` is the server's entry. */
	addMcpServer(name: string, json: string, context: Context): Promise<void>;
	removeMcpServer(name: string, context: Context): Promise<void>;
	reload(context: Context): Promise<void>;
}

export const Plugins = defineService<Plugins>("amazme.plugins");
