import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@amazme/agent";
import { createModels, messageText, type Context } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { AgentSession } from "../agent-session.ts";
import { FileCredentialStore } from "../credentials.ts";
import { SessionStore } from "../session.ts";
import { appendSkillText } from "../skills.ts";
import { codingSystemPrompt, createCodingTools } from "../tools.ts";
import { presentFullscreen, presentHost, type HostAttach } from "@amazme/tui";
import { formatHandback, loginCatalog, loginProvider, logoutProvider, saveApiKey } from "../login.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../host.ts";

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

/** Start the host, then hand the socket to `@amazme/tui`. This process owns the host; the view does not. */
export async function runCodingFullscreen(options: FullscreenOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  const models = openModels(options);
  const socket = join(options.cwd, ".amazme", "runtime", "host.sock");
  mkdirSync(join(options.cwd, ".amazme", "runtime"), { recursive: true });
  const host = await startCodingHost({
    cwd: options.cwd,
    socket,
    provider: options.provider,
    model: options.model,
    models,
  });
  const attach: HostAttach = { socket, serverId: HOST_SERVER_ID, runtimeId: HOST_RUNTIME_ID, lane: HOST_LANE };
  try {
    await presentHost(attach, process.stdin, process.stdout, {
      login: (provider, handback) => loginProvider(provider, {
        credentialsFile: options.credentialsFile,
        onHandback(value) { handback(formatHandback(value)); },
      }).then((report) => report.message),
      logout: (provider) => logoutProvider(provider, options.credentialsFile),
      catalog: () => loginCatalog(options.credentialsFile),
      saveApiKey: (providerId, key) => saveApiKey(providerId, key, options.credentialsFile),
    });
  } finally {
    await host.close();
  }
}

/** Legacy in-memory session. The fullscreen command no longer uses it. */
export function createFullscreenSession(options: FullscreenOptions): AgentSession {
  return openSession(options);
}

function openModels(options: FullscreenOptions) {
  const models = createModels({ store: new FileCredentialStore(options.credentialsFile) });
  for (const provider of builtinProviders()) models.setProvider(provider);
  if (options.provider === "faux") {
    models.setProvider(fauxProvider({
      respond: (context, _streamOptions, _state, model) => ({
        role: "assistant",
        content: [{ type: "text", text: `faux:${lastUserText(context)}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    }));
  } else if (!models.getProvider(options.provider)) {
    throw new Error(`unknown provider ${options.provider}`);
  }
  if (!models.getModel(options.provider, options.model)) {
    throw new Error(`unknown model ${options.provider}/${options.model}`);
  }
  return models;
}

function openSession(options: FullscreenOptions): AgentSession {
  const models = openModels(options);
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

function lastUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "user") return messageText(message);
  }
  return "";
}
