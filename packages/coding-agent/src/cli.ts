#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent } from "@amazme/agent";
import { createModels } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";
import { openaiProvider } from "@amazme/ai/providers/openai";
import { AgentSession } from "./agent-session.ts";
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
      console.log("amazme [--provider faux|openai] [--model id] [--cwd dir] <prompt>");
      process.exit(0);
    } else rest.push(token ?? "");
  }
  args.prompt = rest.join(" ").trim();
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) {
    console.error("missing prompt");
    process.exit(1);
  }
  const models = createModels();
  if (args.provider === "openai") models.setProvider(openaiProvider({ modelIds: [args.model] }));
  else models.setProvider(fauxProvider({ respond: (_context, _options, _state, model) => ({
    role: "assistant",
    content: [{ type: "text", text: `faux:${args.prompt}` }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }) }));
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
