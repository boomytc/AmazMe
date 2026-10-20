import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { acquireUpdateLock, readUpdateLock, recoverStaleUpdateLock, releaseUpdateLock, updateLockState } from "../src/update-lock.ts";
import type { InstallJob } from "../src/macos-update.ts";
import { createTempDir } from "./temp-dir.ts";

function fixture() {
	const root = realpathSync(createTempDir("amazme-stale-lock-"));
	const target = join(root, "AmazMe.app"); mkdirSync(target);
	const directory = join(root, ".AmazMe-update-fixture"); mkdirSync(directory, { mode: 0o700 });
	const job: InstallJob = { target, current: "8.5.0", version: "8.6.0", team: "ABCDE12345", arch: "arm64", originalHash: "a".repeat(40), parentPid: process.pid, nonce: randomUUID() };
	writeFileSync(join(directory, "job.json"), JSON.stringify(job), { mode: 0o600 });
	return { target, directory, job };
}
test("atomic acquisition is complete immediately and a duplicate never truncates the live owner's record", async () => {
	const f = fixture(); await acquireUpdateLock(f.directory, f.job);
	try {
		const original = readFileSync(f.target + ".update-lock", "utf8");
		expect(readUpdateLock(f.target)).toMatchObject({ pid: process.pid, phase: "preparing", nonce: f.job.nonce });
		await expect(acquireUpdateLock(f.directory, f.job)).rejects.toThrow("busy");
		expect(readFileSync(f.target + ".update-lock", "utf8")).toBe(original);
		const verify = vi.fn();
		expect(await recoverStaleUpdateLock(f.target, f.job.current, "arm64", verify)).toBe("active");
		expect(verify).not.toHaveBeenCalled();
	} finally { await releaseUpdateLock(f.directory, f.job); }
});
test("a killed helper's known lock is cleared only after re-verifying the unchanged original", async () => {
	const f = fixture(); await acquireUpdateLock(f.directory, f.job);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
	writeFileSync(f.target + ".update-lock", JSON.stringify({ ...readUpdateLock(f.target), pid: child.pid }));
	const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.kill("SIGKILL"); await exit;
	expect(updateLockState(f.target)).toBe("stale");
	expect(await recoverStaleUpdateLock(f.target, f.job.current, "arm64", async () => { throw new Error("signature"); })).toBe("unknown");
	expect(existsSync(f.target + ".update-lock")).toBe(true);
	expect(await recoverStaleUpdateLock(f.target, f.job.current, "arm64", async () => ({ team: f.job.team, hash: "b".repeat(40) }))).toBe("unknown");
	expect(existsSync(f.target + ".update-lock")).toBe(true);
	const verify = vi.fn(async () => ({ team: f.job.team, hash: f.job.originalHash }));
	expect(await recoverStaleUpdateLock(f.target, f.job.current, "arm64", verify)).toBe("recovered");
	expect(verify).toHaveBeenCalledWith(f.target, f.job.current, "arm64", f.job.team);
	expect(existsSync(f.target + ".update-lock")).toBe(false);
	expect(existsSync(f.target)).toBe(true);
});
test("unknown lock records are never deleted or used to authorize startup", async () => {
	const f = fixture(), lock = f.target + ".update-lock";
	writeFileSync(lock, '{"unknown":"preserve"}', { mode: 0o600 });
	expect(await recoverStaleUpdateLock(f.target, f.job.current, "arm64", vi.fn())).toBe("unknown");
	expect(readFileSync(lock, "utf8")).toBe('{"unknown":"preserve"}');
});
