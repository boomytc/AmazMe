import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { WorkspacePolicy } from "./policy.ts";
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
 * `<workspace>/.amazme/tmp` is bound back. `--unshare-net` denies tool network.
 * This function never spawns. A missing runner or the wrong OS throws.
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
  return [
    runner,
    "--unshare-net",
    "--unshare-pid",
    "--unshare-uts",
    "--die-with-parent",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind", "/", "/",
    "--bind", policy.canonical, policy.canonical,
    "--tmpfs", hidden,
    "--bind", policy.scratch, policy.scratch,
    "--chdir", policy.canonical,
    "--",
    executable,
    ...rest,
  ];
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
