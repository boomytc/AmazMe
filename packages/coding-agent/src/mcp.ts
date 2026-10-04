import type { JsonSchema } from "@amazme/ai";
import type { AgentTool, ToolContext } from "@amazme/agent";
import { toLlmContent, type McpClient as ProtocolClient } from "@amazme/mcp";

export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

export interface McpProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  onProgress?: (update: McpProgressUpdate) => void;
}

/** Caller-supplied client. This package does not open a transport. */
export interface McpClient {
  listTools(): readonly McpToolListing[] | Promise<readonly McpToolListing[]>;
  callTool(name: string, args: unknown, options?: McpCallOptions): Promise<McpToolResult>;
}

export interface McpServer {
  serverId: string;
  client: McpClient;
}

const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const MAX_EXPOSED_NAME = 64;

/**
 * Append MCP tools after the coding tools.
 * No servers, or servers with nothing to list, returns `tools` unchanged.
 * Exposed names are `mcp_<serverId>__<toolName>`. Characters outside
 * `[A-Za-z0-9_-]`, names longer than 64 characters, and collisions with a tool
 * already in `tools` or another server are errors. Neither side is sliced.
 */
export async function appendMcpTools(
  tools: AgentTool[],
  servers?: McpServer | readonly McpServer[],
): Promise<AgentTool[]> {
  const list = normalizeServers(servers);
  if (!list || list.length === 0) return tools;
  const additions: AgentTool[] = [];
  const used = new Map<string, string>();
  for (const tool of tools) used.set(tool.name, JSON.stringify(tool.name));
  for (const server of list) {
    const listed = await server.client.listTools();
    for (const item of listed) {
      const exposed = exposedName(server.serverId, item.name);
      const previous = used.get(exposed);
      const identity = `server ${JSON.stringify(server.serverId)}, tool ${JSON.stringify(item.name)}`;
      if (previous !== undefined) {
        throw new Error(`MCP tool name collides with ${previous}: ${identity}`);
      }
      used.set(exposed, identity);
      additions.push(mcpAgentTool(server.client, item, exposed));
    }
  }
  if (additions.length === 0) return tools;
  return [...tools, ...additions];
}

/** Adapt a connected protocol client. The caller still owns connect and close. */
export function mcpServer(serverId: string, client: ProtocolClient): McpServer {
  return {
    serverId,
    client: {
      listTools: () => client.listTools().then((listed) => listed.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as unknown as JsonSchema,
      }))),
      async callTool(name, args, options) {
        const result = await client.callTool(name, argumentsOf(args), {
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.onProgress
            ? {
                onProgress: (notification) => options.onProgress?.({
                  progress: notification.progress,
                  ...(notification.total !== undefined ? { total: notification.total } : {}),
                  ...(notification.message !== undefined ? { message: notification.message } : {}),
                }),
              }
            : {}),
        });
        return {
          content: toLlmContent(result),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      },
    },
  };
}

function normalizeServers(servers: McpServer | readonly McpServer[] | undefined): readonly McpServer[] | undefined {
  if (servers === undefined) return undefined;
  if (Array.isArray(servers)) return servers;
  if (isServer(servers)) return [servers];
  throw new Error("appendMcpTools requires a server id and client");
}

function isServer(value: object): value is McpServer {
  return "serverId" in value && "client" in value;
}

function exposedName(serverId: string, toolName: string): string {
  if (!IDENTIFIER.test(serverId) || !IDENTIFIER.test(toolName)) {
    throw new Error(`MCP tool name is not a stable identifier: server ${JSON.stringify(serverId)}, tool ${JSON.stringify(toolName)}`);
  }
  const exposed = `mcp_${serverId}__${toolName}`;
  if (exposed.length > MAX_EXPOSED_NAME) {
    throw new Error(`MCP tool name exceeds 64 characters: server ${JSON.stringify(serverId)}, tool ${JSON.stringify(toolName)}`);
  }
  return exposed;
}

function argumentsOf(args: unknown): Record<string, unknown> | undefined {
  if (args === undefined) return undefined;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("MCP tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}

function mcpAgentTool(client: McpClient, listed: McpToolListing, exposed: string): AgentTool {
  return {
    name: exposed,
    description: listed.description,
    parameters: listed.inputSchema,
    replay: "never",
    execute(args, context) {
      return callListed(client, listed.name, args, context);
    },
  };
}

async function callListed(client: McpClient, name: string, args: unknown, context: ToolContext) {
  const result = await client.callTool(name, args, {
    signal: context.signal,
    ...(context.onUpdate
      ? {
          onProgress: (update: McpProgressUpdate) => {
            const partial = update.message && update.message.length > 0 ? update.message : String(update.progress);
            context.onUpdate?.(partial);
          },
        }
      : {}),
  });
  return {
    content: result.content.map((block) => block.type === "text"
      ? { type: "text" as const, text: block.text }
      : { type: "image" as const, mimeType: block.mimeType, data: block.data }),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}
