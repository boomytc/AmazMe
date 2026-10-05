import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Plain worker executed by Node directly. It must stay free of TypeScript. */
export const fileOpPath = fileURLToPath(new URL("./file-op.mjs", import.meta.url));

export interface WorkspacePolicy {
  /** Absolute workspace path used by the lexical path check. */
  readonly workspace: string;
  /** realpath of the workspace. Seatbelt matches resolved paths. */
  readonly canonical: string;
  /** Private temp directory, also HOME and TMPDIR for the child. */
  readonly scratch: string;
  readonly profile: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Read-only trees for the system shell, the dynamic linker, and Homebrew Node.
 * Seatbelt skips a path that is not on the machine. Bubblewrap uses the same
 * list with `--ro-bind-try`, so a missing macOS or Linux directory is not mounted.
 */
export const RUNTIME_TREES = [
  "/System",
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/homebrew/etc",
];

function quote(path: string): string {
  return JSON.stringify(path);
}

function existing(paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of paths) {
    try {
      found.push(realpathSync(path));
    } catch {
      // Optional system trees differ by machine.
    }
  }
  return found;
}

function subpath(operation: string, paths: readonly string[]): string {
  const filters = paths.map((path) => `(subpath ${quote(path)})`).join(" ");
  return filters.length > 0 ? `(allow ${operation} ${filters})` : "";
}

function literal(operation: string, paths: readonly string[]): string {
  const filters = paths.map((path) => `(literal ${quote(path)})`).join(" ");
  return filters.length > 0 ? `(allow ${operation} ${filters})` : "";
}

/**
 * Seatbelt profile for one workspace. Later rules override earlier matches.
 * The final pair denies `<workspace>/.amazme` and then restores only its tmp directory.
 * Syscall numbers are Darwin `sys/syscall.h`: symlink 57, setpgid 82, setsid 147,
 * posix_spawn 244, symlinkat 474. fork and exec stay available.
 */
export function buildPolicy(root: string): WorkspacePolicy {
  const workspace = resolve(root);
  const canonical = realpathSync(workspace);
  const scratch = join(canonical, ".amazme", "tmp");
  const hidden = join(canonical, ".amazme");
  const execPath = realpathSync(process.execPath);
  const nodePrefix = dirname(dirname(execPath));
  const readTrees = [...new Set([...existing(RUNTIME_TREES), nodePrefix, dirname(execPath)])];
  const readLiterals = [
    ...new Set(["/", process.execPath, execPath, fileOpPath, realpathSync(fileOpPath), "/dev/null", "/dev/random", "/dev/urandom", canonical]),
  ];
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow process-info* (target self))",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow file-map-executable)",
    "(allow syscall-unix syscall-mach)",
    "(deny syscall-unix (syscall-number 57 82 147 244 474))",
    subpath("file-read*", [...readTrees, canonical, scratch]),
    literal("file-read*", readLiterals),
    subpath("file-write*", [canonical, scratch]),
    literal("file-write*", ["/dev/null"]),
    `(deny file-read* file-write* (subpath ${quote(hidden)}))`,
    subpath("file-read*", [scratch]),
    subpath("file-write*", [scratch]),
    "(deny file-link)",
  ];
  return {
    workspace,
    canonical,
    scratch,
    profile: lines.filter((line) => line.length > 0).join("\n"),
    env: {
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: scratch,
      TMPDIR: scratch,
      LANG: "en_US.UTF-8",
    },
  };
}
