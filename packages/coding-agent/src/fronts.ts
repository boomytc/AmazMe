import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { finishDrive } from "@amazme/tui";
import { waitForSecondInterrupt } from "./interrupt.ts";
import { FileCredentialStore } from "./credentials.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost, type CodingHost } from "./host.ts";

export interface FrontOptions {
  provider: string;
  model: string;
  cwd: string;
  credentialsFile?: string;
  prompt?: string;
}

/** Models the fullscreen, web, and graphical fronts share. */
export function codingModels(options: FrontOptions) {
  const models = createModels({ store: new FileCredentialStore(options.credentialsFile) });
  for (const provider of builtinProviders()) models.setProvider(provider);
  if (!models.getProvider(options.provider)) {
    throw new Error(`unknown provider ${options.provider}`);
  }
  if (!models.getModel(options.provider, options.model)) {
    throw new Error(`unknown model ${options.provider}/${options.model}`);
  }
  return models;
}

export function workspaceSocket(cwd: string): string {
  return join(cwd, ".amazme", "runtime", "host.sock");
}

/** The host for one workspace. Callers that publish a page or window keep this process alive. */
export async function startWorkspaceHost(options: FrontOptions): Promise<CodingHost> {
  mkdirSync(join(options.cwd, ".amazme", "runtime"), { recursive: true });
  return startCodingHost({
    cwd: options.cwd,
    socket: workspaceSocket(options.cwd),
    provider: options.provider,
    model: options.model,
    models: codingModels(options),
  });
}

export interface CodingFronts {
  openWeb(): Promise<string>;
  openGui(): Promise<string>;
  /** Line printed after the fullscreen view leaves and the host stays. */
  runningLine(): string;
  stop(): Promise<void>;
}

/** Web and GUI clients of a host this process already started. */
export function createCodingFronts(host: CodingHost): CodingFronts {
  let bridge: { url: string; close(): Promise<void> } | null = null;
  let webUrl: string | null = null;
  const windows: ChildProcess[] = [];
  let stopped = false;
  return {
    async openWeb() {
      if (webUrl) return webUrl;
      const { startCodingBridge } = await import("./bridge.ts");
      bridge = await startCodingBridge({ socket: host.socket, port: 0, cwd: host.cwd });
      webUrl = bridge.url;
      reveal(webUrl);
      return webUrl;
    },
    async openGui() {
      const live = windows.find((child) => child.exitCode === null && child.signalCode === null);
      if (live) return "图形窗口已附着当前宿主";
      const child = spawn(process.execPath, guiLaunchArgs(host.socket), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      windows.push(child);
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(() => finish(new Error(stderr.trim() || "图形窗口没有附着")), 10_000);
          child.once("error", (error) => finish(error));
          child.stdout?.on("data", () => finish());
          child.once("exit", (code) => finish(new Error(stderr.trim() || `图形窗口退出 ${code ?? "null"}`)));
        });
      } catch (error) {
        const index = windows.indexOf(child);
        if (index >= 0) windows.splice(index, 1);
        child.kill();
        throw error;
      }
      return "图形窗口已附着当前宿主";
    },
    runningLine() {
      const parts = ["宿主仍在运行"];
      if (webUrl) parts.push(webUrl);
      if (windows.some((child) => child.exitCode === null && child.signalCode === null)) parts.push("图形窗口已附着");
      return `${parts.join(" ")}。Ctrl-C 结束`;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.all(windows.map((child) => closeChild(child)));
      if (bridge) await bridge.close();
      await host.close();
    },
  };
}

/** Start the host and the loopback page. The process stays until SIGINT or SIGTERM. */
export async function runOwnedWeb(options: FrontOptions): Promise<void> {
  const signal = waitForSecondInterrupt();
  const host = await startWorkspaceHost(options);
  const fronts = createCodingFronts(host);
  try {
    const url = await fronts.openWeb();
    if (options.prompt) await submitPrompt(host.socket, options.prompt);
    process.stdout.write(`${JSON.stringify({ url })}\n`);
    await signal;
  } finally {
    await fronts.stop();
  }
}

/** Start the host and the graphical client. Closing the client, or a signal, stops the host. */
export async function runOwnedGui(options: FrontOptions): Promise<void> {
  const signal = waitForSecondInterrupt();
  const host = await startWorkspaceHost(options);
  const { runGuiSession, statusText, tryOpenWindow } = await import("@amazme/gui");
  let lastDocument = "";
  const session = await runGuiSession({
    socket: host.socket,
    serverId: HOST_SERVER_ID,
    runtimeId: HOST_RUNTIME_ID,
    lane: HOST_LANE,
    onView(view, document) {
      lastDocument = document;
      process.stdout.write(`${JSON.stringify({ document, status: statusText(view) })}\n`);
    },
  });
  try {
    if (options.prompt) await session.submit(options.prompt);
    const windowError = await tryOpenWindow(lastDocument);
    if (windowError) process.stderr.write(`GUI_WINDOW: ${windowError}\n`);
    await Promise.race([signal, stdinEnded()]);
  } finally {
    await session.close();
    await host.close();
  }
}

function guiLaunchArgs(socket: string): string[] {
  const require = createRequire(import.meta.url);
  const loader = require.resolve("tsx");
  const script = fileURLToPath(new URL("./cli.ts", import.meta.url));
  return ["--import", loader, script, "gui", "--socket", socket];
}

function reveal(url: string): void {
  if (process.stdout.isTTY !== true || process.platform !== "darwin") return;
  const child = spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true });
  child.once("error", () => undefined);
  child.unref();
}

function stdinEnded(): Promise<void> {
  if (process.stdin.isTTY) return new Promise(() => undefined);
  if (process.stdin.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    process.stdin.on("end", () => resolve());
    process.stdin.resume();
  });
}

async function submitPrompt(socket: string, text: string): Promise<void> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(HOST_RUNTIME_ID);
    const lane = remote.lane(HOST_LANE);
    const admitted = await lane.accept({ kind: "prompt", text });
    await finishDrive(lane, admitted.operationId);
  } finally {
    await client.dispose();
  }
}

function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.stdin?.end();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

