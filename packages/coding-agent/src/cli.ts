#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createModels, type LoginInteraction, type Models } from "@amazme/ai";
import { requireRouterKeys } from "./settings.ts";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { FileCredentialStore } from "./credentials.ts";
import { codingModels } from "./fronts.ts";
import { commitProviderModels, loginProvider } from "./login.ts";
import { runPrint } from "./print-run.ts";
import { runCodingFullscreen, shouldOpenFullscreen } from "./tui/run.ts";

interface Args {
  prompt: string;
  provider: string;
  model: string;
  cwd: string;
  continueSession: boolean;
  json: boolean;
  jsonl: boolean;
  web: boolean;
  gui: boolean;
  lane?: string;
}

const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-flash";

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: "", provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, cwd: process.cwd(), continueSession: false, json: false, jsonl: false, web: false, gui: false };
  const rest: string[] = [];
  let options = true;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (!options || !token.startsWith("-")) {
      rest.push(token);
      continue;
    }
    if (token === "--provider") args.provider = argv[++index] ?? args.provider;
    else if (token === "--model") args.model = argv[++index] ?? args.model;
    else if (token === "--cwd") args.cwd = resolve(argv[++index] ?? args.cwd);
    else if (token === "--continue") args.continueSession = true;
    else if (token === "--json") args.json = true;
    else if (token === "--jsonl") args.jsonl = true;
    else if (token === "--resume") args.lane = argv[++index] ?? args.lane;
    else if (token === "--web") args.web = true;
    else if (token === "--gui") args.gui = true;
    else if (token === "--help") {
      console.log("amazme [--provider id] [--model id] [--cwd dir] [--continue] [--json] [--jsonl] [--resume name] [--version|-v] [prompt]");
      console.log("amazme --web [--provider id] [--model id] [--cwd dir] [prompt]");
      console.log("amazme --gui [--provider id] [--model id] [--cwd dir] [prompt]");
      console.log(`defaults: provider ${DEFAULT_PROVIDER}, model ${DEFAULT_MODEL}`);
      console.log("amazme --jsonl    reads one {\"type\":\"prompt\",\"text\":\"...\"} line from stdin");
      console.log("A prompt that starts with - must follow --.");
      console.log("amazme update");
      console.log("amazme login account [--provider id] [--method pkce|device_code] [--callback-port n]");
      console.log("amazme login api-key [--provider id]");
      console.log("amazme serve --socket path [--cwd dir] [--provider id] [--model id]");
      console.log("amazme attach --socket path");
      console.log("amazme bridge --socket path [--port n]");
      console.log("amazme gui --socket path [--prompt text]");
      process.exit(0);
    } else throw new Error(`unknown option ${token}`);
  }
  args.prompt = rest.join(" ").trim();
  return args;
}

function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) throw new Error("coding-agent package.json has no version");
  const version = parsed.version;
  if (typeof version !== "string" || version.length === 0) throw new Error("coding-agent package.json has no version");
  return version;
}

/** `-v` / `--version` count only as flags. The token after a valued option, such as `--resume -v`, is that option's value. */
function versionRequested(argv: string[]): boolean {
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  const takesValue = new Set([
    "--provider", "--model", "--cwd", "--resume",
    "--socket", "--port", "--method", "--callback-port", "--prompt",
  ]);
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index] ?? "";
    if (token === "--version" || token === "-v") return true;
    if (takesValue.has(token)) index += 1;
  }
  return false;
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
}

