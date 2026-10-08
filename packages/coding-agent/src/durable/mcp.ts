import { copyJson } from "@amazme/chord";
import type { Context } from "@amazme/chord";
import {
	defineExtension,
	defineTool,
	AgentDoc,
	type AgentState,
	type Conversation,
	type Registry,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@amazme/durable";
import { getAgentDir } from "../config.ts";
import { CODEMODE_TOOL_NAME } from "../core/codemode/declarations.ts";
import { createMcpResourceTools } from "../core/mcp/resources.ts";
import { createMcpToolMetadata, createMcpToolName, convertMcpResult } from "../core/mcp/results.ts";
import {
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
	getMcpToolExposure,
	mcpNamespace,
} from "../core/mcp-servers.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../core/tool-search.ts";
import { loadMcpConfig, type McpServerEntry } from "../extensions/mcp/config.ts";
import type { McpServerConnection } from "../extensions/mcp/runtime.ts";

type Selection = NonNullable<AgentState["tools"]>;
const RESOURCE_NAMES = [LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL];

export interface DurableMcp {
	selection(value: Selection): Selection;
	close(): Promise<void>;
}

/** Apply the application selector to an existing conversation without replacing its branch-specific choices. */
export async function applyDurableMcpSelection(mcp: DurableMcp, conversation: Conversation, context: Context): Promise<void> {
	await conversation.commit(async tx => {
		const state = await tx.doc(AgentDoc, conversation.id);
		if (state.tools === undefined) return;
		const selection = mcp.selection(state.tools);
		if (JSON.stringify(selection) !== JSON.stringify(state.tools)) state.tools = selection;
	}, context);
}

/** One session owns the same connection implementation used by the SDK; calls use ordinary persistent tools. */
export async function openDurableMcp(options: {
	registry: Registry;
	cwd: string;
	settings: SettingsManager;
	models: ModelRuntime;
	disabled?: boolean;
	report(error: unknown): void;
}): Promise<DurableMcp> {
	const config = options.disabled
		? { servers: [], errors: [] }
		: loadMcpConfig({
				agentDir: getAgentDir(),
				cwd: options.cwd,
				projectTrusted: options.settings.isProjectTrusted(),
			});
	for (const error of config.errors) options.report(new Error(`MCP configuration: ${error}`));
	const entries = config.servers.filter((entry) => entry.config.enabled !== false);
	if (entries.length === 0) return { selection: (value) => value, close: async () => {} };
	const runtime = await import("../extensions/mcp/runtime.ts");
	const credentials = new runtime.McpOAuthCredentialStore();
	const log = new runtime.McpServerLog(`${getAgentDir()}/mcp.log`);
	const connections: McpServerConnection[] = [];
	const ready = new Map<McpServerConnection, Promise<void>>();
	const reported = new Map<string, string>();
	let closed = false;
	let closing: Promise<void> | undefined;
	const exposures = (entry: McpServerEntry) =>
		new Set([entry.config.exposure ?? "codemode", ...Object.values(entry.config.toolExposure ?? {})]);
	const codemode = config.autoEnableCodemode !== false && entries.some((entry) => exposures(entry).has("codemode"));
	const search = entries.some((entry) => exposures(entry).has("deferred"));
	const scripts = options.registry.snapshot().extension("codemode");
	if (scripts)
		options.registry.install({
			...scripts,
			tools: scripts.tools?.map((tool) => ({
				...tool,
				defaultActive:
					(tool.name === CODEMODE_TOOL_NAME && codemode) ||
					(tool.name === TOOL_SEARCH_TOOL_NAME && search) ||
					tool.defaultActive,
			})),
		});
	const publish = () => {
		if (closed) return;
		const tools: ToolRegistration[] = [];
		for (const connection of connections) {
			const counts = new Map<string, number>();
			for (const tool of connection.tools) {
				const name = createMcpToolName(connection.name, tool.name);
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
			for (const tool of connection.tools) {
				const name = createMcpToolName(connection.name, tool.name, (candidate) => (counts.get(candidate) ?? 0) > 1);
				const exposure = getMcpToolExposure(connection.entry.config, tool.name);
				const metadata = createMcpToolMetadata(connection.name, tool, name, exposure, {
					name: mcpNamespace(connection.name),
					description: connection.entry.config.description,
					instructions: connection.instructions,
				});
				tools.push(
					defineTool({
						...metadata,
						defaultActive: exposure === "direct",
						async execute(params, api, context) {
							const result = await connection.callTool(tool.name, params as Record<string, unknown>, {
								signal: context.abortSignal,
								timeoutMs: connection.timeoutMs,
								onProgress: (progress) => {
									const total = progress.total === undefined ? "" : `/${progress.total}`;
									api.output(`${progress.message ?? `Progress ${progress.progress}${total}`}\n`);
								},
							});
							return copyJson(
								await convertMcpResult(connection.name, tool.name, result, {
									readableResources: connection.hasResources,
								}),
								{ omitUndefinedProperties: true },
							) as ToolExecutionResult;
						},
					}),
				);
			}
		}
		const visible = connections.filter(
			(connection) => connection.hasResources && connection.entry.config.exposure !== "hidden",
		);
		const resourceExposure = visible.some((connection) => connection.entry.config.exposure === "direct")
			? "direct"
			: "deferred";
		for (const { execute, ...metadata } of visible.length === 0
			? []
			: createMcpResourceTools({
					exposure: resourceExposure,
					servers: () =>
						connections.filter(
							(connection) => connection.hasResources && connection.entry.config.exposure !== "hidden",
						),
				})) {
			tools.push(
				defineTool({
					...metadata,
					defaultActive: resourceExposure === "direct",
					async execute(params, _api, context) {
						return copyJson(await execute(params, context.abortSignal), {
							omitUndefinedProperties: true,
						}) as ToolExecutionResult;
					},
				}),
			);
		}
		options.registry.install(defineExtension({ name: "mcp", tools }));
	};
	try {
		for (const entry of entries) {
			const authRequiredMessage = () => {
					const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
					return provider
						? `MCP server "${entry.name}" needs credentials for provider "${provider}". Configure that provider and reopen the session.`
						: `MCP server "${entry.name}" requires sign-in. Run amazme mcp login ${entry.name}, then reopen the session.`;
			};
			const connection = new runtime.McpServerConnection({
				entry,
				cwd: options.cwd,
				createTransport: runtime.createDefaultTransport,
				credentials,
				log,
				authRequiredMessage,
				providerToken: async (provider) => (await options.models.getAuth(provider))?.auth.apiKey,
				onTools: publish,
				onChange: (connection) => {
					if (closed) return;
					publish();
					if (connection.state !== "failed" && connection.state !== "needs-auth") return;
					const message = `${connection.name}: ${connection.error ?? authRequiredMessage()}`;
					if (reported.get(connection.name) === message) return;
					reported.set(connection.name, message);
					options.report(new Error(message));
				},
			});
			connections.push(connection);
		}
		publish();
		for (const connection of connections)
			ready.set(
				connection,
				connection.getClient().then(
					() => {},
					() => {},
				),
			);
		// A task fixes its registry for its entire phase, so discovery must finish before opening the Harness.
		await Promise.all(ready.values());
	} catch (error) {
		closed = true;
		await Promise.allSettled(connections.map((connection) => connection.close()));
		throw error;
	}
	return {
		selection(value) {
			if (
				Array.isArray(value) ||
				value.allow === undefined ||
				value.allow.length === 0 ||
				value.allow.some((name) => name.startsWith("mcp__"))
			)
				return value;
			return { ...value, only: value.only ?? [...value.allow], allow: [...value.allow, "mcp__*", ...RESOURCE_NAMES] };
		},
		close() {
			return (closing ??= (async () => {
				closed = true;
				await Promise.all(connections.map((connection) => connection.close()));
				await Promise.all(ready.values());
			})());
		},
	};
}
