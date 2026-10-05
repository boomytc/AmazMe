import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";
import { jobsFile, openJobRegistry, processStartTicks, type JobRecord } from "../src/jobs.ts";
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
  };
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
  assert.match(textOf(result), /^jobId j1$/);
  const running = readJobs(root)[0];
  assert.equal(running?.status, "running");
  assert.equal(typeof running?.pid, "number");
  assert.ok(running?.pid);
  assert.equal(alive(running.pid), true);
  assert.ok(running.summary.length > 0 && running.summary.length <= 80);
  await until(() => {
    const tail = jobs.output("j1");
    return tail !== null && tail.includes("hello-job");
  }, "job_output did not show the tail");
  const tail = await output.execute({ jobId: "j1" }, { signal });
  assert.equal(tail.isError, false);
  assert.match(textOf(tail), /j1 running/);
  assert.match(textOf(tail), /hello-job/);
  const missing = await output.execute({ jobId: "j9" }, { signal });
  assert.equal(missing.isError, true);
  const stopped = await kill.execute({ jobId: "j1" }, { signal });
  assert.equal(stopped.isError, false);
  assert.match(textOf(stopped), /killed j1/);
  await until(() => !alive(running.pid as number), "job_kill left the process running");
  assert.equal(readJobs(root)[0]?.status, "killed");
  const again = await kill.execute({ jobId: "j1" }, { signal });
  assert.match(textOf(again), /j1 killed/);
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
  assert.match(textOf(result), /jobId j1/);
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
  assert.match(JSON.stringify(snap), /jobId j1/);
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
