import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("login offers account and api-key entries, and an API key is saved without being echoed", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-login-"));
  const credentials = join(cwd, "credentials.json");
  const env = { ...process.env, AMAZME_CREDENTIALS: credentials };
  try {
    const usage = await run(["login"], env);
    assert.match(usage.stdout, /login account/);
    assert.match(usage.stdout, /login api-key/);
    const accounts = await run(["login", "account"], env);
    assert.match(accounts.stdout, /^xai\t/m);
    assert.match(accounts.stdout, /^openai-codex\t/m);
    const keys = await run(["login", "api-key"], env);
    assert.match(keys.stdout, /^deepseek\t/m);
    assert.match(keys.stdout, /^typesafe\t/m);
    assert.match(keys.stdout, /^xiaomi\t/m);
    const saved = await run(["login", "api-key", "--provider", "deepseek"], env, "sk-deepseek\n");
    assert.equal(saved.code, 0);
    assert.equal(saved.stdout.includes("sk-deepseek"), false);
    assert.match(saved.stdout, /已保存 deepseek/);
    assert.match(readFileSync(credentials, "utf8"), /sk-deepseek/);
    const both = await run(["login", "--provider", "xai"], env);
    assert.notEqual(both.code, 0);
    assert.match(both.stderr, /login account --provider xai/);
    assert.match(both.stderr, /login api-key --provider xai/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function run(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: root,
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
