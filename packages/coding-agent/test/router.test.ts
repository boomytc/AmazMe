import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "@amazme/agent";
import { baseAssistant, createAssistantEventStream, createModels, usageCost, type ClassifierModel, type ClassifierResult, type Model } from "@amazme/ai";
import { typesafeProvider } from "@amazme/ai/providers/typesafe";
import { builtinModelSpecs } from "../src/login.ts";
import { listedHostModels } from "../src/host.ts";
import { codingModels } from "../src/fronts.ts";
import { AgentSession, SessionStore } from "../src/index.ts";
import type { RouterModels } from "../src/router.ts";
import { readRouterSettings, settingsFile, type RouterSettings } from "../src/settings.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const agentPackage = fileURLToPath(new URL("../../agent", import.meta.url));

const pricedClassifier: ClassifierModel = {
  id: "jev-latest",
  name: "Jev",
  provider: "typesafe",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai/v1/",
  contextWindow: 64_000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amazme-router-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hand(id: string): Model {
  return {
    id,
    name: id,
    provider: "hand",
    api: "faux",
    input: ["text"],
    contextWindow: 1024,
    maxTokens: 128,
    cost: { input: 1, output: 1 },
  };
}

function writeRouter(cwd: string, router: RouterSettings): void {
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(settingsFile(cwd), `${JSON.stringify({ router }, null, 2)}\n`);
}

function choice(complex: number, label: "standard" | "complex" = complex >= 0.5 ? "complex" : "standard"): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    stopReason: "stop",
    answers: {
      route: {
        type: "choice",
        choice: label,
        confidence: complex,
        probabilities: { standard: 1 - complex, complex },
      },
    },
    usage: { input: 1_000_000, output: 0, totalTokens: 1_000_000, cost: { input: 0, output: 0, total: 0 } },
  };
}

function modelsFor(
  classifier: ClassifierModel,
  classify: RouterModels["classify"],
): RouterModels {
  const catalog = new Map<string, Model>([
    ["hand/current", hand("current")],
    ["hand/strong", hand("strong")],
    ["hand/cheap", hand("cheap")],
  ]);
  return {
    getModel: (provider, id) => catalog.get(`${provider}/${id}`),
    getClassifier: (provider, id) => provider === classifier.provider && id === classifier.id ? classifier : undefined,
    classify,
  };
}

