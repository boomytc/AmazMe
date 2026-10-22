import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	driverPin,
	prepareComputerUse,
	verifyArchive,
} from "../packages/coding-agent/plugins/computer-use/scripts/prepare-computer-use.mjs";

import {
	patchedDriverPin,
	preparationArguments,
} from "../packages/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs";
import {
	PATCH_BUILDS,
	PATCH_PIN,
} from "../packages/coding-agent/plugins/computer-use/src/runtime-pin.ts";

test("candidate preparation validates the exact recipe without changing the default", async () => {
	for (const { pin } of PATCH_BUILDS)
		assert.deepEqual(await patchedDriverPin(pin.version), pin);
	assert.deepEqual(
		preparationArguments([
			"--version",
			"0.38.0-amazme.2",
			"--source",
			"/source",
		]),
		{ version: "0.38.0-amazme.2", source: "/source" },
	);
	for (const args of [
		["--version", "unknown"],
		["--version", "0.38.0-amazme.1"],
		["--version", "0.34.1-amazme.2"],
		["--version"],
		["--source", "/one", "--source", "/two"],
		["--unknown", "value"],
	])
		assert.throws(() => preparationArguments(args));
	assert.deepEqual(await patchedDriverPin(), PATCH_PIN);
});

test("computer-use preparation pins every supported asset and verifies bytes before unpacking", async () => {
	const pin = await driverPin();
	assert.equal(pin.tag, `cua-driver-rs-v${pin.version}`);
	assert.deepEqual(Object.keys(pin.assets), [
		"darwin",
		"linux-x64",
		"linux-arm64",
		"win32-x64",
		"win32-arm64",
	]);
	for (const asset of Object.values(pin.assets))
		assert.match(asset.sha256, /^[a-f0-9]{64}$/);
	const bytes = Buffer.from("fixture archive");
	const asset = {
		name: "fixture",
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	verifyArchive(bytes, asset);
	assert.throws(
		() => verifyArchive(Buffer.from("corrupt"), asset),
		/Checksum mismatch/,
	);
	await assert.rejects(
		prepareComputerUse({ platform: "unknown" }),
		/Unsupported platform/,
	);
	await assert.rejects(
		prepareComputerUse({ arch: "unknown" }),
		/Unsupported architecture/,
	);
});

test("preparation reuses a verified installation offline and refuses changed binaries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "amcu-prepare-"));
	try {
		const pin = await driverPin(),
			bytes = Buffer.from("pinned native fixture");
		await writeFile(join(directory, "cua-driver"), bytes);
		await chmod(join(directory, "cua-driver"), 0o755);
		await writeFile(
			join(directory, "manifest.json"),
			JSON.stringify({
				version: pin.version,
				platform: "linux",
				arch: "x64",
				archiveSha256: pin.assets["linux-x64"].sha256,
				binarySha256: createHash("sha256").update(bytes).digest("hex"),
			}),
		);
		assert.deepEqual(
			await prepareComputerUse({
				platform: "linux",
				arch: "x64",
				destination: directory,
			}),
			{ directory, binary: join(directory, "cua-driver") },
		);
		await writeFile(join(directory, "cua-driver"), "modified");
		await assert.rejects(
			prepareComputerUse({
				platform: "linux",
				arch: "x64",
				destination: directory,
			}),
			/differs from its pinned manifest/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
