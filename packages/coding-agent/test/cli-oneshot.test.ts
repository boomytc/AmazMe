import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runCli(args: string[], cwd: string, stdin?: string, env?: NodeJS.ProcessEnv, preload?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const nodeArgs = preload ? ["--import", preload, "--import", "tsx", cli, ...args] : ["--import", "tsx", cli, ...args];
  const base = { ...process.env };
  delete base.DEEPSEEK_API_KEY;
  base.AMAZME_CREDENTIALS = join(cwd, "credentials.json");
  base.AMAZME_DEVICE_ID_FILE = join(cwd, "device-id");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
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

test("a one-shot prompt refuses before a session when deepseek has no key", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-oneshot-"));
  const result = await runCli(["--cwd", dir, "一句话"], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /deepseek is not configured: set DEEPSEEK_API_KEY or run amazme login/);
  assert.equal(result.stdout.includes("faux:"), false);
  assert.equal(result.stdout.includes("\x1b[?1049h"), false);
  assert.equal(existsSync(join(dir, ".amazme")), false);
});

test("continue and jsonl refuse before a session when deepseek has no key", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-continue-"));
  const first = await runCli(["--cwd", dir, "hello-tree"], dir);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /deepseek is not configured: set DEEPSEEK_API_KEY or run amazme login/);
  const second = await runCli(["--cwd", dir, "--continue"], dir);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /deepseek is not configured: set DEEPSEEK_API_KEY or run amazme login/);
  assert.equal(second.stdout.includes("hello-tree"), false);
  const jsonl = await runCli(["--cwd", dir, "--jsonl"], dir, `${JSON.stringify({ type: "prompt", text: "second-line" })}\n`);
  assert.equal(jsonl.code, 1);
  assert.match(jsonl.stderr, /deepseek is not configured: set DEEPSEEK_API_KEY or run amazme login/);
  assert.equal(jsonl.stdout.includes("second-line"), false);
  assert.equal(existsSync(join(dir, ".amazme")), false);
});

test("continue and jsonl read the same workspace session as the one-shot prompt", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-continue-e2e-"));
  const preload = echoPreload(dir);
  const args = ["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash"];
  try {
    const first = await runCli([...args, "hello-tree"], dir, undefined, undefined, preload);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^echo:hello-tree\n$/);
    const second = await runCli([...args, "--continue"], dir, undefined, undefined, preload);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /hello-tree/);
    assert.match(second.stdout, /echo:hello-tree/);
    const jsonl = await runCli([...args, "--jsonl"], dir, `${JSON.stringify({ type: "prompt", text: "second-line" })}\n`, undefined, preload);
    assert.equal(jsonl.code, 0, jsonl.stderr);
    assert.match(jsonl.stdout, /"text":"echo:second-line"/);
    assert.match(jsonl.stdout, /hello-tree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      { PATH: emptyPath, DEEPSEEK_API_KEY: "local-test-key" },
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
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return original.call(process.stdout, chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stdout.write;
  return run().finally(() => {
    process.stdout.write = original;
  }).then(() => chunks.join(""));
}

test("login without a provider still fails before any session or screen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-login-"));
  const result = await runCli(["login"], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /amazme login account/);
  assert.match(result.stderr, /amazme login api-key/);
  assert.equal(result.stdout, "");
  assert.equal(result.stdout.includes("\x1b[?1049h"), false);
  assert.equal(existsSync(join(dir, ".amazme")), false);
});

test("no prompt and a pipe stays the missing-prompt exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-noprompt-"));
  const result = await runCli(["--cwd", dir], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing prompt/);
  assert.equal(result.stdout, "");
});