async function runLogin(argv: string[]): Promise<void> {
  const parsed = parseLoginArgs(argv);
  if (parsed.help) {
    console.log("amazme login account [--provider id] [--method pkce|device_code] [--callback-port n]");
    console.log("amazme login api-key [--provider id]");
    return;
  }
  if (!parsed.entry && parsed.provider.length === 0) {
    process.stderr.write("amazme login account [--provider id] [--method pkce|device_code] [--callback-port n]\n");
    process.stderr.write("amazme login api-key [--provider id]\n");
    process.exit(1);
  }
  const { loginCatalog, saveApiKey } = await import("./login.ts");
  const rows = await loginCatalog();
  let entry = parsed.entry;
  if (!entry && parsed.provider) {
    const named = rows.find((row) => row.id === parsed.provider);
    if (!named || (!named.oauth && !named.apiKey)) throw new Error(`${parsed.provider} has no login`);
    if (named.oauth && named.apiKey) {
      throw new Error(`choose login account --provider ${named.id} or login api-key --provider ${named.id}`);
    }
    entry = named.oauth ? "account" : "api-key";
  }
  if (!entry) throw new Error("login requires account or api-key");
  const matching = entry === "account" ? rows.filter((row) => row.oauth) : rows.filter((row) => row.apiKey);
  if (!parsed.provider) {
    for (const row of matching) process.stdout.write(`${row.id}\t${row.name}\n`);
    return;
  }
  const provider = rows.find((row) => row.id === parsed.provider);
  if (!provider || (entry === "account" ? !provider.oauth : !provider.apiKey)) {
    throw new Error(`${parsed.provider} has no ${entry} login`);
  }
  if (entry === "api-key") {
    const key = await readApiKey();
    await saveApiKey(provider.id, key);
    process.stdout.write(`${commitProviderModels(provider.id, process.cwd())}\n`);
    return;
  }
  const report = await loginProvider(provider.id, {
    ...(parsed.method ? { method: parsed.method } : {}),
    ...(parsed.callbackPort !== undefined ? { callbackPort: parsed.callbackPort } : {}),
    onHandback(handback) {
      console.log(JSON.stringify(handback));
    },
  });
  process.stdout.write(`${commitProviderModels(report.provider, process.cwd())}\n`);
  console.log(JSON.stringify({ stored: true, provider: report.provider, type: report.credentialType }));
}

function parseLoginArgs(argv: string[]): {
  entry?: "account" | "api-key";
  provider: string;
  method?: LoginInteraction["method"];
  callbackPort?: number;
  help: boolean;
} {
  let entry: "account" | "api-key" | undefined;
  let provider = "";
  let method: LoginInteraction["method"];
  let callbackPort: number | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "account" || token === "api-key") entry = token;
    else if (token === "--provider") provider = argv[++index] ?? "";
    else if (token === "--method") {
      const value = argv[++index];
      if (value === "pkce" || value === "device_code") method = value;
    } else if (token === "--callback-port") callbackPort = Number(argv[++index]);
    else if (token === "--help" || token === "help") help = true;
    else if (token) throw new Error(`unknown argument ${token}`);
  }
  return { ...(entry ? { entry } : {}), provider, ...(method ? { method } : {}), ...(callbackPort !== undefined && Number.isInteger(callbackPort) ? { callbackPort } : {}), help };
}

async function readApiKey(): Promise<string> {
  if (process.stdin.isTTY !== true) {
    const line = (await readStdinLine()).trim();
    if (!line) throw new Error("API key is empty");
    return line;
  }
  process.stdout.write("API key: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.off("data", onData);
      process.stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("canceled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          process.stdout.write("\n");
          cleanup();
          if (!value) reject(new Error("API key is empty"));
          else resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        value += char;
        process.stdout.write("•");
      }
    };
    process.stdin.on("data", onData);
  });
}

function loadModels(providerId: string) {
  const models = createModels({ store: new FileCredentialStore() });
  for (const provider of builtinProviders()) models.setProvider(provider);
  if (!models.getProvider(providerId)) throw new Error(`unknown provider ${providerId}`);
  return models;
}

type ReadyModels = Pick<Models, "getModel" | "getAuth" | "getProvider">;

/** A front may open only after the selected provider has a key. Login stays outside this check. */
async function requireConfigured(models: ReadyModels, providerId: string, modelId: string): Promise<void> {
  const model = models.getModel(providerId, modelId);
  if (!model) throw new Error(`unknown model ${providerId}/${modelId}`);
  if (await models.getAuth(model)) return;
  const env = models.getProvider(providerId)?.auth.apiKey?.env;
  throw new Error(`${providerId} is not configured: ${env ? `set ${env} or run amazme login` : "run amazme login"}`);
}

/** The selected model and, when routing is on, strong and cheap. An unset router adds no check and no classifier call. */
async function requireReady(models: ReadyModels, providerId: string, modelId: string, cwd: string): Promise<void> {
  await requireConfigured(models, providerId, modelId);
  await requireRouterKeys(models, cwd);
}

