import { startWeb, type WebServer } from "@amazme/web";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "./host.ts";
import { formatHandback, loginProvider, logoutProvider } from "./login.ts";

export interface BridgeOptions {
  socket: string;
  port?: number;
}

export interface CodingBridge {
  readonly url: string;
  close(): Promise<void>;
}

/** CLI entry. The page itself lives in `@amazme/web` and only attaches to this host. */
export async function startCodingBridge(options: BridgeOptions): Promise<CodingBridge> {
  const page: WebServer = await startWeb({
    socket: options.socket,
    port: options.port,
    serverId: HOST_SERVER_ID,
    runtimeId: HOST_RUNTIME_ID,
    lane: HOST_LANE,
    login: (provider, handback) => loginProvider(provider, {
      onHandback(value) { handback(formatHandback(value)); },
    }).then((report) => report.message),
    logout: (provider) => logoutProvider(provider),
  });
  return page;
}