test("--version and -v print the coding-agent package version without a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-version-"));
  const parsed: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json has no version");
  }
  try {
    for (const flag of ["--version", "-v"]) {
      const result = await runCli([flag, "--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash"], dir);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `${parsed.version}\n`);
      assert.equal(existsSync(join(dir, ".amazme")), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown option exits 1 and does not create a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-bogus-"));
  try {
    const result = await runCli(["--cwd", dir, "--bogus"], dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown option --bogus/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(dir, ".amazme")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt after -- may start with a dash", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-dash-"));
  const preload = echoPreload(dir);
  try {
    const result = await runCli(
      ["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash", "--", "-x", "是什么"],
      dir,
      undefined,
      undefined,
      preload,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^echo:-x 是什么\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong key in $HOME prints the 401 instead of an internal error", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-401-home-"));
  const preload = join(dir, "fetch-401.mjs");
  writeFileSync(preload, [
    "globalThis.fetch = async () => new Response(",
    "JSON.stringify({ error: { message: \"invalid api key\", type: \"authentication_error\" } }),",
    "{ status: 401, headers: { \"content-type\": \"application/json\" } },",
    ");",
  ].join("\n"));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-wrong" } }));
  try {
    const result = await runCli(
      ["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash", "ping"],
      dir,
      undefined,
      { HOME: dir },
      preload,
    );
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /401/);
    assert.equal(result.stderr.includes("internal server error"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong key that gets 401 is printed on stderr and in json", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-401-"));
  const preload = join(dir, "fetch-401.mjs");
  writeFileSync(preload, [
    "globalThis.fetch = async () => new Response(",
    "JSON.stringify({ error: { message: \"invalid api key\", type: \"authentication_error\" } }),",
    "{ status: 401, headers: { \"content-type\": \"application/json\" } },",
    ");",
  ].join("\n"));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-wrong" } }));
  const prompt = ["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash", "ping"];
  try {
    const plain = await runCli(prompt, dir, undefined, undefined, preload);
    assert.equal(plain.code, 1, plain.stderr);
    assert.match(plain.stderr, /401/);
    assert.equal(plain.stdout, "");
    const json = await runCli(["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash", "--json", "ping"], dir, undefined, undefined, preload);
    assert.equal(json.code, 1, json.stderr);
    assert.match(json.stderr, /401/);
    const errors = json.stdout.trim().split("\n").flatMap((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "error") return [];
      const message = "message" in value && typeof value.message === "string" ? value.message : "";
      return [message];
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong key that gets 401 exits 1 in jsonl", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-401-jsonl-"));
  const preload = join(dir, "fetch-401.mjs");
  writeFileSync(preload, [
    "globalThis.fetch = async () => new Response(",
    "JSON.stringify({ error: { message: \"invalid api key\", type: \"authentication_error\" } }),",
    "{ status: 401, headers: { \"content-type\": \"application/json\" } },",
    ");",
  ].join("\n"));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-wrong" } }));
  try {
    const jsonl = await runCli(
      ["--cwd", dir, "--provider", "deepseek", "--model", "deepseek-flash", "--jsonl"],
      dir,
      `${JSON.stringify({ type: "prompt", text: "ping" })}\n`,
      undefined,
      preload,
    );
    assert.equal(jsonl.code, 1, jsonl.stderr);
    assert.match(jsonl.stderr, /401/);
    const errors = jsonl.stdout.trim().split("\n").flatMap((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "error") return [];
      const message = "message" in value && typeof value.message === "string" ? value.message : "";
      return [message];
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--resume -v is a session name, not a version query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-resume-v-"));
  const parsed: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json has no version");
  }
  try {
    for (const args of [
      ["--resume", "-v", "--cwd", dir, "ping"],
      ["--cwd", dir, "--resume", "--version", "ping"],
    ]) {
      const result = await runCli(args, dir);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /deepseek is not configured/);
      assert.equal(result.stdout, "");
      assert.equal(result.stdout.includes(parsed.version), false);
      assert.equal(existsSync(join(dir, ".amazme")), false);
    }
    const later = await runCli(["--cwd", dir, "-v"], dir);
    assert.equal(later.code, 0, later.stderr);
    assert.equal(later.stdout, `${parsed.version}\n`);
    assert.equal(existsSync(join(dir, ".amazme")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function echoPreload(dir: string): string {
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-wrong" } }));
  const preload = join(dir, "fetch-echo.mjs");
  writeFileSync(preload, [
    "globalThis.fetch = async (_input, init) => {",
    "  const raw = init && typeof init.body === \"string\" ? init.body : \"{}\";",
    "  const parsed = JSON.parse(raw);",
    "  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];",
    "  let text = \"\";",
    "  for (let index = messages.length - 1; index >= 0; index -= 1) {",
    "    const message = messages[index];",
    "    if (!message || message.role !== \"user\") continue;",
    "    if (typeof message.content === \"string\") { text = message.content; break; }",
    "    if (Array.isArray(message.content)) {",
    "      text = message.content.map((part) => part && typeof part.text === \"string\" ? part.text : \"\").join(\"\");",
    "      break;",
    "    }",
    "  }",
    "  const reply = `echo:${text}`;",
    "  const sse = [",
    "    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: \"stop\" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,",
    "    \"\",",
    "    \"data: [DONE]\",",
    "    \"\",",
    "  ].join(\"\\n\");",
    "  return new Response(sse, { status: 200, headers: { \"content-type\": \"text/event-stream\" } });",
    "};",
  ].join("\n"));
  return preload;
}
