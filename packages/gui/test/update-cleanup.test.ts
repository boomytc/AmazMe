import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createUpdateController, type DesktopUpdateIO } from "../src/updates/update-controller.ts";
import { discardPreparedUpdate } from "../src/updates/update-cleanup.ts";
import { acquireUpdateLock, readUpdateLock, recoverStaleUpdateLock, updateLockState } from "../src/updates/update-lock.ts";
import { mayStartInstalledApp } from "../src/updates/update-launch.ts";
import type { InstallJob } from "../src/updates/macos-update.ts";
import { createTempDir } from "./temp-dir.ts";

function fixture() {
	const root = realpathSync(createTempDir("amazme-cleanup-matrix-"));
	const target = join(root, "AmazMe.app"); mkdirSync(target);
	const directory = join(root, ".AmazMe-update-fixture"); mkdirSync(directory, { mode: 0o700 });
	const job: InstallJob = { target, current: "8.5.0", version: "8.6.0", team: "ABCDE12345", arch: "arm64", originalHash: "a".repeat(40), parentPid: process.pid, nonce: randomUUID() };
	writeFileSync(join(directory, "job.json"), JSON.stringify(job), { mode: 0o600 });
	return { root, target, directory, job, prepared: { directory } };
}
test.each([undefined, "postponed", "failed"])("unowned staging before replacement can be cleaned after quit/cancel/preflight failure (%s)", async phase => {
	const f = fixture();
	if (phase) writeFileSync(join(f.directory, "status.json"), JSON.stringify({ phase }));
	expect(await discardPreparedUpdate(f.prepared)).toBe("removed");
	expect(existsSync(f.directory)).toBe(false); expect(existsSync(f.target)).toBe(true);
});
test.each(["replacing", "starting", "complete", "rolled-back", "recovery-required", "unknown"])("transaction ownership survives GUI disposal (%s)", async phase => {
	const f = fixture(); writeFileSync(join(f.directory, "status.json"), JSON.stringify({ phase }));
	expect(await discardPreparedUpdate(f.prepared)).toBe("retained"); expect(existsSync(f.directory)).toBe(true);
});
test("any active or unknown lock and any previous-app copy preserve staging", async () => {
	const f = fixture(); await acquireUpdateLock(f.directory, f.job);
	expect(await discardPreparedUpdate(f.prepared)).toBe("retained");
	writeFileSync(f.target + ".update-lock", "unknown", { mode: 0o600 });
	expect(await discardPreparedUpdate(f.prepared)).toBe("retained");
	rmSync(f.target + ".update-lock"); mkdirSync(join(f.directory, "Previous.app"));
	expect(await discardPreparedUpdate(f.prepared)).toBe("retained");
});
test("helper killed -> controller returns ready -> normal quit/dispose -> restart recovers the known dead lock", async () => {
	const f = fixture();
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
	const io: DesktopUpdateIO = {
		check: async () => ({ manifest: { version: f.job.version, tag: "v" + f.job.version, assets: [] }, asset: { name: "fixture.dmg", url: "https://github.com/boomytc/AmazMe/releases/download/v8.6.0/fixture.dmg", sha256: "a".repeat(64) } }),
		download: async () => "/fixture/download", verify: async () => f.prepared,
		discard: async (_file, prepared) => { if (prepared) await discardPreparedUpdate(prepared); },
		install: async () => {
			await acquireUpdateLock(f.directory, f.job);
			writeFileSync(f.target + ".update-lock", JSON.stringify({ ...readUpdateLock(f.target), pid: child.pid }));
			const exit = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exit;
			throw new Error("install");
		},
	};
	const controller = createUpdateController(f.job.current, io, () => {});
	await controller.check(); await controller.download(); await controller.install();
	expect(controller.state()).toMatchObject({ phase: "ready", error: "install" });
	await controller.dispose();
	expect(existsSync(f.directory)).toBe(true); expect(updateLockState(f.target)).toBe("stale");
	expect(await recoverStaleUpdateLock(f.target, f.job.current, f.job.arch, async () => ({ team: f.job.team, hash: f.job.originalHash }))).toBe("recovered");
	expect(mayStartInstalledApp(f.target, f.job.current, [])).toBe(true);
	// Even a future accidental deletion cannot destroy the durable lock's recovery metadata.
	await acquireUpdateLock(f.directory, f.job);
	writeFileSync(f.target + ".update-lock", JSON.stringify({ ...readUpdateLock(f.target), pid: child.pid }));
	rmSync(f.directory, { recursive: true, force: true });
	expect(updateLockState(f.target)).toBe("stale");
	expect(await recoverStaleUpdateLock(f.target, f.job.current, f.job.arch, async () => ({ team: f.job.team, hash: f.job.originalHash }))).toBe("recovered");
	expect(existsSync(f.target)).toBe(true);
});
