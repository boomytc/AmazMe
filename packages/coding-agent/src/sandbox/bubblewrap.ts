import { openSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileOpPath, type WorkspacePolicy } from "./policy.ts";
import { unavailable } from "./seatbelt.ts";

export const BWRAP = "bwrap";

export interface BubblewrapStat {
  isFile(): boolean;
}

export interface BubblewrapOptions {
  platform?: NodeJS.Platform;
  /** Bare name or absolute path. A bare name is resolved through `pathEnv` before stat. */
  runner?: string;
  stat?: (path: string) => BubblewrapStat;
  /** Directory list used to resolve a bare runner. Production uses `PATH`. */
  pathEnv?: string;
}

/**
 * Linux mount of the same workspace policy Seatbelt enforces on darwin.
 * The workspace is writable, `<workspace>/.amazme` is a fresh tmpfs, and only
 * `<workspace>/.amazme/tmp` is bound back. Read access is the Seatbelt read
 * roots, not the whole filesystem: binding `/` made the probe canary readable,
 * `prepareWorkspace` threw during runtime open, and attach came back as
 * `internal server error`.
 * `--unshare-net` isolates the network. `--seccomp 3` makes `socket` return
 * EPERM, which is the denial the probe checks. The caller passes
 * `networkSeccompFd()` as file descriptor 3. This function never spawns.
 * A missing runner or the wrong OS throws.
 */
export function bubblewrapArgv(
  policy: WorkspacePolicy,
  command: readonly string[],
  options: BubblewrapOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") throw unavailable(`bubblewrap requires linux, not ${platform}`);
  const stat = options.stat ?? statSync;
  const runner = resolveRunner(options.runner ?? BWRAP, options.pathEnv ?? process.env.PATH ?? "", stat);
  const [executable, ...rest] = command;
  if (!executable || !isAbsolute(executable)) throw unavailable("command must be an absolute path");
  const hidden = join(policy.canonical, ".amazme");
  const argv = [
    runner,
    "--unshare-net",
    "--unshare-pid",
    "--unshare-uts",
    "--die-with-parent",
    "--proc", "/proc",
    "--dev", "/dev",
    "--seccomp", "3",
  ];
  for (const path of readOnlyBinds()) argv.push("--ro-bind-try", path, path);
  argv.push(
    "--bind", policy.canonical, policy.canonical,
    "--tmpfs", hidden,
    "--bind", policy.scratch, policy.scratch,
    "--remount-ro", "/",
    "--chdir", policy.canonical,
    "--",
    executable,
    ...rest,
  );
  return argv;
}

const READ_ROOTS = [
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/homebrew/etc",
];

function readOnlyBinds(): string[] {
  const paths = [...READ_ROOTS, dirname(fileOpPath)];
  try {
    const execPath = realpathSync(process.execPath);
    paths.push(dirname(execPath), dirname(dirname(execPath)));
  } catch {
    // The dynamic linker and Node still have to be mounted for the child to start.
  }
  return [...new Set(paths.filter((path) => path.length > 1))];
}

/** `stat` does not search PATH. A bare name is joined to each directory first. This never spawns. */
function resolveRunner(runner: string, pathEnv: string, stat: (path: string) => BubblewrapStat): string {
  const candidates = isAbsolute(runner) ? [runner] : pathEnv.split(delimiter).filter((dir) => dir.length > 0).map((dir) => join(dir, runner));
  for (const candidate of candidates) {
    try {
      if (stat(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry. A missing file is not a spawn.
    }
  }
  throw unavailable(`${runner} is required`);
}

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_EPERM = 0x00050001;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const NR_SOCKET_X86_64 = 41;
const NR_SOCKET_AARCH64 = 198;

let seccompPath: string | undefined;

/**
 * A new fd for `--seccomp 3`. `socket` returns EPERM; other calls are allowed.
 * Callers close it after `spawn` returns. `spawnSync` may close it itself.
 */
export function networkSeccompFd(): number {
  if (seccompPath === undefined) {
    seccompPath = join(tmpdir(), `amazme-seccomp-${process.pid}`);
    writeFileSync(seccompPath, networkSeccompFilter());
  }
  return openSync(seccompPath, "r");
}

function insn(code: number, k: number, jt = 0, jf = 0): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16LE(code, 0);
  bytes.writeUInt8(jt, 2);
  bytes.writeUInt8(jf, 3);
  bytes.writeUInt32LE(k >>> 0, 4);
  return bytes;
}

/**
 * Classic BPF. A new network namespace still answers `127.0.0.1` with
 * ECONNREFUSED, and the probe treats only EPERM as a network denial.
 */
function networkSeccompFilter(): Buffer {
  return Buffer.concat([
    insn(BPF_LD_W_ABS, 4),
    insn(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0),
    insn(BPF_JMP_JEQ_K, AUDIT_ARCH_AARCH64, 4, 3),
    insn(BPF_LD_W_ABS, 0),
    insn(BPF_JMP_JEQ_K, NR_SOCKET_X86_64, 0, 1),
    insn(BPF_RET_K, SECCOMP_RET_EPERM),
    insn(BPF_RET_K, SECCOMP_RET_ALLOW),
    insn(BPF_LD_W_ABS, 0),
    insn(BPF_JMP_JEQ_K, NR_SOCKET_AARCH64, 0, 1),
    insn(BPF_RET_K, SECCOMP_RET_EPERM),
    insn(BPF_RET_K, SECCOMP_RET_ALLOW),
  ]);
}
