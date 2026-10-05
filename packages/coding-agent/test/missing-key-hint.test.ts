import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a missing deepseek key tells the user amazme login api-key --provider deepseek", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amazme-key-hint-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  env.AMAZME_CREDENTIALS = join(cwd, "credentials.json");
  env.AMAZME_DEVICE_ID_FILE = join(cwd, "device-id");
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, "--cwd", cwd, "hi"], {
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
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr.trim(),
    "deepseek is not configured: set DEEPSEEK_API_KEY or run amazme login api-key --provider deepseek",
  );
});
