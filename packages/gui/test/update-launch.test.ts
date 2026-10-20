import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { mayStartInstalledApp } from "../src/update-launch.ts";
import { createTempDir } from "./temp-dir.ts";

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
	writeFileSync(join(job, "job.json"), JSON.stringify({ target, nonce, current: "8.5.0", version: "8.6.0" }));
	writeFileSync(lock, JSON.stringify({ target, nonce, directory: job, version: "8.6.0", pid: process.pid, phase: "launching" }));
	expect(mayStartInstalledApp(target, "8.5.0", [])).toBe(false);
	expect(mayStartInstalledApp(target, "8.6.0", ["--amazme-update-job", job, nonce])).toBe(true);
	expect(mayStartInstalledApp(target, "8.5.0", ["--amazme-update-job", job, nonce])).toBe(false);
});
