import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/testing";
import { startCodingHost } from "../src/host.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));

function directory(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeScope(cwd: string, spec: string): void {
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(join(cwd, ".amazme", "project.json"), `${JSON.stringify({
    trusted: false,
    settings: {},
    names: {},
    scopedModels: [spec],
  })}\n`);
}

test("standalone bridge uses the host cwd, not its own process cwd", { timeout: 20_000 }, async (t) => {
  const hostCwd = directory(t, "amz-bridge-host-");
  const bridgeCwd = directory(t, "amz-bridge-proc-");
  assert.notEqual(hostCwd, bridgeCwd);
  assert.notEqual(hostCwd, process.cwd());
  writeScope(hostCwd, "marker/from-host");
  writeScope(bridgeCwd, "marker/from-process");
  const socket = join(hostCwd, "host.sock");
  const models = createModels();
  models.setProvider(fauxProvider({ respond: () => { throw new Error("bridge cwd does not call the model"); } }));
  const host = await startCodingHost({ cwd: hostCwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());

  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "bridge", "--socket", socket, "--port", "0"], {
    cwd: bridgeCwd,
    env: {
      ...process.env,
      AMAZME_CREDENTIALS: join(bridgeCwd, "credentials.json"),
      AMAZME_DEVICE_ID_FILE: join(bridgeCwd, "device-id"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const start = Date.now();
  while (!stdout.includes("\n")) {
    if (child.exitCode !== null) throw new Error(`bridge exited before announcing a url\n${stderr}`);
    if (Date.now() - start > 15_000) throw new Error(`bridge did not announce a url\n${stdout}\n${stderr}`);
    await delay(20);
  }
  const announced = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { url?: string };
  if (!announced.url) throw new Error(`bridge did not print a url\n${stdout}`);
  const view = await fetch(`${announced.url}view`);
  assert.equal(view.status, 200);
  const body = await view.json() as { models: Array<{ provider: string; modelId: string }> };
  assert.deepEqual(body.models, [{ provider: "marker", modelId: "from-host" }]);

  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
});
