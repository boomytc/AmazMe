import { isAbsolute } from "node:path";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { startWeb, type WebServer } from "@amazme/web";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "./host.ts";
import { formatHandback, loginCatalog, loginProvider, logoutProvider, saveApiKey } from "./login.ts";

export interface BridgeOptions {
  socket: string;
  port?: number;
  credentialsFile?: string;
  cwd?: string;
}

export interface CodingBridge {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Directory for project files and slash commands.
 * An explicit `cwd` is that directory. Otherwise the connected host reports its own.
 * `process.cwd()` is not a workspace: standalone `amazme bridge` is often started elsewhere.
 */
async function reportedCwd(socket: string): Promise<string> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  try {
    await client.connect();
    const result = await client.request(client.serverRoute(), { method: "cwd" });
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("the host did not report a working directory");
    }
    const cwd = result.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("the host did not report a working directory");
    return cwd;
  } finally {
    await client.dispose();
  }
}

/** CLI entry. The page itself lives in `@amazme/web` and only attaches to this host. */
export async function startCodingBridge(options: BridgeOptions): Promise<CodingBridge> {
  const cwd = options.cwd ?? await reportedCwd(options.socket);
  const page: WebServer = await startWeb({
    socket: options.socket,
    port: options.port,
    serverId: HOST_SERVER_ID,
    runtimeId: HOST_RUNTIME_ID,
    lane: HOST_LANE,
    login: (provider, handback) => loginProvider(provider, {
      credentialsFile: options.credentialsFile,
      onHandback(value) { handback(formatHandback(value)); },
    }).then((report) => report.message),
    logout: (provider) => logoutProvider(provider, options.credentialsFile),
    catalog: () => loginCatalog(options.credentialsFile),
    saveApiKey: (providerId, key) => saveApiKey(providerId, key, options.credentialsFile),
    cwd,
  });
  return page;
}
