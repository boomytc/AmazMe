import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveDriverBinary } from "../packages/coding-agent/plugins/computer-use/src/driver.ts";
import {
	APP_NAME,
	archivePin,
	binaryPath,
	installationHashes,
	installationRoot,
	MAC_FILES,
	readInstallation,
} from "../packages/coding-agent/plugins/computer-use/src/installation.ts";
import {
	BUNDLE_BUILD,
	DRIVER_PIN,
	LEGACY_PATCH_PIN,
	PATCH_PIN,
} from "../packages/coding-agent/plugins/computer-use/src/runtime-pin.ts";
import { signedRuntime } from "./computer-use-test-fixture.mjs";

test(
	"discovery pins supported versions, validates the preferred install and never silently falls back from corruption",
	{ skip: process.platform !== "darwin" },
	async () => {
		const home = await mkdtemp(join(tmpdir(), "amcu-discovery-"));
		try {
			const legacy = await signedRuntime(home, LEGACY_PATCH_PIN);
			const options = { home, platform: "darwin", env: {} };
			assert.equal(await resolveDriverBinary(options), legacy.binary);
			const current = await signedRuntime(home);
			for (const name of ["0.9.0", "0.34.1-amazme.99", "development", "zzz"])
				await cp(
					current.directory,
					join(installationRoot("darwin", home), name),
					{ recursive: true },
				);
			assert.equal(await resolveDriverBinary(options), current.binary);
			await writeFile(current.binary, "broken");
			await assert.rejects(
				resolveDriverBinary(options),
				/differs from its pinned manifest/,
			);
			assert.equal(
				await resolveDriverBinary({
					...options,
					env: { AMAZME_CUA_DRIVER_PATH: legacy.binary },
				}),
				legacy.binary,
			);
			await rm(current.directory, { recursive: true });
			await symlink(legacy.directory, current.directory);
			await assert.rejects(
				resolveDriverBinary(options),
				/Invalid managed runtime directory/,
			);
			await rm(current.directory);
			await mkdir(current.directory);
			await assert.rejects(resolveDriverBinary(options), { code: "ENOENT" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);

test(
	"signed bundle exposes the full runtime revision and rejects stale identity even with updated manifest hashes",
	{ skip: process.platform !== "darwin" },
	async () => {
		const home = await mkdtemp(join(tmpdir(), "amcu-identity-"));
		try {
			const { directory, manifest } = await signedRuntime(home);
			const plist = join(directory, MAC_FILES.plist);
			const original = await readFile(plist, "utf8");
			for (const value of [PATCH_PIN.version, DRIVER_PIN.version, BUNDLE_BUILD])
				assert.ok(original.includes(`<string>${value}</string>`));
			await writeFile(
				plist,
				original.replace(
					`<key>AmazMeRuntimeVersion</key><string>${PATCH_PIN.version}</string>`,
					`<key>AmazMeRuntimeVersion</key><string>${LEGACY_PATCH_PIN.version}</string>`,
				),
			);
			execFileSync("/usr/bin/codesign", [
				"--force",
				"--sign",
				"-",
				join(directory, APP_NAME),
			]);
			await writeFile(
				join(directory, "manifest.json"),
				JSON.stringify({
					...manifest,
					...(await installationHashes(directory, "darwin")),
				}),
			);
			await assert.rejects(
				readInstallation(directory, {
					...PATCH_PIN,
					platform: "darwin",
					arch: process.arch,
				}),
				/AmazMeRuntimeVersion differs/,
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);

test("non-mac discovery uses the same pinned shared installation and rejects non-executable drivers", async () => {
	const home = await mkdtemp(join(tmpdir(), "amcu-linux-discovery-"));
	try {
		const expected = archivePin("linux", "x64");
		const directory = join(installationRoot("linux", home), expected.version);
		const binary = join(directory, binaryPath("linux"));
		await mkdir(dirname(binary), { recursive: true });
		await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(
			join(directory, "manifest.json"),
			JSON.stringify({
				...expected,
				...(await installationHashes(directory, "linux")),
			}),
		);
		assert.equal(
			await resolveDriverBinary({
				home,
				platform: "linux",
				arch: "x64",
				env: {},
			}),
			binary,
		);
		await chmod(binary, 0o644);
		if (process.platform !== "win32")
			await assert.rejects(
				resolveDriverBinary({ home, platform: "linux", arch: "x64", env: {} }),
				{ code: "EACCES" },
			);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
