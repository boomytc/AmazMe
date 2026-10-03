import type { JsonSchema, TextContent } from "@amazme/ai";
import type { AgentTool } from "@amazme/agent";

export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface McpToolResult {
  content: TextContent[];
  isError?: boolean;
}

/** Caller-supplied client. This package does not open a transport. */
export interface McpClient {
  listTools(): readonly McpToolListing[];
  callTool(name: string, args: unknown): Promise<McpToolResult>;
}

/**
 * Append MCP tools after the coding tools, in the same array.
 * No client, or a client with nothing to list, returns `tools` unchanged.
 * `execute` calls `client.callTool`. Hooks stay on the agent loop.
 */
export function appendMcpTools(tools: AgentTool[], client?: McpClient): AgentTool[] {
  if (!client) return tools;
  const listed = client.listTools();
  if (listed.length === 0) return tools;
  return [...tools, ...listed.map((tool) => mcpAgentTool(client, tool))];
}

function mcpAgentTool(client: McpClient, listed: McpToolListing): AgentTool {
  return {
    name: listed.name,
    description: listed.description,
    parameters: listed.inputSchema,
    replay: "never",
    execute(args) {
      return client.callTool(listed.name, args);
    },
  };
}
