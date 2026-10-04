import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildPolicy, fileOpPath, type WorkspacePolicy } from "./policy.ts";
import { seatbeltArgv, unavailable } from "./seatbelt.ts";

const OUTPUT_TAIL_BYTES = 32 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 200;
const probed = new Set<string>();

export interface ConfinedResult {
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunConfinedOptions {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  /** When set, stdout and stderr keep only this many trailing bytes. */
  tailBytes?: number;
  input?: string;
  onStdout?: (text: string) => void;
  timeoutMs?: number;
}

function rememberTail(current: string, chunk: Buffer, limit: number): { text: string; truncated: boolean } {
  const next = Buffer.concat([Buffer.from(current), chunk]);
  if (next.length <= limit) return { text: next.toString("utf8"), truncated: false };
  return { text: next.subarray(next.length - limit).toString("utf8"), truncated: true };
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group already exited.
  }
}

export function runConfined(options: RunConfinedOptions): Promise<ConfinedResult> {
  const [file, ...args] = options.argv;
  if (!file) return Promise.resolve({ stdout: "", stderr: "missing command", code: 1, stdoutTruncated: false, stderrTruncated: false });
  return new Promise((resolveRun) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
    const limit = options.tailBytes;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => stop("SIGTERM"), options.timeoutMs ?? TOOL_TIMEOUT_MS);
    const stop = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) killGroup(child.pid, signal);
      if (signal === "SIGTERM" && killTimer === undefined) {
        killTimer = setTimeout(() => {
          if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
        }, KILL_GRACE_MS);
      }
    };
    const finish = (code: number | null, errorText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      if (errorText !== undefined) stderr = errorText;
      else if (limit === undefined) {
        stdout = Buffer.concat(stdoutChunks).toString("utf8");
        stderr = Buffer.concat(stderrChunks).toString("utf8");
      }
      resolveRun({ stdout, stderr, code, stdoutTruncated, stderrTruncated });
    };
    const onAbort = () => stop("SIGTERM");
    child.on("error", (error) => finish(1, error.message));
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (limit === undefined) stdoutChunks.push(chunk);
      else {
        const kept = rememberTail(stdout, chunk, limit);
        stdout = kept.text;
        stdoutTruncated = stdoutTruncated || kept.truncated;
        options.onStdout?.(stdout);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (limit === undefined) stderrChunks.push(chunk);
      else {
        const kept = rememberTail(stderr, chunk, limit);
        stderr = kept.text;
        stderrTruncated = stderrTruncated || kept.truncated;
      }
    });
    child.on("close", (code) => finish(code));
  });
}

function outsideProbeFile(canonical: string): string {
  const name = `.amazme-probe-${randomBytes(8).toString("hex")}`;
  const directories = [join(homedir(), ".amazme", "probes"), join("/private/tmp", "amazme-probes"), join(tmpdir(), "amazme-probes")];
  for (const directory of directories) {
    const file = join(directory, name);
    const rel = relative(canonical, resolve(file));
    if (rel.startsWith("..") || isAbsolute(rel)) return file;
  }
  throw unavailable("no probe path outside the workspace");
}

function probe(policy: WorkspacePolicy): void {
  const token = randomBytes(16).toString("hex");
  const runtimeDir = join(policy.canonical, ".amazme", "runtime");
  const runtimeFile = join(runtimeDir, `.probe-${token}`);
  const canary = outsideProbeFile(policy.canonical);
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(dirname(canary), { recursive: true, mode: 0o700 });
  writeFileSync(runtimeFile, token, { mode: 0o600 });
  writeFileSync(canary, token, { mode: 0o600 });
  try {
    const argv = seatbeltArgv(policy.profile, [process.execPath, fileOpPath, "probe", canary, runtimeFile]);
    const result = spawnSync(argv[0] ?? "", argv.slice(1), {
      cwd: policy.canonical,
      env: policy.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
    if (output.includes(token) || !String(result.stdout ?? "").includes("PROBE_OK") || result.status !== 0) {
      throw unavailable(`probe failed: ${output.slice(0, 500)}`);
    }
  } finally {
    rmSync(canary, { force: true });
    rmSync(runtimeFile, { force: true });
    try {
      rmdirSync(dirname(canary));
    } catch {
      // Another probe may still be using the directory.
    }
  }
}

/** Build the workspace policy and prove Seatbelt once per canonical root. */
export function prepareWorkspace(root: string): WorkspacePolicy {
  const policy = buildPolicy(root);
  mkdirSync(policy.scratch, { recursive: true, mode: 0o700 });
  chmodSync(policy.scratch, 0o700);
  if (!probed.has(policy.canonical)) {
    probe(policy);
    probed.add(policy.canonical);
  }
  return policy;
}

export interface FileOpResult {
  ok: boolean;
  text: string;
}

export async function runFileOp(
  policy: WorkspacePolicy,
  op: "read" | "write" | "edit",
  body: { path: string; content?: string; old?: string; replacement?: string },
  signal: AbortSignal,
): Promise<FileOpResult> {
  const argv = seatbeltArgv(policy.profile, [process.execPath, fileOpPath, op, policy.workspace]);
  const result = await runConfined({
    argv,
    cwd: policy.canonical,
    env: policy.env,
    signal,
    input: JSON.stringify(body),
  });
  if (!result.stdout.startsWith("{")) {
    const detail = [result.stderr, result.stdout].filter((part) => part.length > 0).join("\n");
    return { ok: false, text: detail || `exit ${result.code ?? 0}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { ok?: unknown; text?: unknown };
    return { ok: parsed.ok === true, text: typeof parsed.text === "string" ? parsed.text : "" };
  } catch {
    return { ok: false, text: result.stderr || "file operation failed" };
  }
}

export async function runBash(
  policy: WorkspacePolicy,
  command: string,
  signal: AbortSignal,
  onStdout?: (text: string) => void,
): Promise<ConfinedResult> {
  const argv = seatbeltArgv(policy.profile, ["/bin/bash", "-c", command]);
  return runConfined({
    argv,
    cwd: policy.canonical,
    env: policy.env,
    signal,
    tailBytes: OUTPUT_TAIL_BYTES,
    onStdout,
  });
}
