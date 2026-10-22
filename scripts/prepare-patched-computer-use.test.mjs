import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	patchedDriverPin,
	readPatchedInstallation,
} from "../packages/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs";
import { signedRuntime } from "./computer-use-test-fixture.mjs";

test(
	"patched runtime reuse verifies source, patch, architecture and every identity/executable file",
	{ skip: process.platform !== "darwin" },
	async () => {
		const home = await mkdtemp(join(tmpdir(), "amcu-patch-test-"));
		try {
			const pin = await patchedDriverPin();
			const { directory: output, manifest } = await signedRuntime(home, pin);
			const app = join(output, "AmazMe Computer Use.app/Contents");
			const files = {
				binary: join(app, "MacOS/cua-driver"),
				host: join(app, "MacOS/amazme-computer-use"),
				plist: join(app, "Info.plist"),
			};
			const manifestPath = join(output, "manifest.json");
			const save = (value) => writeFile(manifestPath, JSON.stringify(value));
			await save(manifest);
			assert.deepEqual(
				await readPatchedInstallation(output, pin, process.arch),
				{
					directory: output,
					binary: files.binary,
				},
			);
			for (const key of [
				"version",
				"sourceCommit",
				"patchSha256",
				"platform",
				"arch",
			]) {
				await save({ ...manifest, [key]: "different" });
				await assert.rejects(
					readPatchedInstallation(output, pin, process.arch),
					/differs from its pinned manifest/,
				);
			}
			await save(manifest);
			for (const path of Object.values(files)) {
				const bytes = await readFile(path);
				await writeFile(path, "changed");
				await assert.rejects(
					readPatchedInstallation(output, pin, process.arch),
					/differs from its pinned manifest/,
				);
				await writeFile(path, bytes);
			}
			await rm(manifestPath);
			await assert.rejects(readPatchedInstallation(output, pin, process.arch), {
				code: "ENOENT",
			});
			assert.equal(
				await readPatchedInstallation(
					join(output, "absent"),
					pin,
					process.arch,
				),
				undefined,
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);
