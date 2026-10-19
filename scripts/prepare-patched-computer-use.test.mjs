import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	patchedDriverPin,
	readPatchedInstallation,
} from "../packages/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs";

test("patched runtime reuse verifies source, patch, architecture and every identity/executable file", async () => {
	const output = await mkdtemp(join(tmpdir(), "amcu-patch-test-"));
	try {
		const pin = await patchedDriverPin();
		const app = join(output, "AmazMe Computer Use.app/Contents");
		await mkdir(join(app, "MacOS"), { recursive: true });
		const files = {
			binary: join(app, "MacOS/cua-driver"),
			host: join(app, "MacOS/amazme-computer-use"),
			plist: join(app, "Info.plist"),
		};
		const manifest = { ...pin, platform: "darwin", arch: "arm64" };
		for (const [key, path] of Object.entries(files)) {
			await writeFile(path, key);
			manifest[`${key}Sha256`] = createHash("sha256").update(key).digest("hex");
		}
		const manifestPath = join(output, "manifest.json");
		const save = (value) => writeFile(manifestPath, JSON.stringify(value));
		await save(manifest);
		assert.deepEqual(await readPatchedInstallation(output, pin, "arm64"), {
			directory: output,
			binary: files.binary,
		});
		for (const key of [
			"version",
			"sourceCommit",
			"patchSha256",
			"platform",
			"arch",
		]) {
			await save({ ...manifest, [key]: "different" });
			await assert.rejects(
				readPatchedInstallation(output, pin, "arm64"),
				/differs from its pinned manifest/,
			);
		}
		await save(manifest);
		for (const path of Object.values(files)) {
			const bytes = await readFile(path);
			await writeFile(path, "changed");
			await assert.rejects(
				readPatchedInstallation(output, pin, "arm64"),
				/differs from its pinned manifest/,
			);
			await writeFile(path, bytes);
		}
		await rm(manifestPath);
		await assert.rejects(readPatchedInstallation(output, pin, "arm64"), {
			code: "ENOENT",
		});
		assert.equal(
			await readPatchedInstallation(join(output, "absent"), pin, "arm64"),
			undefined,
		);
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});
