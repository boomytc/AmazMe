import { processIsAlive, readUpdateLock, updateLockState } from "./update-lock.ts";

/** The installer creates this lock while the original app still owns Electron's singleton. */
export function mayStartInstalledApp(target: string, version: string, args: readonly string[]): boolean {
	if (updateLockState(target) === "none") return true;
	const index = args.indexOf("--amazme-update-job");
	if (index < 0) return false;
	try {
		const owner = readUpdateLock(target);
		return owner !== undefined && owner.phase === "launching" && owner.directory === args[index + 1] && owner.nonce === args[index + 2]
			&& owner.version === version && processIsAlive(owner.pid);
	} catch { return false; }
}
