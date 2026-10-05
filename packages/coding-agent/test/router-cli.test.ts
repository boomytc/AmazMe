import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, usageCost, type ClassifierModel } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { typesafeProvider } from "@amazme/ai/providers/typesafe";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { FileCredentialStore } from "../src/credentials.ts";
import { HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";
import { readLatestRoute } from "../src/route-record.ts";
import { settingsFile, type RouterSettings } from "../src/settings.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const router: RouterSettings = {
  classifier: "typesafe/jev-latest",
  strong: "deepseek/deepseek-v4-pro",
  cheap: "deepseek/deepseek-flash",
};

interface FetchLog {
  typesafe: number;
  models: string[];
}

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amazme-router-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRouter(cwd: string): void {
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(settingsFile(cwd), `${JSON.stringify({ router })}\n`);
}

function credentials(cwd: string): void {
  writeFileSync(join(cwd, "credentials.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "sk-test" } })}\n`);
}

function writePreload(cwd: string, mode: "route" | "unauthorized"): string {
  const preload = join(cwd, "fetch-router.mjs");
  const log = join(cwd, "fetch-log.json");
  writeFileSync(preload, `
import { readFileSync, writeFileSync } from "node:fs";
const log = ${JSON.stringify(log)};
function note(update) {
  let prev = { typesafe: 0, models: [] };
  try { prev = JSON.parse(readFileSync(log, "utf8")); } catch { /* first call */ }
  writeFileSync(log, JSON.stringify({
    typesafe: prev.typesafe + (update.typesafe ?? 0),
    models: update.model ? [...prev.models, update.model] : prev.models,
  }));
}
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const raw = init && typeof init.body === "string" ? init.body : "{}";
  const parsed = JSON.parse(raw);
  if (url.includes("typesafe.ai") || url.includes("systemone")) {
    note({ typesafe: 1 });
    if (${mode === "unauthorized" ? "true" : "false"}) return new Response("nope", { status: 401 });
    const state = typeof parsed.state === "string" ? parsed.state : "";
    const complex = state.includes("complex-task") ? 0.9 : 0.1;
    const choice = complex >= 0.5 ? "complex" : "standard";
    return Response.json({
      answers: { route: { type: "choice", choice, confidence: complex, probabilities: { standard: 1 - complex, complex } } },
      usage: { input_tokens: 1000000, output_tokens: 0 },
    });
  }
  note({ model: typeof parsed.model === "string" ? parsed.model : "" });
  const sse = [
    "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "echo" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }),
    "",
    "data: [DONE]",
    "",
  ].join("\\n");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};
`);
  return preload;
}

function readLog(cwd: string): FetchLog {
  return JSON.parse(readFileSync(join(cwd, "fetch-log.json"), "utf8")) as FetchLog;
}

function runCli(args: string[], cwd: string, stdin: string | undefined, env: NodeJS.ProcessEnv, preload: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = { ...process.env };
  delete base.DEEPSEEK_API_KEY;
  delete base.TYPESAFE_API_KEY;
  base.AMAZME_CREDENTIALS = join(cwd, "credentials.json");
  base.AMAZME_DEVICE_ID_FILE = join(cwd, "device-id");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, "--import", "tsx", cli, ...args], {
      cwd: repo,
      env: { ...base, ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined && child.stdin) child.stdin.end(stdin);
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

test("oneshot routes a simple prompt to cheap and a complex prompt to strong", async (t) => {
  const cwd = directory(t);
  credentials(cwd);
  writeRouter(cwd);
  const preload = writePreload(cwd, "route");
  const simple = await runCli(["--cwd", cwd, "simple-task"], cwd, undefined, { TYPESAFE_API_KEY: "sk-typesafe" }, preload);
  assert.equal(simple.code, 0, simple.stderr);
  assert.deepEqual(readLog(cwd), { typesafe: 1, models: ["deepseek-flash"] });
  const simpleRoute = readLatestRoute(cwd);
  assert.equal(simpleRoute?.choice, "standard");
  assert.equal(simpleRoute?.modelId, "deepseek-flash");

  rmSync(join(cwd, ".amazme", "runtime"), { recursive: true, force: true });
  rmSync(join(cwd, "fetch-log.json"), { force: true });
  const complex = await runCli(["--cwd", cwd, "complex-task"], cwd, undefined, { TYPESAFE_API_KEY: "sk-typesafe" }, preload);
  assert.equal(complex.code, 0, complex.stderr);
  assert.deepEqual(readLog(cwd), { typesafe: 1, models: ["deepseek-v4-pro"] });
  assert.equal(readLatestRoute(cwd)?.choice, "complex");
  assert.equal(readLatestRoute(cwd)?.modelId, "deepseek-v4-pro");
});

test("continue reuses the routed model and does not call TypeSafe again", async (t) => {
  const cwd = directory(t);
  credentials(cwd);
  writeRouter(cwd);
  const preload = writePreload(cwd, "route");
  const env = { TYPESAFE_API_KEY: "sk-typesafe" };
  const first = await runCli(["--cwd", cwd, "complex-task"], cwd, undefined, env, preload);
  assert.equal(first.code, 0, first.stderr);
  const second = await runCli(["--cwd", cwd, "--continue", "simple-task"], cwd, undefined, env, preload);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(readLog(cwd), { typesafe: 1, models: ["deepseek-v4-pro", "deepseek-v4-pro"] });
});

test("json and jsonl classify before the chat request", async (t) => {
  const cwd = directory(t);
  credentials(cwd);
  writeRouter(cwd);
  const preload = writePreload(cwd, "route");
  const env = { TYPESAFE_API_KEY: "sk-typesafe" };
  const json = await runCli(["--cwd", cwd, "--json", "complex-task"], cwd, undefined, env, preload);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(readLog(cwd).models[0], "deepseek-v4-pro");
  rmSync(join(cwd, ".amazme", "runtime"), { recursive: true, force: true });
  rmSync(join(cwd, "fetch-log.json"), { force: true });
  const jsonl = await runCli(
    ["--cwd", cwd, "--jsonl"],
    cwd,
    `${JSON.stringify({ type: "prompt", text: "complex-task" })}\n`,
    env,
    preload,
  );
  assert.equal(jsonl.code, 0, jsonl.stderr);
  assert.deepEqual(readLog(cwd), { typesafe: 1, models: ["deepseek-v4-pro"] });
});

test("an unset router makes no TypeSafe call", async (t) => {
  const cwd = directory(t);
  credentials(cwd);
  const preload = writePreload(cwd, "route");
  const result = await runCli(["--cwd", cwd, "complex-task"], cwd, undefined, {}, preload);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readLog(cwd), { typesafe: 0, models: ["deepseek-flash"] });
  assert.equal(readLatestRoute(cwd), undefined);
});

test("a rejected classifier key keeps the current model and records the reason", async (t) => {
  const cwd = directory(t);
  credentials(cwd);
  writeRouter(cwd);
  const preload = writePreload(cwd, "unauthorized");
  const env = { TYPESAFE_API_KEY: "sk-bad" };
  const result = await runCli(["--cwd", cwd, "complex-task"], cwd, undefined, env, preload);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readLog(cwd), { typesafe: 1, models: ["deepseek-flash"] });
  const route = readLatestRoute(cwd);
  assert.match(route?.reason ?? "", /401/);
  assert.equal(route?.modelId, "deepseek-flash");
  const again = await runCli(["--cwd", cwd, "--continue", "complex-task"], cwd, undefined, env, preload);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(readLog(cwd).typesafe, 1);
});

test("serve classifies once before the first model call", async (t) => {
  const cwd = directory(t);
  credentials(cwd);
  writeRouter(cwd);
  const preload = writePreload(cwd, "route");
  const socket = join(cwd, "host.sock");
  const base = { ...process.env };
  delete base.DEEPSEEK_API_KEY;
  delete base.TYPESAFE_API_KEY;
  const child = spawn(process.execPath, ["--import", preload, "--import", "tsx", cli, "serve", "--socket", socket, "--cwd", cwd], {
    cwd: repo,
    env: {
      ...base,
      AMAZME_CREDENTIALS: join(cwd, "credentials.json"),
      AMAZME_DEVICE_ID_FILE: join(cwd, "device-id"),
      TYPESAFE_API_KEY: "sk-typesafe",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const ready = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not listen\n${stdout}\n${stderr}`)), 20_000);
    child.stdout.on("data", () => {
      const line = stdout.split("\n").find((item) => item.includes("socket"));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line).socket as string);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code ?? 1}\n${stderr}`));
    });
  });
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: ready }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(HOST_RUNTIME_ID);
    const lane = remote.lane("main");
    const admitted = await lane.accept({ kind: "prompt", text: "complex-task" });
    let outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
    if (outcome.kind === "waiting") outcome = await lane.drive(outcome.operationId, { waitForRetry: true });
    assert.equal(outcome.kind, "settled");
    if (outcome.kind === "settled") assert.equal(outcome.result.status, "completed");
    const snap = await lane.snapshot();
    assert.equal(readLog(cwd).typesafe, 1);
    assert.deepEqual(readLog(cwd).models, ["deepseek-v4-pro"]);
    const route = readLatestRoute(cwd);
    assert.equal(route?.modelId, "deepseek-v4-pro");
    assert.equal(route?.usage?.cost === null, false);
    assert.equal(snap.activity.usage.total.input, (snap.activity.usage.lastTurn?.input ?? 0) + (route?.usage?.input ?? 0));
    const chat = snap.activity.usage.lastTurn?.cost?.total;
    const jev = route?.usage?.cost?.total;
    assert.equal(typeof chat, "number");
    assert.equal(typeof jev, "number");
    assert.equal(snap.activity.usage.total.cost?.total, (chat ?? 0) + (jev ?? 0));
  } finally {
    await client.dispose();
  }
});

