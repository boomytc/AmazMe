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
import type { McpServerEntry } from "../extensions/mcp/config.ts";
import { McpManager } from "./mcp-manager.ts";
import type { McpManagement } from "../core/mcp/management.ts";
import type { McpServerConnection } from "../extensions/mcp/runtime.ts";

type Selection = NonNullable<AgentState["tools"]>;
const RESOURCE_NAMES = [LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL];

export interface DurableMcp {
	readonly management: McpManagement;
	selection(value: Selection): Selection;
	close(): Promise<void>;
}

/** Apply the application selector to an existing conversation without replacing its branch-specific choices. */
export async function applyDurableMcpSelection(
	mcp: DurableMcp,
	conversation: Conversation,
	context: Context,
): Promise<void> {
	await conversation.commit(async (tx) => {
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
	const runtime = await import("../extensions/mcp/runtime.ts");
	const manager = new McpManager(options, runtime);
	const scripts = options.registry.snapshot().extension("codemode");
	const exposures = (entry: McpServerEntry) =>
		new Set([entry.config.exposure ?? "codemode", ...Object.values(entry.config.toolExposure ?? {})]);
	const publish = () => {
		if (manager.closed) return;
		const servers = manager.servers.filter(
			(slot) => slot.entry.config.enabled !== false && slot.connection !== undefined,
		);
		if (scripts)
			options.registry.install({
				...scripts,
				tools: scripts.tools?.map((tool) => ({
					...tool,
					defaultActive:
						tool.defaultActive ||
						(tool.name === CODEMODE_TOOL_NAME &&
							manager.autoEnableCodemode &&
							servers.some((slot) => exposures(slot.entry).has("codemode"))) ||
						(tool.name === TOOL_SEARCH_TOOL_NAME && servers.some((slot) => exposures(slot.entry).has("deferred"))),
				})),
			});
		const tools: ToolRegistration[] = [];
		for (const { entry, connection } of servers) {
			if (!connection) continue;
			const counts = new Map<string, number>();
			for (const tool of new Map(connection.tools.map((tool) => [tool.name, tool])).values()) {
				const name = createMcpToolName(connection.name, tool.name);
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
			for (const tool of new Map(connection.tools.map((tool) => [tool.name, tool])).values()) {
				const name = createMcpToolName(connection.name, tool.name, (candidate) => (counts.get(candidate) ?? 0) > 1);
				const exposure = getMcpToolExposure(entry.config, tool.name);
				const metadata = createMcpToolMetadata(connection.name, tool, name, exposure, {
					name: mcpNamespace(connection.name),
					description: entry.config.description,
					instructions: connection.instructions,
				});
				tools.push(
					defineTool({
						...metadata,
						defaultActive: exposure === "direct",
						async execute(params, api, context) {
							const current = await manager.callConnection(connection.name, tool.name, context);
							const result = await current.callTool(tool.name, params as Record<string, unknown>, {
								signal: context.abortSignal,
								timeoutMs: current.timeoutMs,
								onProgress: (progress) => {
									const total = progress.total === undefined ? "" : `/${progress.total}`;
									api.output(`${progress.message ?? `Progress ${progress.progress}${total}`}\n`);
								},
							});
							return copyJson(
								await convertMcpResult(connection.name, tool.name, result, {
									readableResources: current.hasResources,
								}),
								{ omitUndefinedProperties: true },
							) as ToolExecutionResult;
						},
					}),
				);
			}
		}
		const resourceServers = () =>
			manager.servers.flatMap((slot) =>
				slot.entry.config.enabled !== false && slot.entry.config.exposure !== "hidden" && slot.connection?.hasResources
					? [slot.connection]
					: [],
			);
		const visible = servers.filter((slot) => slot.entry.config.exposure !== "hidden" && slot.connection?.hasResources);
		const resourceExposure = visible.some((slot) => slot.entry.config.exposure === "direct") ? "direct" : "deferred";
		for (const { execute, ...metadata } of visible.length === 0
			? []
			: createMcpResourceTools({
					exposure: resourceExposure,
					servers: resourceServers,
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
	const unsubscribe = manager.subscribe(publish);
	try {
		await manager.open();
		publish();
	} catch (error) {
		unsubscribe();
		await manager.close();
		throw error;
	}
	return {
		management: manager,
		selection(value) {
			if (
				manager.servers.length === 0 ||
				Array.isArray(value) ||
				value.allow === undefined ||
				value.allow.length === 0 ||
				value.allow.some((name) => name.startsWith("mcp__"))
			)
				return value;
			return { ...value, only: value.only ?? [...value.allow], allow: [...value.allow, "mcp__*", ...RESOURCE_NAMES] };
		},
		close() {
			unsubscribe();
			return manager.close();
		},
	};
}
