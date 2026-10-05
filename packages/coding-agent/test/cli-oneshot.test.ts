import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/testing";
import { runPrint } from "../src/print-run.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[], cwd: string, stdin?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = { ...process.env };
  delete base.DEEPSEEK_API_KEY;
  base.AMAZME_CREDENTIALS = join(cwd, "credentials.json");
  base.AMAZME_DEVICE_ID_FILE = join(cwd, "device-id");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repo,
      env: { ...base, ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
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

test("help shows the deepseek default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-help-"));
  const result = await runCli(["--help"], dir);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /defaults: provider deepseek, model deepseek-flash/);
  assert.equal(result.stdout.includes("faux"), false);
  const serve = await runCli(["serve", "--help"], dir);
  assert.equal(serve.code, 0);
  assert.match(serve.stdout, /defaults: provider deepseek, model deepseek-flash/);
  assert.equal(serve.stdout.includes("faux"), false);
});

test("--provider faux is not a product provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-faux-"));
  const result = await runCli(["--cwd", dir, "--provider", "faux", "--model", "faux-1", "hi"], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown provider faux/);
  assert.equal(result.stdout.includes("faux:"), false);
  const serve = await runCli(["serve", "--socket", join(dir, "s.sock"), "--cwd", dir, "--provider", "faux", "--model", "faux-1"], dir);
  assert.equal(serve.code, 1);
  assert.match(serve.stderr, /unknown provider faux/);
});

test("a one-shot prompt uses deepseek-flash and does not open the alt screen", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-oneshot-"));
  const result = await runCli(["--cwd", dir, "一句话"], dir);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("faux:"), false);
  assert.equal(result.stdout.includes("\x1b[?1049h"), false);
  const raw = readFileSync(join(dir, ".amazme", "runtime", "workspace.jsonl"), "utf8");
  assert.match(raw, /一句话/);
  assert.match(raw, /deepseek-flash/);
  assert.match(raw, /apiKey/);
  assert.equal(raw.includes("faux:"), false);
});

test("continue and jsonl read the same workspace session as the one-shot prompt", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-continue-"));
  const first = await runCli(["--cwd", dir, "hello-tree"], dir);
  assert.equal(first.code, 0);
  assert.equal(first.stdout.includes("faux:"), false);
  const second = await runCli(["--cwd", dir, "--continue"], dir);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /hello-tree/);
  assert.equal(second.stdout.includes("faux:"), false);
  const jsonl = await runCli(["--cwd", dir, "--jsonl"], dir, `${JSON.stringify({ type: "prompt", text: "second-line" })}\n`);
  assert.equal(jsonl.code, 0);
  assert.match(jsonl.stdout, /"text":"second-line"/);
  assert.match(jsonl.stdout, /hello-tree/);
  assert.equal(jsonl.stdout.includes("faux:"), false);
});

test("a one-shot without the sandbox runner prints SANDBOX_UNAVAILABLE", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const dir = mkdtempSync(join(tmpdir(), "amazme-oneshot-nosandbox-"));
  const emptyPath = mkdtempSync(join(tmpdir(), "amazme-empty-path-"));
  try {
    const result = await runCli(
      ["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash", "ping"],
      dir,
      undefined,
      { PATH: emptyPath },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SANDBOX_UNAVAILABLE: bwrap is required/);
    assert.equal(result.stderr.includes("internal server error"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyPath, { recursive: true, force: true });
  }
});

test("runPrint prints assistant text from the model the caller supplies", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-print-"));
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (context) => {
      const text = [...context.messages].reverse().find((message) => message.role === "user");
      return fauxAssistant(`faux:${text ? messageText(text) : ""}`);
    },
  }));
  const stdout = await captureStdout(() => runPrint({
    cwd: dir,
    provider: "faux",
    model: "faux-1",
    models,
    prompt: "一句话",
    continueSession: false,
    json: false,
  }));
  assert.equal(stdout, "faux:一句话\n");
  const raw = readFileSync(join(dir, ".amazme", "runtime", "workspace.jsonl"), "utf8");
  assert.match(raw, /一句话/);
  assert.match(raw, /faux:一句话/);
});

function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return run().finally(() => {
    process.stdout.write = original;
  }).then(() => chunks.join(""));
}

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
