/** SDK registrations for the shared MCP resource capabilities. */
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { McpExposure } from "../../core/mcp-servers.ts";
import type { McpToolDetails } from "../../core/mcp/results.ts";
import { createMcpResourceTools } from "../../core/mcp/resources.ts";
import type { McpResourceServer } from "../../core/mcp/contracts.ts";
export { isMcpAppResource } from "../../core/mcp/contracts.ts";
export type { McpResourceServer } from "../../core/mcp/contracts.ts";
export {
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "../../core/mcp-servers.ts";

export function createMcpResourceToolDefinitions(options: {
	exposure: McpExposure;
	servers: () => readonly McpResourceServer[];
}): ToolDefinition<TSchema, McpToolDetails>[] {
	return createMcpResourceTools(options).map(({ execute, ...metadata }) => ({
		...metadata,
		execute: (_toolCallId, params, signal) => execute(params, signal),
	}));
}
