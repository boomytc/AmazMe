import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareWorkspace, startBash, type StartedBash } from "./sandbox/run.ts";

/**
 * 后台任务记在工作区 `.amazme/runtime/jobs.json`。
 * 问题：同一工作区可以同时有两个宿主。后打开的那个若把文件里所有 running 都收成 lost，会杀掉先打开的宿主还在跑的进程，两边还会互相盖写这份文件。
 * 例子：`amazme` 里挂着一个后台服务，接着 `amazme -p` 用临时 socket 再开一份。第二份不能把第一份的服务杀掉。
 * 每条记录带上宿主进程的 `owner`。打开时只回收 owner 已经不在的任务。落盘前重读文件，只替换自己的条目。
 */
export type JobStatus = "running" | "exited" | "killed" | "lost";

/** Host process that started the job. `startTicks` is Linux `/proc/<pid>/stat` starttime. */
export interface JobOwner {
  pid: number;
  startTicks: string | null;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  summary: string;
  command: string;
  pid: number | null;
  /** Linux `/proc/<pid>/stat` starttime. Identifies the job process across pid reuse. */
  startTicks: string | null;
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Null when the record was written before owners existed. That host is treated as gone. */
  owner: JobOwner | null;
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
  readonly owner: JobOwner;
  closed = false;
  private next = 1;
  private jobs: JobRecord[] = [];
  private readonly handles = new Map<string, StartedBash>();
  private outputTimer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(cwd: string) {
    this.cwd = cwd;
    this.file = jobsFile(cwd);
    this.owner = { pid: process.pid, startTicks: processStartTicks(process.pid) };
  }

  static open(cwd: string): JobRegistry {
    const registry = new JobRegistry(resolve(cwd));
    const store = registry.readDisk();
    registry.next = store.next;
    let changed = false;
    for (const job of store.jobs) {
      const mine = sameOwner(job.owner, registry.owner);
      if (job.status === "running" && !mine && ownerGone(job.owner)) {
        signalRecorded(job);
        job.status = "lost";
        job.code = null;
        changed = true;
        registry.jobs.push(job);
      } else if (mine) registry.jobs.push(job);
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
    const id = this.allocateId();
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
      owner: this.owner,
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

  /** Missing file is empty. Unreadable JSON is renamed aside so startup can continue. */
  private readDisk(): { next: number; jobs: JobRecord[] } {
    if (!existsSync(this.file)) return { next: 1, jobs: [] };
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { next: 1, jobs: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      quarantine(this.file);
      return { next: 1, jobs: [] };
    }
    const store = parseStore(parsed);
    if (!store) {
      quarantine(this.file);
      return { next: 1, jobs: [] };
    }
    return store;
  }

  private allocateId(): string {
    const disk = this.readDisk();
    const used = new Set<string>([...disk.jobs.map((job) => job.id), ...this.jobs.map((job) => job.id)]);
    let n = Math.max(this.next, disk.next);
    let id = `j${this.owner.pid}-${n}`;
    while (used.has(id)) {
      n += 1;
      id = `j${this.owner.pid}-${n}`;
    }
    this.next = n + 1;
    return id;
  }

  private persist(): void {
    if (this.outputTimer !== undefined) {
      clearTimeout(this.outputTimer);
      this.outputTimer = undefined;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const disk = this.readDisk();
    const own = new Map(this.jobs.map((job) => [job.id, job]));
    const merged: JobRecord[] = [];
    const seen = new Set<string>();
    for (const job of disk.jobs) {
      merged.push(own.get(job.id) ?? job);
      seen.add(job.id);
    }
    for (const job of this.jobs) {
      if (seen.has(job.id)) continue;
      merged.push(job);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ next: Math.max(this.next, disk.next), jobs: merged }));
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

function sameOwner(owner: JobOwner | null, ours: JobOwner): boolean {
  return owner !== null && owner.pid === ours.pid && owner.startTicks === ours.startTicks;
}

/** The host that wrote the record has exited, or the pid was reused. */
function ownerGone(owner: JobOwner | null): boolean {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 1) return true;
  const ticks = processStartTicks(owner.pid);
  if (ticks === null) {
    try {
      process.kill(owner.pid, 0);
    } catch {
      return true;
    }
    return owner.startTicks !== null;
  }
  return owner.startTicks !== ticks;
}

function quarantine(file: string): void {
  const stamp = Date.now();
  let dest = `${file}.corrupt-${stamp}`;
  let extra = 0;
  while (existsSync(dest)) {
    extra += 1;
    dest = `${file}.corrupt-${stamp}-${extra}`;
  }
  try {
    renameSync(file, dest);
  } catch {
    // Startup still proceeds from an empty registry. The next persist replaces the bad file.
  }
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
  const owner = parseOwner(record.owner);
  if (record.owner !== undefined && record.owner !== null && owner === null) return null;
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
    owner,
  };
}

function parseOwner(value: unknown): JobOwner | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object") return null;
  const pid = "pid" in value ? value.pid : undefined;
  const startTicks = "startTicks" in value ? value.startTicks : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (!(startTicks === null || typeof startTicks === "string")) return null;
  return { pid, startTicks };
}
