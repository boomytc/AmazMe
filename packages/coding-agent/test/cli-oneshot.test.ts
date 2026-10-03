import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repo,
      env: {
        ...process.env,
        AMAZME_CREDENTIALS: join(cwd, "credentials.json"),
        AMAZME_DEVICE_ID_FILE: join(cwd, "device-id"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out\n${stdout}\n${stderr}`));
    }, 15_000);
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

test("a one-shot prompt prints the last assistant text and exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-oneshot-"));
  const result = await runCli(["--cwd", dir, "一句话"], dir);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^faux:一句话\n$/);
  assert.equal(result.stdout.includes("\x1b[?1049h"), false);
  const files = readdirSync(join(dir, ".amazme", "sessions"));
  const raw = readFileSync(join(dir, ".amazme", "sessions", files[0] ?? ""), "utf8");
  assert.match(raw, /"version":3/);
  assert.match(raw, /一句话/);
});

test("login without a provider still fails before any session or screen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-login-"));
  const result = await runCli(["login"], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /login requires --provider/);
  assert.equal(result.stdout.includes("\x1b[?1049h"), false);
  assert.equal(result.stdout.includes("faux:"), false);
});

test("no prompt and a pipe stays the missing-prompt exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-noprompt-"));
  const result = await runCli(["--cwd", dir], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing prompt/);
  assert.equal(result.stdout, "");
});
