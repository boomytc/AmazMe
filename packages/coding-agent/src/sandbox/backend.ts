import { bubblewrapArgv } from "./bubblewrap.ts";
import type { WorkspacePolicy } from "./policy.ts";
import { seatbeltArgv, unavailable } from "./seatbelt.ts";

/** Pick the backend for this policy. Darwin is Seatbelt. Linux is Bubblewrap. Anything else fails closed. */
export function sandboxArgv(
  policy: WorkspacePolicy,
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") return seatbeltArgv(policy.profile, command);
  if (platform === "linux") return bubblewrapArgv(policy, command, { platform });
  throw unavailable(`no sandbox backend for ${platform}`);
}
