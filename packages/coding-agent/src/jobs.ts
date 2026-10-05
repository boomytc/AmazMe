import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareWorkspace, startBash, type StartedBash } from "./sandbox/run.ts";

/**
 * 后台任务记在工作区 `.amazme/runtime/jobs.json`。
 * 问题：宿主进程结束后，若把 status 仍是 running 的命令再拉起来，它会再执行一遍。
 * 例子：`echo once >> marker; sleep 60` 在关闭前只应写一行；重新打开宿主时不能变成两行。
 * 打开登记表时把 running 改成 lost，并只在 pid 的 starttime 对得上时结束残留进程，不 spawn。
 */
export type JobStatus = "running" | "exited" | "killed" | "lost";

export interface JobRecord {
  id: string;
  status: JobStatus;
  summary: string;
  command: string;
  pid: number | null;
  /** Linux `/proc/<pid>/stat` starttime. Identifies the process across pid reuse. */
  startTicks: string | null;
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface JobText {
  text: string;
  isError: boolean;
}

const STATUSES: readonly JobStatus[] = ["running", "exited", "killed", "lost"];
const OUTPUT_DELAY_MS = 200;
const KILL_WAIT_MS = 2_000;

const openByCwd = new Map<string, JobRegistry>();

export function jobsFile(cwd: string): string {
  return join(resolve(cwd), ".amazme", "runtime", "jobs.json");
}

/** Linux starttime, or null where `/proc` is unavailable or the pid is gone. */
export function processStartTicks(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")");
    if (end < 0) return null;
    return text.slice(end + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** One registry per workspace. A closed registry is not reused; the next open reloads the file. */
export function openJobRegistry(cwd: string): JobRegistry {
  const root = resolve(cwd);
  const existing = openByCwd.get(root);
  if (existing && !existing.closed) return existing;
  const created = JobRegistry.open(root);
  openByCwd.set(root, created);
  return created;
}

export class JobRegistry {
  readonly cwd: string;
  readonly file: string;
  closed = false;
  private next = 1;
  private jobs: JobRecord[] = [];
  private readonly handles = new Map<string, StartedBash>();
  private outputTimer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(cwd: string) {
    this.cwd = cwd;
    this.file = jobsFile(cwd);
  }

  static open(cwd: string): JobRegistry {
    const registry = new JobRegistry(resolve(cwd));
    registry.load();
    let changed = false;
    for (const job of registry.jobs) {
      if (job.status !== "running") continue;
      signalRecorded(job);
      job.status = "lost";
      changed = true;
    }
    if (changed) registry.persist();
    return registry;
  }

  start(command: string): string {
    if (this.closed) throw new Error("job registry is closed");
    let started: JobRecord | undefined;
    let running: StartedBash | undefined;
    const handle = startBash(prepareWorkspace(this.cwd), command, () => {
      if (!started || !running || started.status !== "running") return;
      this.capture(started, running);
      this.scheduleOutput();
    });
    running = handle;
    const id = `j${this.next}`;
    this.next += 1;
    const job: JobRecord = {
      id,
      status: "running",
      summary: summarize(command),
      command,
      pid: handle.pid,
      startTicks: processStartTicks(handle.pid),
      code: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    started = job;
    this.jobs.push(job);
    this.handles.set(id, handle);
    this.persist();
    void handle.done.then((result) => {
      this.capture(job, handle);
      if (job.status === "running") {
        job.status = "exited";
        job.code = result.code;
      }
      this.persist();
    });
    if (this.closed) void this.lose(job);
    return id;
  }

  output(id: string): string | null {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return null;
    const handle = this.handles.get(id);
    if (handle) this.capture(job, handle);
    return formatJob(job);
  }

  kill(id: string): JobText {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return { text: `unknown job ${id}`, isError: true };
    if (job.status !== "running") return { text: `${job.id} ${job.status}`, isError: false };
    const handle = this.handles.get(id);
    if (handle) this.capture(job, handle);
    job.status = "killed";
    if (handle) handle.kill();
    else signalRecorded(job);
    this.persist();
    if (handle) {
      void handle.done.then(() => {
        this.capture(job, handle);
        this.persist();
      });
    }
    return { text: `killed ${job.id}`, isError: false };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const pending = this.jobs.filter((job) => job.status === "running").map((job) => this.lose(job));
    this.closing = Promise.all(pending).then(() => undefined);
    return this.closing;
  }

  private lose(job: JobRecord): Promise<void> {
    const handle = this.handles.get(job.id);
    if (handle) this.capture(job, handle);
    job.status = "lost";
    job.code = null;
    if (handle) handle.kill();
    else signalRecorded(job);
    this.persist();
    if (!handle) return Promise.resolve();
    return waitFor(handle.done.then(() => {
      this.capture(job, handle);
      this.persist();
    }), KILL_WAIT_MS);
  }

  private capture(job: JobRecord, handle: StartedBash): void {
    const output = handle.output();
    job.stdout = output.stdout;
    job.stderr = output.stderr;
    job.stdoutTruncated = output.stdoutTruncated;
    job.stderrTruncated = output.stderrTruncated;
  }

  private scheduleOutput(): void {
    if (this.outputTimer !== undefined) return;
    this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      this.persist();
    }, OUTPUT_DELAY_MS);
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.next = 1;
      this.jobs = [];
      return;
    }
    const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    const store = parseStore(parsed);
    if (!store) throw new Error(`invalid job registry ${this.file}`);
    this.jobs = store.jobs;
    this.next = store.next;
  }