async function runServe(argv: string[]): Promise<void> {
  let socket = "";
  let provider = DEFAULT_PROVIDER;
  let model = DEFAULT_MODEL;
  let cwd = process.cwd();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--socket") socket = argv[++index] ?? "";
    else if (token === "--provider") provider = argv[++index] ?? provider;
    else if (token === "--model") model = argv[++index] ?? model;
    else if (token === "--cwd") cwd = resolve(argv[++index] ?? cwd);
    else if (token === "--help") {
      console.log("amazme serve --socket path [--cwd dir] [--provider id] [--model id]");
      console.log(`defaults: provider ${DEFAULT_PROVIDER}, model ${DEFAULT_MODEL}`);
      console.log("MCP servers are read from <cwd>/.amazme/mcp.json when that file exists.");
      process.exit(0);
    } else if (token) {
      throw new Error(`unknown argument ${token}`);
    }
  }
  if (!socket) throw new Error("serve requires --socket");
  const models = loadModels(provider);
  await requireReady(models, provider, model, cwd);
  const { startCodingHost } = await import("./host.ts");
  const { waitForSecondInterrupt } = await import("./interrupt.ts");
  const stopped = waitForSecondInterrupt();
  const host = await startCodingHost({ cwd, socket, provider, model, models });
  process.stdout.write(`${JSON.stringify({ socket: host.socket, serverId: host.serverId, runtimeId: host.runtimeId, lane: host.lane })}\n`);
  await stopped;
  await host.close();
}

async function runAttach(argv: string[]): Promise<void> {
  let socket = "";
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--socket") socket = argv[++index] ?? "";
    else if (token === "--help") {
      console.log("amazme attach --socket path");
      process.exit(0);
    } else if (token) throw new Error(`unknown argument ${token}`);
  }
  if (!socket) throw new Error("attach requires --socket");
  const { runAttachedControl } = await import("./attach.ts");
  await runAttachedControl(socket);
}

async function runBridge(argv: string[]): Promise<void> {
  let socket = "";
  let port = 8787;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--socket") socket = argv[++index] ?? "";
    else if (token === "--port") port = Number(argv[++index]);
    else if (token === "--help") {
      console.log("amazme bridge --socket path [--port n]");
      process.exit(0);
    } else if (token) throw new Error(`unknown argument ${token}`);
  }
  if (!socket) throw new Error("bridge requires --socket");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("bridge requires a port from 0 to 65535");
  const { startCodingBridge } = await import("./bridge.ts");
  const { waitForSecondInterrupt } = await import("./interrupt.ts");
  const stopped = waitForSecondInterrupt();
  const bridge = await startCodingBridge({ socket, port });
  process.stdout.write(`${JSON.stringify({ url: bridge.url })}\n`);
  await stopped;
  await bridge.close();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (versionRequested(argv)) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (process.argv[2] === "update") {
    const { installationRoot, updateInstallation } = await import("./update.ts");
    process.stdout.write(`${await updateInstallation(installationRoot())}\n`);
    return;
  }
  if (process.argv[2] === "login") {
    await runLogin(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "serve") {
    await runServe(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "attach") {
    await runAttach(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "bridge") {
    await runBridge(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "gui") {
    const { runGuiCommand } = await import("@amazme/gui");
    await runGuiCommand(process.argv.slice(3));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.web || args.gui) {
    if (args.web && args.gui) throw new Error("choose one of --web or --gui");
    const { runOwnedGui, runOwnedWeb } = await import("./fronts.ts");
    const front = { provider: args.provider, model: args.model, cwd: args.cwd, prompt: args.prompt };
    await requireReady(codingModels(front), front.provider, front.model, front.cwd);
    if (args.web) await runOwnedWeb(front);
    else await runOwnedGui(front);
    return;
  }
  if (args.jsonl) {
    const line = (await readStdinLine()).trim();
    const parsed = JSON.parse(line) as { type?: string; text?: string };
    if (parsed.type !== "prompt" || typeof parsed.text !== "string" || parsed.text.length === 0) {
      throw new Error("stdin JSONL requires {\"type\":\"prompt\",\"text\":\"...\"}");
    }
    args.prompt = parsed.text;
    args.json = true;
  }
  if (shouldOpenFullscreen(args.prompt, process.stdout.isTTY === true) && !args.continueSession && !args.json && !args.jsonl) {
    await requireReady(codingModels({ provider: args.provider, model: args.model, cwd: args.cwd }), args.provider, args.model, args.cwd);
    await runCodingFullscreen({ provider: args.provider, model: args.model, cwd: args.cwd });
    return;
  }
  if (!args.prompt && !args.continueSession) {
    console.error("missing prompt");
    process.exit(1);
  }
  const models = loadModels(args.provider);
  await requireReady(models, args.provider, args.model, args.cwd);
  await runPrint({
    cwd: args.cwd,
    provider: args.provider,
    model: args.model,
    models,
    prompt: args.prompt,
    continueSession: args.continueSession || args.jsonl,
    json: args.json,
    ...(args.lane ? { lane: args.lane } : {}),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
