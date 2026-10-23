import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Same directory name the product profile uses. The desktop reads it; it does not import the old host. */
export const CONFIG_DIR_NAME = ".amazme";
export const ENV_AGENT_DIR = "AMAZME_CODING_AGENT_DIR";

/** Expand a leading `~` the same way the profile path is stored. Other paths stay unchanged. */
export function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
	if (path.startsWith("file://")) return fileURLToPath(path);
	return path;
}
