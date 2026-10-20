import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readFileSync, unlinkSync } from "node:fs";
import { link, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readInstallJob } from "./update-job.ts";
import { verifyApp, type AppIdentity, type InstallJob } from "./macos-update.ts";

export interface UpdateLockOwner {
	readonly target: string;
	readonly directory: string;
	readonly nonce: string;
	readonly pid: number;
	readonly version: string;
	readonly phase: "preparing" | "launching";
}
export function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}
function privateDirectory(path: string): boolean {
	const stat = lstatSync(path);
	return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && realpathSync(path) === path;
}
export function readUpdateLock(target: string): UpdateLockOwner | undefined {
	try {
		const path = target + ".update-lock", stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096 || realpathSync(path) !== path) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateLockOwner>;
		if (value.target !== target || typeof value.directory !== "string" || dirname(value.directory) !== dirname(target)
			|| !value.directory.startsWith(join(dirname(target), ".AmazMe-update-")) || !privateDirectory(value.directory)
			|| typeof value.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(value.nonce)
			|| typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 2
			|| typeof value.version !== "string" || !["preparing", "launching"].includes(String(value.phase))) return undefined;
		return value as UpdateLockOwner;
	} catch { return undefined; }
}
export function updateLockState(target: string): "none" | "active" | "stale" | "unknown" {
	try { lstatSync(target + ".update-lock"); }
	catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT" ? "none" : "unknown"; }
	const owner = readUpdateLock(target);
	return owner ? processIsAlive(owner.pid) ? "active" : "stale" : "unknown";
}

/** Link a complete fsynced record atomically. Never truncate an existing lock, even on duplicate start. */
export async function acquireUpdateLock(directory: string, job: InstallJob): Promise<void> {
	const record: UpdateLockOwner = { target: job.target, directory, nonce: job.nonce, pid: process.pid, version: job.current, phase: "preparing" };
	const prepared = join(directory, "lock-owner-" + randomUUID() + ".json");
	const handle = await open(prepared, "wx", 0o600);
	try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
	try { await link(prepared, job.target + ".update-lock"); }
	catch (error) { throw new Error(error instanceof Error && "code" in error && error.code === "EEXIST" ? "busy" : "permission"); }
	finally { await unlink(prepared); }
}
export async function authorizeUpdateLaunch(directory: string, job: InstallJob, version: string): Promise<void> {
	const record = { target: job.target, directory, nonce: job.nonce, pid: process.pid, version, phase: "launching" };
	const temporary = join(directory, "lock-owner.tmp");
	await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
	await rename(temporary, job.target + ".update-lock");
}
export async function releaseUpdateLock(directory: string, job: InstallJob): Promise<void> {
	const owner = readUpdateLock(job.target);
	if (owner?.directory === directory && owner.pid === process.pid && owner.nonce === job.nonce) await unlink(job.target + ".update-lock");
}

/** Caller holds Electron's singleton. Recovery verifies the app; it never moves files or resumes installation. */
export async function recoverStaleUpdateLock(target: string, version: string, arch: string,
	verify: (path: string, version: string, arch: string, team?: string) => Promise<AppIdentity> = verifyApp,
): Promise<"recovered" | "active" | "unknown"> {
	const owner = readUpdateLock(target);
	if (!owner) return "unknown";
	if (processIsAlive(owner.pid)) return "active";
	try {
		const originalStat = lstatSync(target + ".update-lock");
		const job = await readInstallJob(owner.directory);
		if (job.target !== target || job.nonce !== owner.nonce || ![job.current, job.version].includes(version)) return "unknown";
		const identity = await verify(target, version, arch, job.team);
		if (version === job.current && identity.hash !== job.originalHash) return "unknown";
		const path = target + ".update-lock", latest = readUpdateLock(target), currentStat = lstatSync(path);
		// No yielding between the final owner/inode/death check and unlink.
		if (originalStat.ino !== currentStat.ino || JSON.stringify(latest) !== JSON.stringify(owner)) return "unknown";
		if (processIsAlive(owner.pid)) return "active";
		try { unlinkSync(path); } catch {
			// A now read-only app directory must not make the verified current app permanently unlaunchable.
			// The known dead lock remains and continues to prevent another installer from claiming it.
		}
		return "recovered";
	} catch { return "unknown"; }
}
