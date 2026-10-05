import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { builtinModelSpecs, commitProviderModels, saveApiKey } from "../src/login.ts";
import { codingLoginAccount } from "../src/tui/run.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-login-models-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function projectFile(cwd: string): string {
  return join(cwd, ".amazme", "project.json");
}

function modelsOf(cwd: string): string[] {
  return (JSON.parse(readFileSync(projectFile(cwd), "utf8")) as { scopedModels: string[] }).scopedModels;
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, cli, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

test("builtin chat specs come from getModels, and typesafe and faux are empty", () => {
  assert.deepEqual(builtinModelSpecs("deepseek"), ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  assert.deepEqual(builtinModelSpecs("typesafe"), []);
  assert.deepEqual(builtinModelSpecs("faux"), []);
});

test("deepseek api-key login writes both models, and a second login does not duplicate", async (t) => {
  const cwd = directory(t);
  const credentials = join(cwd, "credentials.json");
  const account = codingLoginAccount({ cwd, credentialsFile: credentials });
  const first = await account.saveApiKey!("deepseek", "sk-deepseek", "faux/faux-1");
  assert.equal(first, "已保存 deepseek，模型循环加入 3 个");
  assert.deepEqual(modelsOf(cwd), ["faux/faux-1", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  const before = readFileSync(projectFile(cwd), "utf8");
  const second = await account.saveApiKey!("deepseek", "sk-deepseek-2", "other/model");
  assert.equal(second, "已保存 deepseek，模型循环加入 0 个");
  assert.equal(readFileSync(projectFile(cwd), "utf8"), before);
  assert.match(readFileSync(credentials, "utf8"), /sk-deepseek-2/);
});

test("the first write puts the current lane model ahead of the provider list", async (t) => {
  const cwd = directory(t);
  const account = codingLoginAccount({ cwd, credentialsFile: join(cwd, "credentials.json") });
  const text = await account.saveApiKey!("deepseek", "sk-deepseek", "deepseek/deepseek-v4-pro");
  assert.equal(text, "已保存 deepseek，模型循环加入 2 个");
  assert.deepEqual(modelsOf(cwd), ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]);
});

test("hand-filled scoped models stay, and a non-empty list does not insert the lane model", async (t) => {
  const cwd = directory(t);
  mkdirSync(join(cwd, ".amazme"));
  writeFileSync(projectFile(cwd), `${JSON.stringify({
    trusted: true,
    settings: { theme: "dark" },
    names: { main: "工作" },
    scopedModels: ["notes", "local/hand-tuned", "deepseek/deepseek-flash"],
  }, null, 2)}\n`);
  const account = codingLoginAccount({ cwd, credentialsFile: join(cwd, "credentials.json") });
  const text = await account.saveApiKey!("deepseek", "sk-deepseek", "faux/faux-1");
  assert.equal(text, "已保存 deepseek，模型循环加入 1 个");
  const saved = JSON.parse(readFileSync(projectFile(cwd), "utf8")) as {
    trusted: boolean;
    settings: Record<string, string>;
    names: Record<string, string>;
    scopedModels: string[];
  };
  assert.equal(saved.trusted, true);
  assert.deepEqual(saved.settings, { theme: "dark" });
  assert.deepEqual(saved.names, { main: "工作" });
  assert.deepEqual(saved.scopedModels, ["notes", "local/hand-tuned", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
});

test("typesafe login stores the key and does not write models", async (t) => {
  const cwd = directory(t);
  const credentials = join(cwd, "credentials.json");
  mkdirSync(join(cwd, ".amazme"));
  writeFileSync(projectFile(cwd), `${JSON.stringify({ trusted: false, settings: {}, names: {}, scopedModels: ["local/hand-tuned"] }, null, 2)}\n`);
  const before = readFileSync(projectFile(cwd), "utf8");
  const account = codingLoginAccount({ cwd, credentialsFile: credentials });
  const text = await account.saveApiKey!("typesafe", "sk-typesafe");
  assert.equal(text, "已保存 typesafe，模型循环加入 0 个");
  assert.equal(readFileSync(projectFile(cwd), "utf8"), before);
  assert.equal(builtinModelSpecs("typesafe").some((spec) => spec.includes("jev")), false);
  assert.match(readFileSync(credentials, "utf8"), /sk-typesafe/);
});

test("an empty or rejected key and a failed account login do not write models", async (t) => {
  const cwd = directory(t);
  const credentials = join(cwd, "credentials.json");
  const account = codingLoginAccount({ cwd, credentialsFile: credentials });
  await assert.rejects(() => account.saveApiKey!("deepseek", ""), /API key is empty/);
  await assert.rejects(() => account.saveApiKey!("openai-codex", "sk-not-accepted"), /has no API key login/);
  await assert.rejects(() => account.login!("deepseek", () => undefined), /has no login/);
  await assert.rejects(() => saveApiKey("missing-provider", "sk-x", credentials), /has no API key login/);
  assert.equal(existsSync(projectFile(cwd)), false);
  assert.equal(existsSync(credentials), false);
});

test("login without a workspace says the models were not written", async (t) => {
  const cwd = directory(t);
  const credentials = join(cwd, "credentials.json");
  assert.equal(commitProviderModels("deepseek", undefined, "faux/faux-1"), "已保存 deepseek，当前没有工作区，未写入模型循环");
  const account = codingLoginAccount({ credentialsFile: credentials });
  const text = await account.saveApiKey!("deepseek", "sk-deepseek", "faux/faux-1");
  assert.equal(text, "已保存 deepseek，当前没有工作区，未写入模型循环");
  assert.equal(existsSync(projectFile(cwd)), false);
  assert.match(readFileSync(credentials, "utf8"), /sk-deepseek/);
});

test("CLI api-key login writes project.json in the process cwd", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  const env = { ...process.env, AMAZME_CREDENTIALS: join(cwd, "credentials.json") };
  const saved = await run(["login", "api-key", "--provider", "deepseek"], env, cwd, "sk-deepseek\n");
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(saved.stdout, "已保存 deepseek，模型循环加入 2 个\n");
  assert.deepEqual(modelsOf(cwd), ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  const again = await run(["login", "api-key", "--provider", "deepseek"], env, cwd, "sk-deepseek\n");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, "已保存 deepseek，模型循环加入 0 个\n");
  assert.deepEqual(modelsOf(cwd), ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
});

test("CLI login does not write models when the key is empty or OAuth fails", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  const env = {
    ...process.env,
    AMAZME_CREDENTIALS: join(cwd, "credentials.json"),
    AMAZME_DEVICE_ID_FILE: join(cwd, "device-id"),
  };
  const empty = await run(["login", "api-key", "--provider", "deepseek"], env, cwd, "\n");
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /API key is empty/);
  const oauth = await run(["login", "account", "--provider", "anthropic", "--callback-port", "1"], env, cwd);
  assert.notEqual(oauth.code, 0);
  assert.match(oauth.stderr, /EACCES|EADDRINUSE|EPERM/);
  assert.equal(existsSync(projectFile(cwd)), false);
  assert.equal(existsSync(join(cwd, "credentials.json")), false);
});
