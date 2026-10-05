import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installationRoot, updateInstallation } from "../src/update.ts";

test("amazme update fast-forwards a clean checkout and refuses a dirty one", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "amz-update-"));
  const origin = join(root, "origin");
  const checkout = join(root, "checkout");
  try {
    mkdirSync(origin);
    await git(origin, ["init", "-b", "main"]);
    await git(origin, ["config", "user.email", "test@example.com"]);
    await git(origin, ["config", "user.name", "test"]);
    writeFileSync(join(origin, "package.json"), "{\"name\":\"fixture\",\"private\":true}\n");
    await git(origin, ["add", "package.json"]);
    await git(origin, ["commit", "-m", "init"]);
    await git(root, ["clone", origin, checkout]);
    await git(checkout, ["config", "user.email", "test@example.com"]);
    await git(checkout, ["config", "user.name", "test"]);
    writeFileSync(join(checkout, "note.txt"), "dirty\n");
    const before = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(() => updateInstallation(checkout, { inherit: false }), /未提交的改动/);
    assert.equal((await git(checkout, ["rev-parse", "HEAD"])).trim(), before);
    rmSync(join(checkout, "note.txt"));
    writeFileSync(join(origin, "package.json"), "{\"name\":\"fixture\",\"private\":true,\"version\":\"1.0.0\"}\n");
    await git(origin, ["add", "package.json"]);
    await git(origin, ["commit", "-m", "bump"]);
    const text = await updateInstallation(checkout, { inherit: false });
    const after = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    assert.match(text, new RegExp(after.slice(0, 7)));
    assert.notEqual(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installationRoot is the checkout that contains this command", () => {
  assert.equal(installationRoot(), fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, ""));
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout));
    });
  });
}
