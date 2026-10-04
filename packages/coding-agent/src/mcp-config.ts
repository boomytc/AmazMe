import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@amazme/mcp";
import { ServiceError } from "@amazme/server";
import { mcpServer, type McpServer } from "./mcp.ts";

const IDENTIFIER = /^[A-Za-z0-9_-]+$/;

interface StdioServer {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
}

interface HttpServer {
  id: string;
  url: string;
}

type ServerSpec = StdioServer | HttpServer;

/** MCP clients opened for one runtime. Closing them does not touch the JSONL lock. */
export interface ConnectedMcp {
  readonly servers: readonly McpServer[];
  close(): Promise<void>;
}

/**
 * Read `<cwd>/.amazme/mcp.json`. A missing file connects nothing.
 * A present file that is invalid, or a server that fails to connect, fails the open.
 * Stdio children inherit the host environment. They are not Seatbelt children.
 */
export async function connectWorkspaceMcp(cwd: string): Promise<ConnectedMcp> {
  const file = join(resolve(cwd), ".amazme", "mcp.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { servers: [], close: () => Promise.resolve() };
    throw unavailable(error instanceof Error ? error.message : String(error));
  }
  let specs: ServerSpec[];
  try {
    specs = parseConfig(raw, resolve(cwd));
  } catch (error) {
    throw unavailable(error instanceof Error ? error.message : String(error));
  }
  const clients: McpClient[] = [];
  const servers: McpServer[] = [];
  try {
    for (const spec of specs) {
      const client = new McpClient({ name: "amazme", version: "0.1.0" });
      if ("url" in spec) {
        await client.connect(new StreamableHttpTransport({ url: spec.url }));
      } else {
        await client.connect(new StdioTransport({
          command: spec.command,
          args: spec.args,
          ...(spec.cwd ? { cwd: spec.cwd } : { cwd: resolve(cwd) }),
          stderr: "pipe",
        }));
      }
      clients.push(client);
      servers.push(mcpServer(spec.id, client));
    }
  } catch (error) {
    await closeClients(clients);
    throw unavailable(error instanceof Error ? error.message : String(error));
  }
  return { servers, close: () => closeClients(clients) };
}

function parseConfig(raw: string, cwd: string): ServerSpec[] {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("mcp.json must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "servers")) throw new Error("mcp.json only allows servers");
  if (!Array.isArray(record.servers)) throw new Error("mcp.json servers must be an array");
  const seen = new Set<string>();
  return record.servers.map((item) => {
    const spec = parseServer(item, cwd);
    if (seen.has(spec.id)) throw new Error(`duplicate MCP server ${spec.id}`);
    seen.add(spec.id);
    return spec;
  });
}

function parseServer(value: unknown, cwd: string): ServerSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("an MCP server must be an object");
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !IDENTIFIER.test(id)) throw new Error("an MCP server id must match [A-Za-z0-9_-]+");
  const keys = new Set(Object.keys(record));
  keys.delete("id");
  if (typeof record.url === "string") {
    if ([...keys].some((key) => key !== "url")) throw new Error(`MCP server ${id} mixes url with command fields`);
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      throw new Error(`MCP server ${id} has an invalid url`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`MCP server ${id} url must be http or https`);
    return { id, url: url.toString() };
  }
  if (typeof record.command !== "string" || record.command.length === 0) {
    throw new Error(`MCP server ${id} needs a command or an url`);
  }
  if ([...keys].some((key) => key !== "command" && key !== "args" && key !== "cwd")) {
    throw new Error(`MCP server ${id} has an unknown field`);
  }
  const args = record.args === undefined ? [] : record.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error(`MCP server ${id} args must be strings`);
  let serverCwd: string | undefined;
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string" || record.cwd.length === 0) throw new Error(`MCP server ${id} cwd must be a path`);
    serverCwd = isAbsolute(record.cwd) ? record.cwd : join(cwd, record.cwd);
  }
  return { id, command: record.command, args, ...(serverCwd ? { cwd: serverCwd } : {}) };
}

async function closeClients(clients: readonly McpClient[]): Promise<void> {
  const settled = await Promise.allSettled(clients.map((client) => client.close()));
  const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "closing MCP clients failed");
}

function unavailable(message: string): ServiceError {
  return new ServiceError("mcp_unavailable", message);
}
