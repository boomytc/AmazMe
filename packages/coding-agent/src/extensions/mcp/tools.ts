/** SDK tool registration and presentation; transport results and metadata are shared with Durable. */
import type { McpRequestOptions, Tool as McpTool } from "@amazme/mcp";
import { Container, Spacer, Text } from "@amazme/tui";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolNamespace, ToolRenderers } from "../../core/extensions/types.ts";
import { formatToolCallWithArgs, getTextOutput, replaceTabs } from "../../core/tools/render-utils.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import type { McpExposure } from "./config.ts";
import {
	convertMcpResult,
	createMcpToolMetadata,
	type McpToolCaller,
	type McpToolDetails,
} from "../../core/mcp/results.ts";
export {
	convertMcpResult,
	createMcpResultSchema,
	createMcpToolName,
	limitMcpContent,
	MCP_OUTPUT_MAX_BYTES,
	READ_MCP_RESOURCE_TOOL,
	saveToTempFile,
	toModelContent,
	toToolExposure,
} from "../../core/mcp/results.ts";
export type { ConvertMcpResultOptions, McpOutputSaver, McpToolCaller, McpToolDetails } from "../../core/mcp/results.ts";
const OUTPUT_PREVIEW_LINES = 5;

export function createMcpToolDefinition(options: {
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	namespace: ToolNamespace;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
	/** Whether `read_mcp_resource` can read the server's resources. */
	readableResources?: () => boolean;
}): ToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const metadata = createMcpToolMetadata(server, tool, options.name, options.exposure, options.namespace);
	const label = metadata.label;
	return {
		...metadata,
		...createMcpToolRenderers(label),
		async execute(_toolCallId, params, signal, onUpdate) {
			const client = await options.getClient();
			const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
				signal,
				timeoutMs: options.timeoutMs,
				onProgress: (progress) => {
					const total = progress.total === undefined ? "" : `/${progress.total}`;
					const text = progress.message ?? `Progress ${progress.progress}${total}`;
					onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
				},
			});
			return convertMcpResult(server, tool.name, result, { readableResources: options.readableResources?.() });
		},
	};
}

/** Renderers of calls to an MCP tool, labeled `server/tool`, also used before the tool is registered. */
export function createMcpToolRenderers(label: string): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatToolCallWithArgs(label, args, theme, context.expanded));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			const output = getTextOutput(result, context.showImages).trim();
			if (!output) return component;
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: MCP results are often one long JSON line.
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) =>
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					}),
				);
				const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
			return component;
		},
	};
}
