import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxArgv } from "../src/sandbox/backend.ts";
import { bubblewrapArgv } from "../src/sandbox/bubblewrap.ts";
import { buildPolicy } from "../src/sandbox/policy.ts";
import { seatbeltArgv } from "../src/sandbox/seatbelt.ts";
import { createCodingTools } from "../src/tools.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-sandbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n");
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("workspace file and shell tools succeed inside the seatbelt", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const [read, write, edit, bash] = createCodingTools(root);
  assert.ok(read && write && edit && bash);
  const wrote = await write.execute({ path: "note.txt", content: "one" }, { signal: signal() });
  assert.equal(wrote.isError, undefined);
  const edited = await edit.execute({ path: "note.txt", old: "one", replacement: "two" }, { signal: signal() });
  assert.equal(edited.isError, undefined);
  const seen = await read.execute({ path: "note.txt" }, { signal: signal() });
  assert.equal(textOf(seen), "two");
  const echoed = await bash.execute({ command: "echo hi" }, { signal: signal() });
  assert.equal(echoed.isError, false);
  assert.match(textOf(echoed), /hi/);
});

test("bash cannot read outside the workspace or open a local socket", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const tools = createCodingTools(root);
  const bash = tools[3];
  assert.ok(bash);
  const outside = join(tmpdir(), `amz-secret-${Date.now()}`);
  writeFileSync(outside, "TOP-SECRET-TOKEN");
  t.after(() => rmSync(outside, { force: true }));
  const listed = await bash.execute({ command: `cat ${JSON.stringify(outside)}` }, { signal: signal() });
  assert.equal(listed.isError, true);
  assert.equal(textOf(listed).includes("TOP-SECRET-TOKEN"), false);
  const network = await bash.execute({
    command: `${JSON.stringify(process.execPath)} -e "const s=require('net').connect(9,'127.0.0.1'); s.on('error',e=>{console.log(e.code); process.exit(0)}); s.on('connect',()=>{console.log('OPEN'); process.exit(0)}); setTimeout(()=>{console.log('TIMEOUT'); process.exit(0)},1500)"`,
  }, { signal: signal() });
  assert.match(textOf(network), /EPERM/);
  assert.equal(textOf(network).includes("OPEN"), false);
});

test("a workspace symlink cannot reveal or modify an outside file", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const [read, write, , bash] = createCodingTools(root);
  assert.ok(read && write && bash);
  const outside = join(tmpdir(), `amz-link-${Date.now()}`);
  writeFileSync(outside, "LINK-SECRET");
  t.after(() => rmSync(outside, { force: true }));
  symlinkSync(outside, join(root, "leak"));
  const seen = await read.execute({ path: "leak" }, { signal: signal() });
  assert.equal(seen.isError, true);
  assert.equal(textOf(seen).includes("LINK-SECRET"), false);
  const written = await write.execute({ path: "leak", content: "pwned" }, { signal: signal() });
  assert.equal(written.isError, true);
  assert.equal(readFileSync(outside, "utf8"), "LINK-SECRET");
  const cat = await bash.execute({ command: "cat leak" }, { signal: signal() });
  assert.equal(cat.isError, true);
  assert.equal(textOf(cat).includes("LINK-SECRET"), false);
});

test("bash does not inherit credentials and cannot read the runtime directory", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const bash = createCodingTools(root)[3];
  assert.ok(bash);
  const previous = process.env.AMAZME_CREDENTIALS;
  process.env.AMAZME_CREDENTIALS = "super-secret-key";
  t.after(() => {
    if (previous === undefined) delete process.env.AMAZME_CREDENTIALS;
    else process.env.AMAZME_CREDENTIALS = previous;
  });
  writeFileSync(join(root, ".amazme", "runtime", "workspace.jsonl"), "SECRET-JSONL");
  const result = await bash.execute({
    command: `${JSON.stringify(process.execPath)} -e "console.log('CRED='+(process.env.AMAZME_CREDENTIALS??'')); console.log('HOME='+(process.env.HOME??''))"`,
  }, { signal: signal() });
  const text = textOf(result);
  assert.equal(text.includes("super-secret-key"), false);
  assert.match(text, /HOME=.*\/\.amazme\/tmp/);
  const runtime = await bash.execute({ command: "cat .amazme/runtime/workspace.jsonl" }, { signal: signal() });
  assert.equal(runtime.isError, true);
  assert.equal(textOf(runtime).includes("SECRET-JSONL"), false);
});

test("abort kills a command that ignores SIGTERM", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const bash = createCodingTools(root)[3];
  assert.ok(bash);
  const running = new AbortController();
  const pending = bash.execute({
    command: "echo $$ > child.pid; trap '' TERM; sleep 30",
  }, { signal: running.signal });
  const pidFile = join(root, "child.pid");
  await until(() => {
    try {
      return Number(readFileSync(pidFile, "utf8")) > 0;
    } catch {
      return false;
    }
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  running.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("a missing seatbelt runner is unavailable", () => {
  assert.throws(() => seatbeltArgv("(version 1)\n(deny default)", ["/bin/bash", "-c", "true"], "/no/such/sandbox-exec"), /SANDBOX_UNAVAILABLE/);
});

test("bubblewrap is selected only on linux and a missing runner does not spawn", (t) => {
  const policy = buildPolicy(directory(t));
  const selected = sandboxArgv(policy, ["/bin/bash", "-c", "true"]);
  assert.equal(selected[0], "/usr/bin/sandbox-exec");
  let looked = 0;
  assert.throws(() => bubblewrapArgv(policy, ["/bin/bash", "-c", "true"], {
    platform: "darwin",
    stat() {
      looked += 1;
      return { isFile: () => true };
    },
  }), /SANDBOX_UNAVAILABLE: bubblewrap requires linux/);
  assert.equal(looked, 0);
  assert.throws(() => bubblewrapArgv(policy, ["/bin/bash", "-c", "true"], {
    platform: "linux",
    runner: "/no/such/bwrap",
    stat() {
      throw new Error("ENOENT");
    },
  }), /SANDBOX_UNAVAILABLE: \/no\/such\/bwrap is required/);
  assert.throws(() => sandboxArgv(policy, ["/bin/bash", "-c", "true"], "win32"), /SANDBOX_UNAVAILABLE: no sandbox backend for win32/);
  const argv = bubblewrapArgv(policy, ["/bin/bash", "-c", "true"], {
    platform: "linux",
    runner: "/usr/bin/bwrap",
    stat: () => ({ isFile: () => true }),
  });
  assert.equal(argv[0], "/usr/bin/bwrap");
  assert.equal(argv.includes("--unshare-net"), true);
  assert.equal(argv.includes("--tmpfs"), true);
  assert.equal(argv.includes(join(policy.canonical, ".amazme")), true);
  assert.equal(argv.includes(policy.scratch), true);
  assert.equal(argv.at(-3), "/bin/bash");
});
