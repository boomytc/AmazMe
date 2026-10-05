import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@amazme/agent";
import { AgentSession } from "../agent-session.ts";
import { SessionStore } from "../session.ts";
import { appendSkillText } from "../skills.ts";
import { codingSystemPrompt, createCodingTools } from "../tools.ts";
import { activateProject, presentFullscreen, presentHost, type HostAttach } from "@amazme/tui";
import { codingModels, createCodingFronts, startWorkspaceHost } from "../fronts.ts";
import { waitForSecondInterrupt } from "../interrupt.ts";
import { formatHandback, loginCatalog, loginProvider, logoutProvider, saveApiKey } from "../login.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "../host.ts";

export interface FullscreenOptions {
  provider: string;
  model: string;
  cwd: string;
  /** Overrides the default credential file. Tests pass a temp path. */
  credentialsFile?: string;
}

/** Fullscreen opens when the CLI has no prompt and stdout is a terminal. */
export function shouldOpenFullscreen(prompt: string, stdoutIsTTY: boolean): boolean {
  return prompt.length === 0 && stdoutIsTTY;
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
  const host = await startWorkspaceHost(options);
  const fronts = createCodingFronts(host);
  let published = false;
  let pending = 0;
  const attach: HostAttach = { socket: host.socket, serverId: HOST_SERVER_ID, runtimeId: HOST_RUNTIME_ID, lane: HOST_LANE, cwd: options.cwd };
  await activateProject(options.cwd);
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
    await presentHost(attach, process.stdin, process.stdout, {
      login: (provider, handback) => loginProvider(provider, {
        credentialsFile: options.credentialsFile,
        onHandback(value) { handback(formatHandback(value)); },
      }).then((report) => report.message),
      logout: (provider) => logoutProvider(provider, options.credentialsFile),
      catalog: () => loginCatalog(options.credentialsFile),
      saveApiKey: (providerId, key) => saveApiKey(providerId, key, options.credentialsFile),
    }, {
      openWeb: () => publish(async () => `网页 ${await fronts.openWeb()}`),
      openGui: () => publish(() => fronts.openGui()),
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

/** Legacy in-memory session. The fullscreen command no longer uses it. */
export function createFullscreenSession(options: FullscreenOptions): AgentSession {
  return openSession(options);
}

function openSession(options: FullscreenOptions): AgentSession {
  const models = codingModels(options);
  const model = models.getModel(options.provider, options.model);
  if (!model) throw new Error(`unknown model ${options.provider}/${options.model}`);
  const dir = join(options.cwd, ".amazme", "sessions");
  mkdirSync(dir, { recursive: true });
  const store = SessionStore.create(join(dir, `${Date.now()}.jsonl`), options.cwd);
  const agent = new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    telemetryContext: models.telemetryContext,
    systemPrompt: appendSkillText(
      codingSystemPrompt,
      join(options.cwd, "skills"),
    ),
    tools: createCodingTools(options.cwd),
  });
  return new AgentSession(store, agent);
}
