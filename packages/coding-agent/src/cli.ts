#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent } from "@amazme/agent";
import { createModels, type LoginInteraction } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { AgentSession } from "./agent-session.ts";
import { FileCredentialStore, installationDeviceId } from "./credentials.ts";
import { SessionStore } from "./session.ts";
import { appendSkillText } from "./skills.ts";
import { createCodingTools } from "./tools.ts";

interface Args {
  prompt: string;
  provider: string;
  model: string;
  cwd: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: "", provider: "faux", model: "faux-1", cwd: process.cwd() };
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--provider") args.provider = argv[++index] ?? args.provider;
    else if (token === "--model") args.model = argv[++index] ?? args.model;
    else if (token === "--cwd") args.cwd = resolve(argv[++index] ?? args.cwd);
    else if (token === "--help") {
      console.log("amazme [--provider id] [--model id] [--cwd dir] <prompt>");
      console.log("amazme login --provider id [--method pkce|device_code] [--callback-port n]");
      process.exit(0);
    } else rest.push(token ?? "");
  }
  args.prompt = rest.join(" ").trim();
  return args;
}

async function runLogin(argv: string[]): Promise<void> {
  let providerId = "";
  let method: LoginInteraction["method"];
  let callbackPort: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--provider") providerId = argv[++index] ?? "";
    else if (token === "--method") {
      const value = argv[++index];
      if (value === "pkce" || value === "device_code") method = value;
    } else if (token === "--callback-port") callbackPort = Number(argv[++index]);
    else if (token === "--help") {
      console.log("amazme login --provider id [--method pkce|device_code] [--callback-port n]");
      process.exit(0);
    }
  }
  const provider = builtinProviders().find((item) => item.id === providerId);
  if (!provider?.auth.oauth) {
    console.error(providerId ? `${providerId} has no login` : "login requires --provider");
    process.exit(1);
  }
  const result = await provider.auth.oauth.login({
    ...(method ? { method } : {}),
    ...(callbackPort !== undefined && Number.isInteger(callbackPort) ? { callbackPort } : {}),
    deviceId: installationDeviceId(),
    onHandback(handback) {
      console.log(JSON.stringify(handback));
    },
  });
  await new FileCredentialStore().set(provider.id, result.credential);
  console.log(JSON.stringify({ stored: true, provider: provider.id, type: result.credential.type }));
}

async function main(): Promise<void> {
  if (process.argv[2] === "login") {
    await runLogin(process.argv.slice(3));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) {
    console.error("missing prompt");
    process.exit(1);
  }
  const models = createModels({ store: new FileCredentialStore() });
  if (args.provider === "faux") {
    models.setProvider(fauxProvider({ respond: (_context, _options, _state, model) => ({
      role: "assistant",
      content: [{ type: "text", text: `faux:${args.prompt}` }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    }) }));
  } else {
    const provider = builtinProviders().find((item) => item.id === args.provider);
    if (!provider) throw new Error(`unknown provider ${args.provider}`);
    models.setProvider(provider);
  }
  const model = models.getModel(args.provider, args.model);
  if (!model) throw new Error(`unknown model ${args.provider}/${args.model}`);
  const dir = join(args.cwd, ".amazme", "sessions");
  mkdirSync(dir, { recursive: true });
  const store = SessionStore.create(join(dir, `${Date.now()}.jsonl`), args.cwd);
  const agent = new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    telemetryContext: models.telemetryContext,
    systemPrompt: appendSkillText(
      "You are a coding agent. Use tools to inspect and change files in the workspace.",
      join(args.cwd, "skills"),
    ),
    tools: createCodingTools(args.cwd),
  });
  const session = new AgentSession(store, agent);
  const produced = await session.prompt(args.prompt);
  session.close();
  const last = [...produced].reverse().find((message) => message.role === "assistant");
  if (last && last.role === "assistant") {
    for (const block of last.content) {
      if (block.type === "text") console.log(block.text);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
