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
import { presentFullscreen } from "./screen.ts";

export interface FullscreenOptions {
  provider: string;
  model: string;
  cwd: string;
  /** Overrides the default credential file. Tests pass a temp path. */
  credentialsFile?: string;
}

/** Fullscreen is the view. The model call stays inside the existing agent loop. */
export function shouldOpenFullscreen(prompt: string, stdoutIsTTY: boolean): boolean {
  return prompt.length === 0 && stdoutIsTTY;
}

export async function runCodingFullscreen(options: FullscreenOptions): Promise<void> {
  const session = createFullscreenSession(options);
  try {
    await presentFullscreen(session);
  } finally {
    session.close();
  }
}

/** Same session the fullscreen command uses: one agent, the current JSONL tree. */
export function createFullscreenSession(options: FullscreenOptions): AgentSession {
  return openSession(options);
}

function openSession(options: FullscreenOptions): AgentSession {
  const models = createModels({ store: new FileCredentialStore(options.credentialsFile) });
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
  } else {
    const provider = builtinProviders().find((item) => item.id === options.provider);
    if (!provider) throw new Error(`unknown provider ${options.provider}`);
    models.setProvider(provider);
  }
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