test("durable footer cost adds priced Jev usage and becomes null when Jev has no price", async (t) => {
  const cwd = directory(t);
  const cred = join(cwd, "credentials.json");
  writeFileSync(cred, `${JSON.stringify({
    deepseek: { type: "api_key", key: "sk-test" },
    typesafe: { type: "api_key", key: "sk-typesafe" },
  })}\n`);
  writeRouter(cwd);
  const calls = { typesafe: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const raw = init && typeof init.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(raw) as { state?: string };
    if (url.includes("typesafe.ai") || url.includes("systemone")) {
      calls.typesafe += 1;
      const complex = parsed.state?.includes("complex-task") ? 0.9 : 0.1;
      return Response.json({
        answers: {
          route: {
            type: "choice",
            choice: complex >= 0.5 ? "complex" : "standard",
            confidence: complex,
            probabilities: { standard: 1 - complex, complex },
          },
        },
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      });
    }
    const sse = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "echo" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const models = createModels({ store: new FileCredentialStore(cred), env: {} });
  models.setProvider(deepseekProvider({ fetch: fetchImpl }));
  models.setProvider(typesafeProvider({ fetch: fetchImpl }));
  const host = await startCodingHost({
    cwd,
    socket: join(cwd, "host.sock"),
    provider: "deepseek",
    model: "deepseek-flash",
    models,
  });
  t.after(() => host.close("abort"));
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: host.socket }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(HOST_RUNTIME_ID);
    const lane = remote.lane("main");
    const admitted = await lane.accept({ kind: "prompt", text: "complex-task" });
    let outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
    if (outcome.kind === "waiting") outcome = await lane.drive(outcome.operationId, { waitForRetry: true });
    assert.equal(outcome.kind, "settled");
    const snap = await lane.snapshot();
    const route = readLatestRoute(cwd);
    const classifier = models.getClassifier("typesafe", "jev-latest");
    const priced = classifier ? usageCost(classifier, { input: 1_000_000, output: 0 }) : null;
    assert.equal(calls.typesafe, 1);
    assert.equal(route?.usage?.cost?.total, priced?.total ?? null);
    const chat = snap.activity.usage.lastTurn?.cost?.total;
    assert.equal(typeof chat, "number");
    assert.equal(snap.activity.usage.total.cost?.total, (chat ?? 0) + (priced?.total ?? 0));

    const again = await lane.accept({ kind: "prompt", text: "simple-task" });
    let second = await lane.drive(again.operationId, { waitForRetry: true });
    if (second.kind === "waiting") second = await lane.drive(second.operationId, { waitForRetry: true });
    assert.equal(calls.typesafe, 1);
  } finally {
    await client.dispose();
  }

  const unpriced = directory(t);
  writeFileSync(join(unpriced, "credentials.json"), `${JSON.stringify({
    deepseek: { type: "api_key", key: "sk-test" },
    typesafe: { type: "api_key", key: "sk-typesafe" },
  })}\n`);
  writeRouter(unpriced);
  const bare = createModels({ store: new FileCredentialStore(join(unpriced, "credentials.json")), env: {} });
  bare.setProvider(deepseekProvider({ fetch: fetchImpl }));
  bare.setProvider(typesafeProvider({ fetch: fetchImpl }));
  const original = bare.getClassifier.bind(bare);
  bare.getClassifier = (provider, id) => {
    const found = original(provider, id);
    if (!found) return undefined;
    const { cost: _cost, ...rest } = found;
    return rest as ClassifierModel;
  };
  const secondHost = await startCodingHost({
    cwd: unpriced,
    socket: join(unpriced, "host.sock"),
    provider: "deepseek",
    model: "deepseek-flash",
    models: bare,
  });
  t.after(() => secondHost.close("abort"));
  const secondClient = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: secondHost.socket }) });
  await secondClient.connect();
  try {
    const remote = new RuntimeClient(secondClient);
    await remote.attach(HOST_RUNTIME_ID);
    const lane = remote.lane("main");
    const admitted = await lane.accept({ kind: "prompt", text: "complex-task" });
    let outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
    if (outcome.kind === "waiting") outcome = await lane.drive(outcome.operationId, { waitForRetry: true });
    assert.equal(outcome.kind, "settled");
    const snap = await lane.snapshot();
    const route = readLatestRoute(unpriced);
    assert.equal(route?.usage?.cost, null);
    assert.equal(typeof snap.activity.usage.lastTurn?.cost?.total, "number");
    assert.equal(snap.activity.usage.total.cost, null);
    assert.equal(snap.activity.usage.total.input, (snap.activity.usage.lastTurn?.input ?? 0) + (route?.usage?.input ?? 0));
  } finally {
    await secondClient.dispose();
  }
});
