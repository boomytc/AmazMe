import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const PTY_HELPER = `
import fcntl
import os
import select
import signal
import struct
import sys
import termios

rows = int(os.environ.get("AMAZME_PTY_ROWS", "40"))
cols = int(os.environ.get("AMAZME_PTY_COLS", "200"))
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except OSError:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    if slave > 2:
        os.close(slave)
    os.execv(sys.argv[1], sys.argv[1:])
    os._exit(127)

os.close(slave)

def stop(_signum, _frame):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    sys.exit(1)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
flags = fcntl.fcntl(master, fcntl.F_GETFL)
fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
flags = fcntl.fcntl(0, fcntl.F_GETFL)
fcntl.fcntl(0, fcntl.F_SETFL, flags | os.O_NONBLOCK)
stdin_open = True
while True:
    watch = [master]
    if stdin_open:
        watch.append(0)
    readable, _, _ = select.select(watch, [], [], 0.2)
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            os.write(1, data)
    if stdin_open and 0 in readable:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b""
        if not data:
            stdin_open = False
        else:
            try:
                os.write(master, data)
            except OSError:
                pass
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
        sys.exit(code)
`;

function cliEnv(cwd: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  env.AMAZME_CREDENTIALS = join(cwd, "credentials.json");
  env.AMAZME_DEVICE_ID_FILE = join(cwd, "device-id");
  env.AMAZME_PTY_COLS = "200";
  env.AMAZME_PTY_ROWS = "40";
  return env;
}

function echoPreload(cwd: string): string {
  writeFileSync(join(cwd, "credentials.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-test" } }));
  const preload = join(cwd, "fetch-echo.mjs");
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

function runCli(args: string[], cwd: string, preload?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const nodeArgs = preload ? ["--import", preload, "--import", "tsx", cli, ...args] : ["--import", "tsx", cli, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: repo,
      env: cliEnv(cwd),
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

function openPty(args: string[], cwd: string, preload: string): {
  child: ChildProcess;
  output: () => string;
  write: (text: string) => void;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const helper = join(cwd, "pty-helper.py");
  writeFileSync(helper, PTY_HELPER);
  const child = spawn("python3", [helper, process.execPath, "--import", preload, "--import", "tsx", cli, ...args], {
    cwd: repo,
    env: cliEnv(cwd),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`fullscreen timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 25_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return {
    child,
    output: () => stdout,
    write(text: string) { child.stdin.write(text); },
    done,
  };
}

function until(ready: () => boolean, label: string, output: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`${label}\n${output()}`));
    }, 20_000);
    const poll = setInterval(() => {
      if (!ready()) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    }, 30);
  });
}

function laneRecord(name: string): string {
  return `"namespace":"pi.lane.state","key":"${name}"`;
}

test("fullscreen --resume reopens that lane's status and history", { timeout: 45_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-fs-"));
  const preload = echoPreload(cwd);
  let screen: ReturnType<typeof openPty> | undefined;
  t.after(() => { screen?.child.kill("SIGTERM"); });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const base = ["--cwd", cwd, "--provider", "deepseek", "--model", "deepseek-flash"];
  const mainLane = await runCli([...base, "--resume", "main", "main-only-marker"], cwd, preload);
  assert.equal(mainLane.code, 0, mainLane.stderr);
  assert.match(mainLane.stdout, /^echo:main-only-marker\n$/);
  const notes = await runCli([...base, "--resume", "laneNotes", "notes-only-marker"], cwd, preload);
  assert.equal(notes.code, 0, notes.stderr);
  assert.match(notes.stdout, /^echo:notes-only-marker\n$/);

  screen = openPty([...base, "--resume", "laneNotes"], cwd, preload);
  await until(
    () => screen!.output().includes("notes-only-marker") && screen!.output().includes("laneNotes  空闲"),
    "resumed lane did not paint",
    () => screen!.output(),
  );
  const painted = screen.output();
  assert.match(painted, /notes-only-marker/);
  assert.match(painted, /echo:notes-only-marker/);
  assert.match(painted, /laneNotes {2}空闲/);
  assert.equal(painted.includes("main-only-marker"), false);
  assert.equal(painted.includes("\x1b[?1049h"), true);
  screen.write("\u0004");
  const closed = await screen.done;
  assert.equal(closed.code, 0, closed.stderr);
  const raw = readFileSync(join(cwd, ".amazme", "runtime", "workspace.jsonl"), "utf8");
  assert.equal(raw.includes(laneRecord("laneNotes")), true);
  assert.equal(raw.includes(laneRecord("main")), true);
  assert.equal(raw.includes("notes-only-marker"), true);
  assert.equal(raw.includes("main-only-marker"), true);
});

test("fullscreen --resume of a missing lane exits nonzero and does not create it", { timeout: 40_000 }, async (t) => {
  const fresh = mkdtempSync(join(tmpdir(), "amz-fs-miss-"));
  echoPreload(fresh);
  let screen: ReturnType<typeof openPty> | undefined;
  t.after(() => { screen?.child.kill("SIGTERM"); });
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  screen = openPty(["--cwd", fresh, "--provider", "deepseek", "--model", "deepseek-flash", "--resume", "missingLane"], fresh, join(fresh, "fetch-echo.mjs"));
  const missing = await screen.done;
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /session missingLane does not exist/);
  assert.equal(missing.stdout.includes("\x1b[?1049h"), false);
  assert.equal(existsSync(join(fresh, ".amazme")), false);

  const cwd = mkdtempSync(join(tmpdir(), "amz-fs-other-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const preload = echoPreload(cwd);
  const created = await runCli(["--cwd", cwd, "--provider", "deepseek", "--model", "deepseek-flash", "--resume", "main", "main-only-marker"], cwd, preload);
  assert.equal(created.code, 0, created.stderr);
  const before = readFileSync(join(cwd, ".amazme", "runtime", "workspace.jsonl"), "utf8");
  assert.equal(before.includes(laneRecord("main")), true);
  const again = openPty(["--cwd", cwd, "--provider", "deepseek", "--model", "deepseek-flash", "--resume", "missingLane"], cwd, preload);
  t.after(() => { again.child.kill("SIGTERM"); });
  const refused = await again.done;
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /session missingLane does not exist/);
  assert.equal(refused.stdout.includes("\x1b[?1049h"), false);
  const after = readFileSync(join(cwd, ".amazme", "runtime", "workspace.jsonl"), "utf8");
  assert.equal(after.includes("missingLane"), false);
  assert.equal(after.includes(laneRecord("main")), true);
  assert.equal(after.includes("main-only-marker"), true);
});

test("a pipe with --resume and no prompt stays the missing-prompt exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-fs-pipe-"));
  try {
    const result = await runCli(["--cwd", cwd, "--resume", "laneNotes"], cwd);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing prompt/);
    assert.equal(result.stderr.includes("does not exist"), false);
    assert.equal(existsSync(join(cwd, ".amazme")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
