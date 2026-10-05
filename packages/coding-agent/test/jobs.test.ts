import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";
import { JobRegistry, jobsFile, openJobRegistry, processStartTicks, type JobRecord } from "../src/jobs.ts";
import { createCodingTools } from "../src/tools.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-jobs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(ready: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 8_000) throw new Error(label);
    await delay(20);
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text ?? "" : "";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `R` or `S` means the command is still executing. `Z` is a zombie the parent has not reaped. */
function runningState(pid: number): boolean {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")");
    const state = text.slice(end + 2).split(" ")[0];
    return state === "R" || state === "S" || state === "D";
  } catch {
    return false;
  }
}

function readJobs(cwd: string): Array<{ id: string; status: string; pid: number | null; summary: string }> {
  const parsed: unknown = JSON.parse(readFileSync(jobsFile(cwd), "utf8"));
  if (!parsed || typeof parsed !== "object" || !("jobs" in parsed) || !Array.isArray(parsed.jobs)) {
    throw new Error("bad jobs file");
  }
  return parsed.jobs.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || !("status" in item)) throw new Error("bad job");
    const id = item.id;
    const status = item.status;
    const pid = "pid" in item ? item.pid : null;
    const summary = "summary" in item && typeof item.summary === "string" ? item.summary : "";
    if (typeof id !== "string" || typeof status !== "string") throw new Error("bad job");
    if (!(pid === null || typeof pid === "number")) throw new Error("bad pid");
    return { id, status, pid, summary };
  });
}

function writeRunning(cwd: string, job: JobRecord): void {
  mkdirSync(join(cwd, ".amazme", "runtime"), { recursive: true });
  writeFileSync(jobsFile(cwd), JSON.stringify({ next: 2, jobs: [job] }));
}

function blankJob(command: string, pid: number, startTicks: string): JobRecord {
  return {
    id: "j1",
    status: "running",
    summary: command,
    command,
    pid,
    startTicks,
    code: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    owner: null,
  };
}

function jobIdFrom(text: string): string {
  const match = /^jobId (j\d+-\d+)$/.exec(text.trim());
  assert.ok(match, text);
  return match[1] ?? "";
}

test("opening a registry marks a running job lost without rerunning it or killing a different pid", (t) => {
  const root = directory(t);
  const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  assert.equal(typeof pid, "number");
  assert.ok(pid);
  child.unref();
  t.after(() => {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  });
  const ticks = processStartTicks(pid);
  if (ticks === null) return;
  writeRunning(root, blankJob("echo rerun >> marker", pid, "not-this-process"));
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  assert.equal(existsSync(join(root, "marker")), false);
  assert.equal(readJobs(root)[0]?.status, "lost");
  assert.equal(runningState(pid), true);
});

test("opening a registry kills a still-running recorded pid and does not rerun its command", async (t) => {
  const root = directory(t);
  const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.unref();
  t.after(() => {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  });
  const ticks = processStartTicks(pid);
  if (ticks === null) return;
  writeRunning(root, blankJob("echo rerun >> marker", pid, ticks));
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  assert.equal(existsSync(join(root, "marker")), false);
  assert.equal(readJobs(root)[0]?.status, "lost");
  await until(() => !runningState(pid), "recorded pid was not killed");
  await Promise.race([
    exited,
    delay(2_000).then(() => { throw new Error("recorded pid was not killed"); }),
  ]);
  assert.equal(alive(pid), false);
});

