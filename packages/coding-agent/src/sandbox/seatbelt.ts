import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function unavailable(detail: string): Error {
  return new Error(`SANDBOX_UNAVAILABLE: ${detail}`);
}

/** Wrap an absolute argv with Seatbelt. `runner` is the sandbox-exec path. */
export function seatbeltArgv(profile: string, command: readonly string[], runner = SANDBOX_EXEC): string[] {
  if (process.platform !== "darwin") throw unavailable(`seatbelt requires darwin, not ${process.platform}`);
  let info;
  try {
    info = statSync(runner);
  } catch {
    throw unavailable(`${runner} is required`);
  }
  if (!info.isFile()) throw unavailable(`${runner} is required`);
  const [executable, ...rest] = command;
  if (!executable || !isAbsolute(executable)) throw unavailable("command must be an absolute path");
  return [runner, "-p", profile, executable, ...rest];
}
