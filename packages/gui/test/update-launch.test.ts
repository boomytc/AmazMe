import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { mayStartInstalledApp, shouldStartDesktopUpdates } from "../src/update-launch.ts";
import { createTempDir } from "./temp-dir.ts";

test("desktop updates start only for packaged releases at or above 1.0.0", () => {
	expect(shouldStartDesktopUpdates(false, "1.0.0")).toBe(false);
	expect(shouldStartDesktopUpdates(true, "0.9.0")).toBe(false);
	expect(shouldStartDesktopUpdates(true, "1.0.0-rc.1")).toBe(false);
	expect(shouldStartDesktopUpdates(true, "1.0.0")).toBe(true);
	expect(shouldStartDesktopUpdates(true, "1.1.0")).toBe(true);
});

test("a lock held during signature verification blocks ordinary startup; only the live installer's exact job may launch", () => {
	const directory = realpathSync(createTempDir("amazme-update-launch-"));
	const target = join(directory, "AmazMe.app"); mkdirSync(target);
	expect(mayStartInstalledApp(target, "8.5.0", [])).toBe(true);
	const lock = target + ".update-lock"; writeFileSync(lock, "{}", { mode: 0o600 });
	// The helper has acquired its mutex but is paused inside verification, before authorizing any launch.
	expect(mayStartInstalledApp(target, "8.5.0", [])).toBe(false);
	expect(mayStartInstalledApp(target, "8.5.0", ["--amazme-update-job", "/wrong", "nonce"])).toBe(false);
	const job = join(directory, ".AmazMe-update-fixture"); mkdirSync(job, { mode: 0o700 });
	const nonce = "e".repeat(36);
	const snapshot = { target, nonce, current: "8.5.0", version: "8.6.0", team: "ABCDE12345", arch: "arm64", originalHash: "a".repeat(40), parentPid: process.pid };
	writeFileSync(join(job, "job.json"), JSON.stringify(snapshot));
	writeFileSync(lock, JSON.stringify({ format: 1, target, nonce, directory: job, version: "8.6.0", pid: process.pid, phase: "launching", job: snapshot }));
	expect(mayStartInstalledApp(target, "8.5.0", [])).toBe(false);
	expect(mayStartInstalledApp(target, "8.6.0", ["--amazme-update-job", job, nonce])).toBe(true);
	expect(mayStartInstalledApp(target, "8.5.0", ["--amazme-update-job", job, nonce])).toBe(false);
});