test("background bash returns a jobId without waiting, job_output tails, and job_kill stops it", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  const tools = createCodingTools(root, jobs);
  const bash = tools.find((tool) => tool.name === "bash");
  const output = tools.find((tool) => tool.name === "job_output");
  const kill = tools.find((tool) => tool.name === "job_kill");
  assert.ok(bash && output && kill);
  const signal = new AbortController().signal;
  const foreground = await bash.execute({ command: "echo hi", background: false }, { signal });
  assert.equal(foreground.isError, false);
  assert.match(textOf(foreground), /hi/);
  assert.equal(existsSync(jobsFile(root)), false);

  const script = "process.stdout.write('hello-job\\n')";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}; sleep 30`;
  const started = Date.now();
  const result = await bash.execute({ command, background: true }, { signal });
  assert.ok(Date.now() - started < 5_000, "background bash waited for the command to exit");
  assert.equal(result.isError, false);
  const id = jobIdFrom(textOf(result));
  const running = readJobs(root)[0];
  assert.equal(running?.id, id);
  assert.equal(running?.status, "running");
  assert.equal(typeof running?.pid, "number");
  assert.ok(running?.pid);
  assert.equal(alive(running.pid), true);
  assert.ok(running.summary.length > 0 && running.summary.length <= 80);
  await until(() => {
    const tail = jobs.output(id);
    return tail !== null && tail.includes("hello-job");
  }, "job_output did not show the tail");
  const tail = await output.execute({ jobId: id }, { signal });
  assert.equal(tail.isError, false);
  assert.match(textOf(tail), new RegExp(`${id} running`));
  assert.match(textOf(tail), /hello-job/);
  const missing = await output.execute({ jobId: "j9" }, { signal });
  assert.equal(missing.isError, true);
  const stopped = await kill.execute({ jobId: id }, { signal });
  assert.equal(stopped.isError, false);
  assert.match(textOf(stopped), new RegExp(`killed ${id}`));
  await until(() => !alive(running.pid as number), "job_kill left the process running");
  assert.equal(readJobs(root)[0]?.status, "killed");
  const again = await kill.execute({ jobId: id }, { signal });
  assert.match(textOf(again), new RegExp(`${id} killed`));
  const unknown = await kill.execute({ jobId: "missing" }, { signal });
  assert.equal(unknown.isError, true);
});

test("registry close marks a background job lost and reopening it does not rerun the command", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const marker = join(root, "marker");
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  const bash = createCodingTools(root, jobs).find((tool) => tool.name === "bash");
  assert.ok(bash);
  const command = `echo once >> ${JSON.stringify(marker)}; sleep 60`;
  const result = await bash.execute({ command, background: true }, { signal: new AbortController().signal });
  assert.match(textOf(result), /^jobId j\d+-\d+$/);
  await until(() => existsSync(marker), "background command did not write the marker");
  const pid = readJobs(root)[0]?.pid;
  assert.equal(typeof pid, "number");
  assert.ok(pid);
  assert.equal(alive(pid), true);
  await jobs.close();
  assert.equal(alive(pid), false);
  assert.equal(readJobs(root)[0]?.status, "lost");
  const again = openJobRegistry(root);
  t.after(() => again.close());
  const start = Date.now();
  while (Date.now() - start < 600) {
    assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
    await delay(50);
  }
  assert.equal(readJobs(root)[0]?.status, "lost");
  assert.equal(alive(pid), false);
});

async function settle(lane: { drive(operationId: string, options?: { waitForRetry?: boolean }): Promise<{ kind: string; operationId: string }> }, operationId: string): Promise<void> {
  const outcome = await lane.drive(operationId, { waitForRetry: true });
  if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
}

test("host close kills a background job and a reopened host leaves it lost", { timeout: 30_000 }, async (t) => {
  const cwd = directory(t);
  const marker = join(cwd, "marker");
  const command = `echo once >> ${JSON.stringify(marker)}; sleep 60`;
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("bash", { command, background: true })])
      : fauxAssistant("done"),
  }));
  let host = await startCodingHost({
    cwd,
    socket: join(cwd, "first.sock"),
    provider: "faux",
    model: "faux-1",
    models,
  });
  t.after(() => host.close());
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: host.socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const lane = remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "background" });
  const started = Date.now();
  await settle(lane, admitted.operationId);
  assert.ok(Date.now() - started < 12_000, "hosted background bash waited for exit");
  await until(() => existsSync(marker), "hosted background command did not write the marker");
  const running = readJobs(cwd)[0];
  assert.equal(running?.status, "running");
  assert.equal(typeof running?.pid, "number");
  assert.ok(running?.pid);
  assert.equal(alive(running.pid), true);
  const snap = await lane.snapshot();
  assert.match(JSON.stringify(snap), /jobId j\d+-\d+/);
  await host.close();
  assert.equal(alive(running.pid), false);
  assert.equal(readJobs(cwd)[0]?.status, "lost");
  host = await startCodingHost({
    cwd,
    socket: join(cwd, "second.sock"),
    provider: "faux",
    model: "faux-1",
    models,
  });
  const reopened = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: host.socket }) });
  await reopened.connect();
  t.after(() => reopened.dispose());
  await new RuntimeClient(reopened).attach(HOST_RUNTIME_ID);
  const start = Date.now();
  while (Date.now() - start < 600) {
    assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
    await delay(50);
  }
  assert.equal(readJobs(cwd)[0]?.status, "lost");
  assert.equal(alive(running.pid), false);
});

test("a second host in the same cwd does not kill the first host's jobs", { timeout: 40_000 }, async (t) => {
  const root = directory(t);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const jobsHref = new URL("../src/jobs.ts", import.meta.url).href;
  const toolsHref = new URL("../src/tools.ts", import.meta.url).href;
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { openJobRegistry } from ${JSON.stringify(jobsHref)};
    import { createCodingTools } from ${JSON.stringify(toolsHref)};
    const cwd = process.env.JOBS_CWD;
    if (!cwd) throw new Error("missing cwd");
    const jobs = openJobRegistry(cwd);
    const bash = createCodingTools(cwd, jobs).find((tool) => tool.name === "bash");
    if (!bash) throw new Error("missing bash");
    const result = await bash.execute({ command: "sleep 60", background: true }, { signal: new AbortController().signal });
    const block = result.content[0];
    const text = block && block.type === "text" ? block.text ?? "" : "";
    process.stdout.write(JSON.stringify({ text, pid: process.pid }) + "\\n");
    setInterval(() => undefined, 1_000);
  `], {
    cwd: repo,
    env: { ...process.env, JOBS_CWD: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`first host did not report a job\n${stderr}`)), 20_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`first host exited ${code}\n${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(buf.slice(0, nl));
    });
  });
  t.after(() => child.kill("SIGKILL"));
  const reported: unknown = JSON.parse(line);
  assert.ok(reported && typeof reported === "object" && "text" in reported && "pid" in reported);
  const text = reported.text;
  const ownerPid = reported.pid;
  if (typeof text !== "string" || typeof ownerPid !== "number") throw new Error("bad report");
  const firstId = jobIdFrom(text);
  const firstPid = readJobs(root).find((job) => job.id === firstId)?.pid;
  assert.equal(typeof firstPid, "number");
  if (typeof firstPid !== "number") throw new Error("missing pid");
  t.after(() => {
    try { process.kill(-firstPid, "SIGKILL"); } catch { /* already gone */ }
  });
  assert.equal(readJobs(root).find((job) => job.id === firstId)?.status, "running");
  assert.equal(runningState(firstPid), true);

  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  assert.equal(readJobs(root).find((job) => job.id === firstId)?.status, "running");
  assert.equal(runningState(firstPid), true);

  const bash = createCodingTools(root, jobs).find((tool) => tool.name === "bash");
  assert.ok(bash);
  const started = await bash.execute({ command: "sleep 60", background: true }, { signal: new AbortController().signal });
  const secondId = jobIdFrom(textOf(started));
  assert.notEqual(secondId, firstId);
  const rows = readJobs(root);
  assert.deepEqual(rows.map((job) => job.id).sort(), [firstId, secondId].sort());
  assert.equal(rows.find((job) => job.id === firstId)?.status, "running");
  assert.equal(rows.find((job) => job.id === secondId)?.status, "running");
  const secondPid = rows.find((job) => job.id === secondId)?.pid;
  assert.equal(typeof secondPid, "number");
  if (typeof secondPid !== "number") throw new Error("missing pid");
  t.after(() => {
    try { process.kill(-secondPid, "SIGKILL"); } catch { /* already gone */ }
  });
  assert.equal(runningState(firstPid), true);
  assert.equal(runningState(secondPid), true);

  const raw: unknown = JSON.parse(readFileSync(jobsFile(root), "utf8"));
  assert.ok(raw && typeof raw === "object" && "jobs" in raw && Array.isArray(raw.jobs));
  const owners = new Map<string, number>();
  for (const item of raw.jobs) {
    if (!item || typeof item !== "object" || !("id" in item) || !("owner" in item)) continue;
    const id = item.id;
    const owner = item.owner;
    if (typeof id !== "string" || !owner || typeof owner !== "object" || !("pid" in owner)) continue;
    const pid = owner.pid;
    if (typeof pid === "number") owners.set(id, pid);
  }
  assert.equal(owners.get(firstId), ownerPid);
  assert.equal(owners.get(secondId), process.pid);
  assert.notEqual(ownerPid, process.pid);

  await jobs.close();
  assert.equal(readJobs(root).find((job) => job.id === firstId)?.status, "running");
  assert.equal(readJobs(root).find((job) => job.id === secondId)?.status, "lost");
  assert.equal(runningState(firstPid), true);
  assert.equal(runningState(secondPid), false);
});

test("corrupt jobs.json is renamed and does not block host startup", async (t) => {
  const cwd = directory(t);
  const file = jobsFile(cwd);
  const runtime = join(cwd, ".amazme", "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(file, "{");
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: () => fauxAssistant("ok"),
  }));
  const host = await startCodingHost({
    cwd,
    socket: join(cwd, "host.sock"),
    provider: "faux",
    model: "faux-1",
    models,
  });
  t.after(() => host.close());
  assert.equal(existsSync(file), false);
  const quarantined = readdirSync(runtime).filter((name) => name.startsWith("jobs.json.corrupt-"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0] ?? "", /^jobs\.json\.corrupt-\d+$/);
  assert.equal(readFileSync(join(runtime, quarantined[0] ?? ""), "utf8"), "{");

  await host.close();
  writeFileSync(file, JSON.stringify({ jobs: 1 }));
  const jobs = openJobRegistry(cwd);
  t.after(() => jobs.close());
  assert.equal(existsSync(file), false);
  const again = readdirSync(runtime).filter((name) => name.startsWith("jobs.json.corrupt-"));
  assert.equal(again.length, 2);
  const shape = again.find((name) => name !== quarantined[0]);
  assert.ok(shape);
  assert.match(shape, /^jobs\.json\.corrupt-\d+(?:-\d+)?$/);
  assert.equal(readFileSync(join(runtime, shape), "utf8"), JSON.stringify({ jobs: 1 }));
});

test("two processes creating jobs do not drop each other's entries", { timeout: 60_000 }, async (t) => {
  const root = directory(t);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const jobsHref = new URL("../src/jobs.ts", import.meta.url).href;
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { openJobRegistry } from ${JSON.stringify(jobsHref)};
    const cwd = process.env.JOBS_CWD;
    if (!cwd) throw new Error("missing cwd");
    const jobs = openJobRegistry(cwd);
    const ids = [];
    for (let i = 0; i < 20; i += 1) ids.push(jobs.start("true"));
    process.stdout.write(JSON.stringify({ ids }) + "\\n");
    setInterval(() => undefined, 1_000);
  `], {
    cwd: repo,
    env: { ...process.env, JOBS_CWD: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const reported = new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`peer did not finish\n${stderr}`)), 40_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`peer exited ${code}\n${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(buf.slice(0, nl));
    });
  });
  t.after(() => child.kill("SIGKILL"));
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  const mine: string[] = [];
  for (let i = 0; i < 20; i += 1) mine.push(jobs.start("true"));
  const line = await reported;
  const parsed: unknown = JSON.parse(line);
  assert.ok(parsed && typeof parsed === "object" && "ids" in parsed && Array.isArray(parsed.ids));
  const theirs = parsed.ids.filter((id: unknown): id is string => typeof id === "string");
  assert.equal(theirs.length, 20);
  const expected = new Set([...mine, ...theirs]);
  assert.equal(expected.size, 40);
  await until(() => {
    try {
      const ids = new Set(readJobs(root).map((job) => job.id));
      for (const id of expected) if (!ids.has(id)) return false;
      return ids.size === 40;
    } catch {
      return false;
    }
  }, "jobs.json did not keep all 40 entries");
  assert.equal(readJobs(root).length, 40);
  await until(() => !existsSync(`${jobsFile(root)}.lock`), "jobs.json.lock was not released");
});

test("persist keeps every running job and only the newest 50 finished jobs", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const owner = { pid: process.pid, startTicks: processStartTicks(process.pid) };
  const jobs: JobRecord[] = [];
  for (let i = 0; i < 2; i += 1) {
    jobs.push({
      id: `keep-${i}`,
      status: "running",
      summary: `keep-${i}`,
      command: "sleep 30",
      pid: null,
      startTicks: null,
      code: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      owner,
    });
  }
  const finishedStatus = ["exited", "killed", "lost"] as const;
  for (let i = 0; i < 60; i += 1) {
    const status = finishedStatus[i % 3] ?? "exited";
    jobs.push({
      id: `old-${i}`,
      status,
      summary: `old-${i}`,
      command: "true",
      pid: null,
      startTicks: null,
      code: status === "exited" ? 0 : null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      owner: null,
    });
  }
  mkdirSync(join(root, ".amazme", "runtime"), { recursive: true });
  writeFileSync(jobsFile(root), JSON.stringify({ next: 1, jobs }));
  const registry = openJobRegistry(root);
  t.after(() => registry.close());
  const id = registry.start("sleep 30");
  const rows = readJobs(root);
  const ids = rows.map((job) => job.id);
  assert.equal(rows.filter((job) => job.status === "running").length, 3);
  assert.ok(ids.includes("keep-0") && ids.includes("keep-1") && ids.includes(id));
  for (let i = 0; i < 10; i += 1) assert.equal(ids.includes(`old-${i}`), false);
  for (let i = 10; i < 60; i += 1) assert.equal(ids.includes(`old-${i}`), true);
  assert.equal(rows.length, 53);
});

test("an idle output tick does not rewrite jobs.json when the tail is unchanged", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  const marker = join(root, "marker");
  const script = `const fs=require("fs");process.stdout.write("a".repeat(40000));fs.writeFileSync(${JSON.stringify(marker)},"1");setTimeout(()=>{process.stdout.write("a".repeat(2000));fs.writeFileSync(${JSON.stringify(marker)},"2");},1200);setInterval(()=>{},1000);`;
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  const id = jobs.start(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
  const file = jobsFile(root);
  await until(() => {
    if (!existsSync(marker) || readFileSync(marker, "utf8") !== "1") return false;
    try {
      const raw = readFileSync(file, "utf8");
      return raw.includes(id) && raw.includes("a".repeat(64)) && raw.includes('"stdoutTruncated":true');
    } catch {
      return false;
    }
  }, "first output was not stored");
  assert.equal(readFileSync(marker, "utf8"), "1");
  const written = statSync(file).mtimeMs;
  await until(() => existsSync(marker) && readFileSync(marker, "utf8") === "2", "second output did not run");
  await delay(500);
  assert.equal(statSync(file).mtimeMs, written);
  assert.equal(readJobs(root).find((job) => job.id === id)?.status, "running");
});

test("a live lock holder does not crash the host or leave an orphan job", { timeout: 40_000 }, async (t) => {
  const root = directory(t);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const jobsHref = new URL("../src/jobs.ts", import.meta.url).href;
  const phase = join(root, "phase");
  const go = join(root, "go");
  const orphan = join(root, "orphan");
  const script = `const fs=require("fs");process.stdout.write("hello-first\\n");fs.writeFileSync(${JSON.stringify(phase)},"1");const end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(go)})&&Date.now()<end){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40);}process.stdout.write("hello-second\\n");setInterval(()=>{},1000);`;
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  const id = jobs.start(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
  const file = jobsFile(root);
  await until(() => {
    if (!existsSync(phase) || readFileSync(phase, "utf8") !== "1") return false;
    try { return readFileSync(file, "utf8").includes("hello-first"); } catch { return false; }
  }, "first output was not stored");

  let stderr = "";
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
    import { processStartTicks } from ${JSON.stringify(jobsHref)};
    const lock = process.env.LOCK_PATH;
    if (!lock) throw new Error("missing lock");
    const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, startTicks: processStartTicks(process.pid) }));
    closeSync(fd);
    process.stdout.write("held\\n");
    const release = () => {
      try { unlinkSync(lock); } catch { /* already gone */ }
      process.exit(0);
    };
    process.on("SIGTERM", release);
    setTimeout(release, 12_000);
  `], {
    cwd: repo,
    env: { ...process.env, LOCK_PATH: `${file}.lock` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  holder.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  t.after(() => holder.kill("SIGTERM"));
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`lock holder did not start\n${stderr}`)), 10_000);
    holder.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (!buf.includes("held\n")) return;
      clearTimeout(timer);
      resolve();
    });
    holder.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited ${code}\n${stderr}`));
    });
  });

  writeFileSync(go, "1");
  await until(() => jobs.output(id)?.includes("hello-second") ?? false, "second output did not reach memory");
  assert.throws(
    () => jobs.start(`echo orphan >> ${JSON.stringify(orphan)}; sleep 30`),
    /jobs\.json\.lock busy/,
  );
  assert.equal(existsSync(orphan), false);
  assert.equal(readJobs(root).some((job) => job.summary.includes("orphan")), false);
  const skipped = JobRegistry.open(root);
  t.after(() => skipped.close());
  const deadline = Date.now() + 15_000;
  while (!readFileSync(file, "utf8").includes("hello-second")) {
    if (Date.now() > deadline) throw new Error("later persist did not store the output");
    await delay(50);
  }
  assert.equal(readJobs(root).find((job) => job.id === id)?.status, "running");
  assert.equal(existsSync(orphan), false);
});

test("callback persist retries do not block the event loop while a live process holds the lock", { timeout: 30_000 }, async (t) => {
  const root = directory(t);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const jobsHref = new URL("../src/jobs.ts", import.meta.url).href;
  const phase = join(root, "phase");
  const go = join(root, "go");
  const markerFile = join(root, "marker-text");
  const marker = `mark-${process.pid}-${Date.now()}`;
  const script = `const fs=require("fs");process.stdout.write("hello-first\\n");fs.writeFileSync(${JSON.stringify(phase)},"1");const end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(go)})&&Date.now()<end){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40);}process.stdout.write(fs.readFileSync(${JSON.stringify(markerFile)},"utf8"));setInterval(()=>{},1000);`;
  const jobs = openJobRegistry(root);
  t.after(() => jobs.close());
  const id = jobs.start(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
  const file = jobsFile(root);
  await until(() => {
    if (!existsSync(phase) || readFileSync(phase, "utf8") !== "1") return false;
    try { return readFileSync(file, "utf8").includes("hello-first"); } catch { return false; }
  }, "first output was not stored");

  let stderr = "";
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
    import { processStartTicks } from ${JSON.stringify(jobsHref)};
    const lock = process.env.LOCK_PATH;
    if (!lock) throw new Error("missing lock");
    const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, startTicks: processStartTicks(process.pid) }));
    closeSync(fd);
    process.stdout.write("held\\n");
    const release = () => {
      try { unlinkSync(lock); } catch { /* already gone */ }
      process.exit(0);
    };
    process.on("SIGTERM", release);
    setTimeout(release, 20_000);
  `], {
    cwd: repo,
    env: { ...process.env, LOCK_PATH: `${file}.lock` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  holder.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  t.after(() => holder.kill("SIGTERM"));
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`lock holder did not start\n${stderr}`)), 10_000);
    holder.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (!buf.includes("held\n")) return;
      clearTimeout(timer);
      resolve();
    });
    holder.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited ${code}\n${stderr}`));
    });
  });

  const stamps: number[] = [];
  const tick = setInterval(() => { stamps.push(Date.now()); }, 10);
  t.after(() => clearInterval(tick));
  writeFileSync(markerFile, marker);
  writeFileSync(go, "1");
  await until(() => jobs.output(id)?.includes(marker) ?? false, "second output did not reach memory");
  const killed = jobs.kill(id);
  assert.match(killed.text, new RegExp(`killed ${id}`));
  await delay(600);
  clearInterval(tick);
  assert.equal(holder.exitCode, null);
  let longest = 0;
  for (let i = 1; i < stamps.length; i += 1) {
    const gap = (stamps[i] ?? 0) - (stamps[i - 1] ?? 0);
    if (gap > longest) longest = gap;
  }
  assert.ok(stamps.length > 20, "interval did not sample the event loop");
  assert.ok(longest <= 100, `event loop stalled for ${longest}ms`);
  const during = readFileSync(file, "utf8");
  assert.equal(during.includes(marker), false);
  assert.equal(readJobs(root).find((job) => job.id === id)?.status, "running");

  const releasedAt = Date.now();
  holder.kill("SIGTERM");
  const deadline = releasedAt + 5_000;
  let stored = false;
  while (Date.now() <= deadline) {
    try {
      const raw = readFileSync(file, "utf8");
      if (raw.includes(marker) && readJobs(root).find((job) => job.id === id)?.status === "killed") {
        stored = true;
        break;
      }
    } catch { /* writer may be replacing the file */ }
    await delay(20);
  }
  assert.equal(stored, true, "persist did not finish within 5s of lock release");
  assert.ok(Date.now() - releasedAt <= 5_000);
});

test("a pending jobs.json.lock retry does not keep the process alive", { timeout: 10_000 }, async (t) => {
  const root = directory(t);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const jobsHref = new URL("../src/jobs.ts", import.meta.url).href;
  const file = jobsFile(root);
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { closeSync, constants, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
    import { dirname } from "node:path";
    import { jobsFile, openJobRegistry, processStartTicks } from ${JSON.stringify(jobsHref)};
    const cwd = process.env.JOBS_CWD;
    if (!cwd) throw new Error("missing cwd");
    const owner = { pid: process.pid, startTicks: processStartTicks(process.pid) };
    const file = jobsFile(cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ next: 2, jobs: [{
      id: "j1",
      status: "running",
      summary: "sleep 60",
      command: "sleep 60",
      pid: null,
      startTicks: null,
      code: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      owner,
    }] }));
    const jobs = openJobRegistry(cwd);
    const fd = openSync(file + ".lock", constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(fd, JSON.stringify(owner));
    closeSync(fd);
    const killed = jobs.kill("j1");
    if (killed.isError || killed.text !== "killed j1") throw new Error(killed.text);
    process.stdout.write("scheduled\\n");
  `], {
    cwd: repo,
    env: { ...process.env, JOBS_CWD: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  t.after(() => child.kill("SIGKILL"));
  const outcome = await new Promise<{ line: string; code: number | null }>((resolve, reject) => {
    let buf = "";
    let line: string | undefined;
    let code: number | null | undefined;
    let settled = false;
    let alive: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      if (alive !== undefined) clearTimeout(alive);
      reject(error);
    };
    const startup = setTimeout(() => {
      fail(new Error(`child did not schedule a retry\n${stderr}\n${buf}`));
    }, 8_000);
    const finish = () => {
      if (settled || line === undefined || code === undefined) return;
      settled = true;
      clearTimeout(startup);
      if (alive !== undefined) clearTimeout(alive);
      resolve({ line, code });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (line !== undefined) return;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      line = buf.slice(0, nl);
      alive = setTimeout(() => {
        fail(new Error(`pending lock retry kept the process alive\n${stderr}`));
      }, 2_000);
      finish();
    });
    child.once("close", (exitCode) => {
      code = exitCode;
      if (line === undefined) {
        fail(new Error(`child exited ${exitCode} before scheduling\n${stderr}\n${buf}`));
        return;
      }
      finish();
    });
  });
  assert.equal(outcome.line, "scheduled");
  assert.equal(outcome.code, 0);
  assert.equal(readJobs(root).find((job) => job.id === "j1")?.status, "running");
  assert.equal(existsSync(`${file}.lock`), true);
});
