import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareWorkspace, startBash, type StartedBash } from "./sandbox/run.ts";

/**
 * 后台任务记在工作区 `.amazme/runtime/jobs.json`。
 * 问题：同一工作区可以同时有两个宿主。后打开的那个若把文件里所有 running 都收成 lost，会杀掉先打开的宿主还在跑的进程，两边还会互相盖写这份文件。
 * 例子：`amazme` 里挂着一个后台服务，接着 `amazme -p` 用临时 socket 再开一份。第二份不能把第一份的服务杀掉。
 * 每条记录带上宿主进程的 `owner`。打开时只回收 owner 已经不在的任务。落盘前重读文件，只替换自己的条目。
 * 两次落盘会交错：各自读到旧内容再整文件写回，后写的一份丢掉先写的新任务。写之前用 `jobs.json.lock` 独占；锁里是持有者的 pid 和 starttime，进程不在就抢走。
 * 问题：输出定时器、进程结束、kill、lose 若同步空等这把锁，事件循环会停住。
 * 例子：另一个活进程占着锁时，10ms 的定时器会出现大约两秒的空隙。
 * 这些路径用 tryLock，只抢一次，忙就立刻返回。写不上就留着 pendingWrite，200ms 起每次加倍、最多 5s 再试。写成功后清掉 pendingWrite，退避回到 200ms。`start` 和 `open` 仍最多等两秒。
 * 结束了的任务只留最新 50 条，running 不删。输出和状态都没变时不重写文件。
 * 打开登记时若两秒内拿不到锁，跳过回收，不把异常抛出进程。任务编号在启动进程之前分配。
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
const FINISHED_KEEP = 50;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 20;
const LOCK_BUSY = "jobs.json.lock busy";
const RETRY_START_MS = 200;
const RETRY_MAX_MS = 5_000;

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
  private lockDepth = 0;
  /** A callback persist could not write. Memory stays; retries back off until a write succeeds. */
  private pendingWrite = false;
  private retryDelayMs = RETRY_START_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(cwd: string) {
    this.cwd = cwd;
    this.file = jobsFile(cwd);
    this.owner = { pid: process.pid, startTicks: processStartTicks(process.pid) };
  }

  static open(cwd: string): JobRegistry {
    const registry = new JobRegistry(resolve(cwd));
    try {
      registry.withLock(() => {
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
        if (changed) registry.writeStore();
      });
    } catch (error) {
      if (!lockBusy(error)) throw error;
    }
    return registry;
  }

  start(command: string): string {
    if (this.closed) throw new Error("job registry is closed");
    const id = this.allocateId();
    let started: JobRecord | undefined;
    let running: StartedBash | undefined;
    const handle = startBash(prepareWorkspace(this.cwd), command, () => {
      if (!started || !running || started.status !== "running") return;
      this.capture(started, running);
      this.scheduleOutput();
    });
    running = handle;
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
    try {
      this.persist();
    } catch (error) {
      this.jobs = this.jobs.filter((item) => item !== job);
      this.handles.delete(id);
      handle.kill();
      throw error;
    }
    void handle.done.then((result) => {
      this.capture(job, handle);
      if (job.status === "running") {
        job.status = "exited";
        job.code = result.code;
      }
      this.persistOrRetry();
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
    this.persistOrRetry();
    if (handle) {
      void handle.done.then(() => {
        this.capture(job, handle);
        this.persistOrRetry();
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
    this.persistOrRetry();
    if (!handle) return Promise.resolve();
    return waitFor(handle.done.then(() => {
      this.capture(job, handle);
      this.persistOrRetry();
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
      this.persistOrRetry();
    }, OUTPUT_DELAY_MS);
  }

  /** Missing file is empty. Unreadable JSON is renamed aside so startup can continue. */
  private readDisk(): { next: number; jobs: JobRecord[]; raw: string | null } {
    if (!existsSync(this.file)) return { next: 1, jobs: [], raw: null };
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { next: 1, jobs: [], raw: null };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      quarantine(this.file);
      return { next: 1, jobs: [], raw: null };
    }
    const store = parseStore(parsed);
    if (!store) {
      quarantine(this.file);
      return { next: 1, jobs: [], raw: null };
    }
    return { ...store, raw };
  }

  private allocateId(): string {
    return this.withLock(() => {
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
    });
  }

  /** `start` may wait out the lock. A failed write throws so the caller can kill the unrecorded process. */
  private persist(): void {
    this.withLock(() => this.writeStore());
    this.clearPendingWrite();
  }

  /**
   * Output timer, process exit, kill, and lose. One lock attempt, then return.
   * A failed write stays pending and retries with exponential backoff.
   */
  private persistOrRetry(): void {
    try {
      this.withTryLock(() => this.writeStore());
      this.clearPendingWrite();
    } catch {
      this.pendingWrite = true;
      this.scheduleRetry();
    }
  }

  private clearPendingWrite(): void {
    this.pendingWrite = false;
    this.retryDelayMs = RETRY_START_MS;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.persistOrRetry();
    }, delay);
  }

  /** Caller holds `jobs.json.lock`. Re-reads, merges this registry's jobs, prunes, and skips an identical write. */
  private writeStore(): void {
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
    const jobs = pruneFinished(merged);
    const keep = new Set(jobs.map((job) => job.id));
    this.jobs = this.jobs.filter((job) => keep.has(job.id));
    const next = Math.max(this.next, disk.next);
    this.next = next;
    const text = JSON.stringify({ next, jobs });
    if (disk.raw === text) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
  }

  private withLock<T>(body: () => T): T {
    if (this.lockDepth > 0) return body();
    return withJobsLock(this.file, this.owner, () => {
      this.lockDepth += 1;
      try {
        return body();
      } finally {
        this.lockDepth -= 1;
      }
    });
  }

  private withTryLock<T>(body: () => T): T {
    if (this.lockDepth > 0) return body();
    return tryJobsLock(this.file, this.owner, () => {
      this.lockDepth += 1;
      try {
        return body();
      } finally {
        this.lockDepth -= 1;
      }
    });
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

/** Oldest finished rows go first. Running rows stay, including ones older than the kept finished rows. */
function pruneFinished(jobs: JobRecord[]): JobRecord[] {
  let finished = 0;
  for (const job of jobs) if (job.status !== "running") finished += 1;
  const drop = finished - FINISHED_KEEP;
  if (drop <= 0) return jobs;
  let skipped = 0;
  const kept: JobRecord[] = [];
  for (const job of jobs) {
    if (job.status !== "running" && skipped < drop) {
      skipped += 1;
      continue;
    }
    kept.push(job);
  }
  return kept;
}

function withJobsLock<T>(file: string, owner: JobOwner, body: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  acquireJobsLock(lock, owner);
  try {
    return body();
  } finally {
    releaseJobsLock(lock, owner);
  }
}

/** One attempt. A live holder returns immediately. An abandoned lock is taken without waiting. */
function tryJobsLock<T>(file: string, owner: JobOwner, body: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!tryAcquireJobsLock(lock, owner)) throw new Error(LOCK_BUSY);
  try {
    return body();
  } finally {
    releaseJobsLock(lock, owner);
  }
}

function tryAcquireJobsLock(lock: string, owner: JobOwner): boolean {
  if (claimJobsLock(lock, owner)) return true;
  if (!lockAbandoned(lock)) return false;
  try { unlinkSync(lock); } catch { /* the other waiter already removed it */ }
  return claimJobsLock(lock, owner);
}

function claimJobsLock(lock: string, owner: JobOwner): boolean {
  let fd: number;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
    return false;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: owner.pid, startTicks: owner.startTicks }));
  } finally {
    closeSync(fd);
  }
  if (sameOwner(readLockOwner(lock), owner)) return true;
  if (readLockOwner(lock) === null) {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
  return false;
}

function acquireJobsLock(lock: string, owner: JobOwner): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(LOCK_BUSY);
    let fd: number | undefined;
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      if (lockAbandoned(lock)) {
        try { unlinkSync(lock); } catch { /* the other waiter already removed it */ }
        continue;
      }
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: owner.pid, startTicks: owner.startTicks }));
    } finally {
      closeSync(fd);
    }
    if (!sameOwner(readLockOwner(lock), owner)) continue;
    return;
  }
}

function releaseJobsLock(lock: string, owner: JobOwner): void {
  if (!sameOwner(readLockOwner(lock), owner)) return;
  try { unlinkSync(lock); } catch { /* already released */ }
}

function readLockOwner(lock: string): JobOwner | null {
  try {
    return parseOwner(JSON.parse(readFileSync(lock, "utf8")));
  } catch {
    return null;
  }
}

/** A parsed holder whose process is gone, or a lock that never recorded a live holder. */
function lockAbandoned(lock: string): boolean {
  const holder = readLockOwner(lock);
  if (holder !== null) return ownerGone(holder);
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_POLL_MS;
  } catch {
    return true;
  }
}

function lockBusy(error: unknown): boolean {
  return error instanceof Error && error.message === LOCK_BUSY;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