  private persist(): void {
    if (this.outputTimer !== undefined) {
      clearTimeout(this.outputTimer);
      this.outputTimer = undefined;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ next: this.next, jobs: this.jobs }));
    renameSync(tmp, this.file);
  }
}

function summarize(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length <= 80) return flat;
  return `${flat.slice(0, 77)}...`;
}

function formatJob(job: JobRecord): string {
  const head = job.status === "exited" && job.code !== null ? `${job.id} exited ${job.code}` : `${job.id} ${job.status}`;
  const notice = [
    job.stdoutTruncated ? "stdout truncated to the last 32 KiB" : "",
    job.stderrTruncated ? "stderr truncated to the last 32 KiB" : "",
  ].filter((part) => part.length > 0);
  return [head, job.stdout, job.stderr, ...notice].filter((part) => part.length > 0).join("\n");
}

function signalRecorded(job: JobRecord): void {
  if (job.pid === null || job.startTicks === null) return;
  if (processStartTicks(job.pid) !== job.startTicks) return;
  killGroup(job.pid, "SIGKILL");
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

function waitFor(done: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolveDone) => {
    const timer = setTimeout(resolveDone, ms);
    void done.then(() => {
      clearTimeout(timer);
      resolveDone();
    }, () => {
      clearTimeout(timer);
      resolveDone();
    });
  });
}

function parseStore(value: unknown): { next: number; jobs: JobRecord[] } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { next?: unknown; jobs?: unknown };
  if (!Array.isArray(record.jobs)) return null;
  const jobs: JobRecord[] = [];
  for (const item of record.jobs) {
    const job = parseJob(item);
    if (!job) return null;
    jobs.push(job);
  }
  let next = typeof record.next === "number" && Number.isInteger(record.next) && record.next > 0 ? record.next : 1;
  for (const job of jobs) {
    const match = /^j(\d+)$/.exec(job.id);
    const value = match ? Number(match[1]) : 0;
    if (value >= next) next = value + 1;
  }
  return { next, jobs };
}

function parseJob(value: unknown): JobRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<JobRecord>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.status !== "string" || !STATUSES.includes(record.status as JobStatus)) return null;
  if (typeof record.command !== "string" || typeof record.summary !== "string") return null;
  if (!(record.pid === null || (typeof record.pid === "number" && Number.isInteger(record.pid)))) return null;
  if (!(record.startTicks === null || typeof record.startTicks === "string")) return null;
  if (!(record.code === null || typeof record.code === "number")) return null;
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") return null;
  if (typeof record.stdoutTruncated !== "boolean" || typeof record.stderrTruncated !== "boolean") return null;
  return {
    id: record.id,
    status: record.status as JobStatus,
    summary: record.summary,
    command: record.command,
    pid: record.pid,
    startTicks: record.startTicks,
    code: record.code,
    stdout: record.stdout,
    stderr: record.stderr,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
  };
}
