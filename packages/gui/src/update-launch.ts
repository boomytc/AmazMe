import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The installer creates this lock while the original app still owns Electron's singleton. */
export function mayStartInstalledApp(target: string, version: string, args: readonly string[]): boolean {
	const lock = target + ".update-lock";
	try { lstatSync(lock); }
	catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
	const index = args.indexOf("--amazme-update-job");
	if (index < 0) return false;
	try {
		const directory = args[index + 1], nonce = args[index + 2];
		if (!directory || !nonce || dirname(directory) !== dirname(target)) return false;
		const privateDirectory = (path: string): boolean => {
			const stat = lstatSync(path);
			return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && realpathSync(path) === path;
		};
		if (!privateDirectory(lock) || !privateDirectory(directory) || !directory.startsWith(join(dirname(target), ".AmazMe-update-"))) return false;
		const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as Record<string, unknown>;
		const job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8")) as Record<string, unknown>;
		if (owner.target !== target || owner.directory !== directory || owner.version !== version || owner.nonce !== nonce || job.nonce !== nonce || job.target !== target) return false;
		if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid < 2) return false;
		process.kill(owner.pid, 0);
		return version === job.version || version === job.current;
	} catch { return false; }
}
