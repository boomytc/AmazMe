import { chmodSync, closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileOpPath, RUNTIME_TREES, type WorkspacePolicy } from "./policy.ts";
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
 * `networkSeccompFd().fd` as file descriptor 3 and `close()`s it after spawn.
 * This function never spawns.
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

function readOnlyBinds(): string[] {
  const paths = [...RUNTIME_TREES, dirname(fileOpPath)];
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
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_EPERM = 0x00050001;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
/** x32 calls keep `AUDIT_ARCH_X86_64` and set this bit in the syscall number. */
const X32_SYSCALL_BIT = 0x40000000;
const NR_SOCKET_X86_64 = 41;
const NR_SOCKET_AARCH64 = 198;

export interface SeccompFilter {
  /** Read-only fd positioned at the start of the filter. Pass it as `--seccomp` fd 3. */
  fd: number;
  /** Close the fd and delete the private directory. `spawnSync` may already have closed the fd. */
  close(): void;
}

/**
 * A private filter file for one `--seccomp 3` spawn. `socket` returns EPERM on
 * x86_64 and aarch64. x86_64 syscall numbers at or above 0x40000000 are denied.
 * Every other architecture is denied.
 * The directory is 0700 and the file is created with `O_EXCL` at 0600. `close`
 * removes both after the sandbox has inherited the fd.
 */
export function networkSeccompFd(): SeccompFilter {
  const directory = mkdtempSync(join(tmpdir(), "amazme-seccomp-"));
  chmodSync(directory, 0o700);
  const file = join(directory, "filter");
  let fd: number;
  try {
    const created = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeSync(created, networkSeccompFilter());
    } finally {
      closeSync(created);
    }
    chmodSync(file, 0o600);
    fd = openSync(file, constants.O_RDONLY);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    fd,
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // spawnSync closes a stdio fd it was given.
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
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
 * x86_64 and aarch64 allow every call except `socket`. Any other
 * architecture is denied, so that child cannot run.
 * x32 syscalls from an x86_64 process keep `AUDIT_ARCH_X86_64` and set bit
 * 0x40000000 in the number. An architecture compare with 0x4000003e does not
 * see them, so x86_64 denies every number at or above that bit.
 *
 * Jumps are counted from the next instruction:
 *   0 LD arch
 *   1 JEQ x86_64  -> 4, else 2
 *   2 JEQ aarch64 -> 10, else 3
 *   3 RET EPERM
 *   4 LD nr
 *   5 JGE 0x40000000 -> 6, else 7
 *   6 RET EPERM
 *   7 JEQ socket / 8 RET EPERM / 9 RET ALLOW
 *  10 LD nr / 11 JEQ socket / 12 RET EPERM / 13 RET ALLOW
 */
function networkSeccompFilter(): Buffer {
  return Buffer.concat([
    insn(BPF_LD_W_ABS, 4),
    insn(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 2, 0),
    insn(BPF_JMP_JEQ_K, AUDIT_ARCH_AARCH64, 7, 0),
    insn(BPF_RET_K, SECCOMP_RET_EPERM),
    insn(BPF_LD_W_ABS, 0),
    insn(BPF_JMP_JGE_K, X32_SYSCALL_BIT, 0, 1),
    insn(BPF_RET_K, SECCOMP_RET_EPERM),
    insn(BPF_JMP_JEQ_K, NR_SOCKET_X86_64, 0, 1),
    insn(BPF_RET_K, SECCOMP_RET_EPERM),
    insn(BPF_RET_K, SECCOMP_RET_ALLOW),
    insn(BPF_LD_W_ABS, 0),
    insn(BPF_JMP_JEQ_K, NR_SOCKET_AARCH64, 0, 1),
    insn(BPF_RET_K, SECCOMP_RET_EPERM),
    insn(BPF_RET_K, SECCOMP_RET_ALLOW),
  ]);
}