function openSession(cwd: string, models: RouterModels | undefined, seen: string[]): AgentSession {
  const agent = new Agent({
    model: hand("current"),
    streamFn(model) {
      seen.push(`${model.provider}/${model.id}`);
      const stream = createAssistantEventStream();
      const message = baseAssistant(model, [{ type: "text", text: "ok" }], "stop");
      message.usage = { input: 10, output: 4, totalTokens: 14, cost: { input: 1, output: 2, total: 3 } };
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
  return new AgentSession(SessionStore.create(join(cwd, "session.jsonl"), cwd), agent, models ? { models } : {});
}

function routesOf(cwd: string): Array<{ type?: string; choice?: string; score?: number; provider?: string; modelId?: string; reason?: string; usage?: { cost: { total: number | null } | null } }> {
  return readFileSync(join(cwd, "session.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes("\"type\":\"route\"") || line.includes("\"type\": \"route\""))
    .map((line) => JSON.parse(line) as { type?: string; choice?: string; score?: number; provider?: string; modelId?: string; reason?: string; usage?: { cost: { total: number | null } | null } });
}

test("an unset router makes no classifier call and writes no route", async (t) => {
  const cwd = directory(t);
  let calls = 0;
  const session = openSession(cwd, modelsFor(pricedClassifier, async () => {
    calls += 1;
    return choice(0.9);
  }), []);
  await session.prompt("fix the bug");
  await session.prompt("again");
  session.close();
  assert.equal(calls, 0);
  assert.equal(routesOf(cwd).length, 0);
  assert.equal(readRouterSettings(cwd), undefined);
});

test("the first choice routes once per session, and 0.5 selects strong", async (t) => {
  const cwd = directory(t);
  writeRouter(cwd, { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" });
  let calls = 0;
  const seen: string[] = [];
  const session = openSession(cwd, modelsFor(pricedClassifier, async (_model, context) => {
    calls += 1;
    assert.equal(context.state, "fix the bug");
    assert.equal(context.questions.route?.type, "choice");
    assert.deepEqual(Object.keys(context.questions.route?.criteria ?? {}), ["standard", "complex"]);
    return choice(0.5);
  }), seen);
  await session.prompt("fix the bug");
  await session.prompt("again");
  session.close();
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["hand/strong", "hand/strong"]);
  const [route] = routesOf(cwd);
  assert.equal(route?.choice, "complex");
  assert.equal(route?.score, 0.5);
  assert.equal(route?.provider, "hand");
  assert.equal(route?.modelId, "strong");
  assert.equal(route?.reason, undefined);
  const jev = usageCost(pricedClassifier, { input: 1_000_000, output: 0 });
  assert.ok(jev?.total !== null && jev?.total !== undefined);
  const cost = SessionStore.open(join(cwd, "session.jsonl")).cost();
  assert.equal(cost?.input, 1 + 1 + (jev?.input ?? 0));
  assert.equal(cost?.output, 2 + 2 + (jev?.output ?? 0));
  assert.equal(cost?.total, 3 + 3 + (jev?.total ?? 0));
  const reopened = new AgentSession(SessionStore.open(join(cwd, "session.jsonl")), new Agent({
    model: hand("current"),
    streamFn(model) {
      seen.push(`re:${model.id}`);
      const stream = createAssistantEventStream();
      stream.push({ type: "done", reason: "stop", message: baseAssistant(model, [{ type: "text", text: "ok" }], "stop") });
      return stream;
    },
  }), { models: modelsFor(pricedClassifier, async () => { calls += 1; return choice(0.1); }) });
  await reopened.prompt("later");
  reopened.close();
  assert.equal(calls, 1);
  assert.equal(seen.at(-1), "re:strong");
});

test("a complex probability below 0.5 selects cheap", async (t) => {
  const cwd = directory(t);
  writeRouter(cwd, { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" });
  const seen: string[] = [];
  const session = openSession(cwd, modelsFor(pricedClassifier, async () => choice(0.499, "standard")), seen);
  await session.prompt("rename a variable");
  session.close();
  assert.deepEqual(seen, ["hand/cheap"]);
  assert.equal(routesOf(cwd)[0]?.choice, "standard");
  assert.equal(routesOf(cwd)[0]?.score, 0.499);
});

test("classifier failure keeps the current model and records the reason", async (t) => {
  const cwd = directory(t);
  writeRouter(cwd, { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" });
  let calls = 0;
  const seen: string[] = [];
  const session = openSession(cwd, modelsFor(pricedClassifier, async () => {
    calls += 1;
    if (calls === 1) {
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        stopReason: "error",
        errorMessage: "System One API returned 500: unavailable",
        answers: {},
      };
    }
    return choice(0.9);
  }), seen);
  await session.prompt("fix the bug");
  await session.prompt("again");
  session.close();
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["hand/current", "hand/current"]);
  assert.equal(routesOf(cwd)[0]?.reason, "System One API returned 500: unavailable");
  assert.equal(routesOf(cwd)[0]?.modelId, "current");
  assert.equal(routesOf(cwd).length, 1);
});

test("a missing classifier price makes the session cost null", async (t) => {
  const cwd = directory(t);
  writeRouter(cwd, { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" });
  const unpriced: ClassifierModel = { ...pricedClassifier, cost: undefined };
  const seen: string[] = [];
  const session = openSession(cwd, modelsFor(unpriced, async () => choice(0.9)), seen);
  await session.prompt("fix the bug");
  session.close();
  assert.deepEqual(seen, ["hand/strong"]);
  assert.equal(routesOf(cwd)[0]?.usage?.cost, null);
  assert.equal(SessionStore.open(join(cwd, "session.jsonl")).cost(), null);
});

test("TypeSafe is called with TYPESAFE_API_KEY only, and a different env name does not send", async (t) => {
  const cwd = directory(t);
  writeRouter(cwd, { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" });
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ts-key");
    const body = JSON.parse(String(init?.body)) as { model?: string; questions?: { route?: { type?: string; criteria?: Record<string, string> } } };
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions?.route?.type, "choice");
    assert.deepEqual(Object.keys(body.questions?.route?.criteria ?? {}), ["standard", "complex"]);
    return Response.json({
      answers: { route: { type: "choice", choice: "complex", confidence: 0.5, probabilities: { standard: 0.5, complex: 0.5 } } },
      usage: { input_tokens: 1000, output_tokens: 10 },
    });
  };
  const keyed = createModels({ env: { TYPESAFE_API_KEY: "ts-key" } });
  keyed.setProvider(typesafeProvider({ fetch: fetchImpl }));
  const seen: string[] = [];
  const session = openSession(cwd, {
    getModel: (provider, id) => provider === "hand" ? hand(id) : undefined,
    getClassifier: (provider, id) => keyed.getClassifier(provider, id),
    classify: (model, context, options) => keyed.classify(model, context, options),
  }, seen);
  await session.prompt("fix the bug");
  await session.prompt("again");
  session.close();
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["hand/strong", "hand/strong"]);

  const other = directory(t);
  writeRouter(other, { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" });
  let leaked = 0;
  const blocked = createModels({ env: { TYPESAFE_JEV_API_KEY: "ts-key" } });
  blocked.setProvider(typesafeProvider({ fetch: async () => { leaked += 1; return new Response("no"); } }));
  const missed: string[] = [];
  const fallback = openSession(other, {
    getModel: (provider, id) => provider === "hand" ? hand(id) : undefined,
    getClassifier: (provider, id) => blocked.getClassifier(provider, id),
    classify: (model, context, options) => blocked.classify(model, context, options),
  }, missed);
  await fallback.prompt("fix the bug");
  fallback.close();
  assert.equal(leaked, 0);
  assert.deepEqual(missed, ["hand/current"]);
  assert.match(routesOf(other)[0]?.reason ?? "", /not configured/);
});

test("Jev is not in the model picker or the login model list", (t) => {
  const cwd = directory(t);
  const models = codingModels({
    provider: "deepseek",
    model: "deepseek-flash",
    cwd,
    credentialsFile: join(cwd, "credentials.json"),
  });
  const listed = listedHostModels(models);
  assert.equal(listed.some((model) => `${model.provider}/${model.id}`.toLowerCase().includes("jev")), false);
  assert.equal(listed.some((model) => model.provider === "deepseek" && model.id === "deepseek-flash"), true);
  assert.equal(builtinModelSpecs("openrouter").some((spec) => spec.toLowerCase().includes("jev")), false);
  assert.equal(builtinModelSpecs("openrouter").length > 0, true);
  assert.equal(builtinModelSpecs("typesafe").length, 0);
});

test("packages/agent does not mention jev or typesafe", () => {
  const files = walk(agentPackage);
  assert.equal(files.length > 0, true);
  for (const file of files) {
    const text = readFileSync(file, "utf8").toLowerCase();
    assert.equal(text.includes("jev"), false, file);
    assert.equal(text.includes("typesafe"), false, file);
  }
});

test("a configured router exits 1 when strong or cheap has no key", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  writeRouter(cwd, {
    classifier: "typesafe/jev-latest",
    strong: "openai/gpt-4o-mini",
    cheap: "deepseek/deepseek-flash",
  });
  const env: NodeJS.ProcessEnv = { ...process.env, DEEPSEEK_API_KEY: "sk-deepseek", AMAZME_CREDENTIALS: join(cwd, "credentials.json") };
  delete env.OPENAI_API_KEY;
  delete env.TYPESAFE_API_KEY;
  delete env.TYPESAFE_JEV_API_KEY;
  const result = await runCli(["--cwd", cwd, "hi"], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /router strong openai\/gpt-4o-mini is not configured: set OPENAI_API_KEY or run amazme login/);
  assert.equal(result.stderr.includes("TYPESAFE_JEV_API_KEY"), false);
  const broken = directory(t);
  mkdirSync(join(broken, ".amazme"), { recursive: true });
  writeFileSync(settingsFile(broken), `${JSON.stringify({ router: { classifier: "typesafe/jev-latest" } })}\n`);
  const invalid = await runCli(["--cwd", broken, "hi"], env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /classifier, strong, and cheap/);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|md|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out\n${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
