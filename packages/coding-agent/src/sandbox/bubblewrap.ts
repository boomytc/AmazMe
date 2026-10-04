import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { WorkspacePolicy } from "./policy.ts";
import { unavailable } from "./seatbelt.ts";

export const BWRAP = "bwrap";

export interface BubblewrapStat {
  isFile(): boolean;
}

export interface BubblewrapOptions {
  platform?: NodeJS.Platform;
  runner?: string;
  stat?: (path: string) => BubblewrapStat;
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
  const runner = options.runner ?? BWRAP;
  const stat = options.stat ?? statSync;
  let info: BubblewrapStat;
  try {
    info = stat(runner);
  } catch {
    throw unavailable(`${runner} is required`);
  }
  if (!info.isFile()) throw unavailable(`${runner} is required`);
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
