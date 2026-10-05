import { existsSync } from "node:fs";
import { imageInputRefusal } from "@amazme/ai";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { activateProject, presentHost, type HostAccount, type HostAttach } from "@amazme/tui";
import { codingModels, createCodingFronts, startWorkspaceHost } from "../fronts.ts";
import { waitForSecondInterrupt } from "../interrupt.ts";
import { commitProviderModels, formatHandback, loginCatalog, loginProvider, logoutProvider, saveApiKey } from "../login.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, runtimeFile, type CodingHost } from "../host.ts";

export interface FullscreenOptions {
  provider: string;
  model: string;
  cwd: string;
  /** Overrides the default credential file. Tests pass a temp path. */
  credentialsFile?: string;
  /** Named session from `--resume`. Omitted keeps the default lane. */
  lane?: string;
}

/** Fullscreen opens when the CLI has no prompt and stdout is a terminal. */
export function shouldOpenFullscreen(prompt: string, stdoutIsTTY: boolean): boolean {
  return prompt.length === 0 && stdoutIsTTY;
}

/** Same refusal the provider uses before fetch. An unknown model never leaves the composer. */
export function refuseImageTurn(
  models: { getModel(provider: string, modelId: string): { id: string; input: readonly string[] } | undefined },
  provider: string,
  modelId: string,
  content: readonly { type: string }[],
): string | undefined {
  const model = models.getModel(provider, modelId);
  if (!model) return `未知模型 ${provider}/${modelId}`;
  return imageInputRefusal(model, content);
}

/** Account and API-key login for the fullscreen view. Models are recorded only after the credential is stored. */
export function codingLoginAccount(options: { cwd?: string; credentialsFile?: string }): HostAccount {
  return {
    login: async (provider, handback, currentModel) => {
      const report = await loginProvider(provider, {
        ...(options.credentialsFile ? { credentialsFile: options.credentialsFile } : {}),
        onHandback(value) { handback(formatHandback(value)); },
      });
      return commitProviderModels(report.provider, options.cwd, currentModel);
    },
    logout: (provider) => logoutProvider(provider, options.credentialsFile),
    catalog: () => loginCatalog(options.credentialsFile),
    saveApiKey: async (providerId, key, currentModel) => {
      await saveApiKey(providerId, key, options.credentialsFile);
      return commitProviderModels(providerId, options.cwd, currentModel);
    },
  };
}

/**
 * Start the host, then hand the socket to `@amazme/tui`. The view does not own the log.
 * `/web` and `/gui` publish clients on this host. Quitting the view then leaves the process
 * serving them. A view that never published a client closes the host.
 */
export async function runCodingFullscreen(options: FullscreenOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  // 问题：进入全屏后会读 configure()，而 configure() 会 ensureLane。
  // 例如 `amazme --resume notes` 在 notes 还没写入时，会新建 notes，画面仍可能停在 main。
  // 先看日志里有没有这个名字。没有就退出。presentHost 只附着已经存在的 lane。
  if (options.lane && !existsSync(runtimeFile(options.cwd))) {
    throw new Error(`session ${options.lane} does not exist`);
  }
  const models = codingModels(options);
  const host = await startWorkspaceHost(options);
  const fronts = createCodingFronts(host);
  let published = false;
  let pending = 0;
  const lane = options.lane ?? HOST_LANE;
  const attach: HostAttach = { socket: host.socket, serverId: HOST_SERVER_ID, runtimeId: HOST_RUNTIME_ID, lane, cwd: options.cwd };
  const publish = async (open: () => Promise<string>): Promise<string> => {
    pending += 1;
    try {
      const text = await open();
      published = true;
      return text;
    } finally {
      pending -= 1;
    }
  };
  try {
    if (options.lane && !await sessionExists(host, options.lane)) {
      throw new Error(`session ${options.lane} does not exist`);
    }
    await activateProject(options.cwd);
    await presentHost(attach, process.stdin, process.stdout, codingLoginAccount(options), {
      openWeb: () => publish(async () => `网页 ${await fronts.openWeb()}`),
      openGui: () => publish(() => fronts.openGui()),
      refuseImages: (provider, modelId, content) => refuseImageTurn(models, provider, modelId, content),
    });
    while (pending > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  } catch (error) {
    await fronts.stop();
    throw error;
  }
  if (!published) {
    await fronts.stop();
    return;
  }
  process.stdout.write(`${fronts.runningLine()}\n`);
  await waitForSecondInterrupt();
  await fronts.stop();
}

/** True when this workspace log already stores `lane`. Does not create a lane. */
async function sessionExists(host: CodingHost, lane: string): Promise<boolean> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: host.socket }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(HOST_RUNTIME_ID);
    return (await remote.conversations()).includes(lane);
  } finally {
    await client.dispose();
  }
}
