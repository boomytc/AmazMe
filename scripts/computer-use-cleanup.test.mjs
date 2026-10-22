import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cleanupArguments } from "../packages/coding-agent/plugins/computer-use/scripts/cleanup-computer-use.mjs";
import { sha256 } from "../packages/coding-agent/plugins/computer-use/src/installation.ts";
import {
	cleanupBuildWorkspaces,
	cleanupPermissionPanels,
	createBuildWorkspace,
} from "../packages/coding-agent/plugins/computer-use/src/maintenance.ts";
import {
	DRIVER_PIN,
	PATCH_PIN,
} from "../packages/coding-agent/plugins/computer-use/src/runtime-pin.ts";
import { computerUseBuildRoot } from "./computer-use-paths.mjs";

test(
	"cache cleanup previews, preserves current/busy/unknown/symlink entries and deletes only unused owned panels",
	{ skip: process.platform !== "darwin" },
	async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "amcu-cache-test-")),
		);
		const old = "a".repeat(64),
			current = "b".repeat(64);
		let handle;
		try {
			for (const name of [old, current]) {
				const binary = join(
					root,
					name,
					"AmazMe Permissions.app/Contents/MacOS/amazme-permissions",
				);
				await mkdir(dirname(binary), { recursive: true });
				await writeFile(binary, "fixture");
				await writeFile(
					join(root, name, "manifest.json"),
					JSON.stringify({ source: name, binary: sha256("fixture") }),
				);
			}
			await mkdir(join(root, "unknown"));
			await symlink(join(root, current), join(root, "c".repeat(64)));
			handle = await open(join(root, old, "manifest.json"));
			let result = await cleanupPermissionPanels(root, current, true);
			assert.equal(
				result.find((item) => item.path === join(root, old)).status,
				"busy",
			);
			await handle.close();
			handle = undefined;
			result = await cleanupPermissionPanels(root, current);
			assert.equal(
				result.find((item) => item.path === join(root, old)).status,
				"candidate",
			);
			assert.ok(await stat(join(root, old)));
			result = await cleanupPermissionPanels(root, current, true);
			assert.equal(
				result.find((item) => item.path === join(root, old)).status,
				"removed",
			);
			assert.equal(
				result.find((item) => item.path === join(root, current)).status,
				"current",
			);
			assert.equal(
				result.find((item) => item.path === join(root, "unknown")).status,
				"unrecognized",
			);
			assert.ok(await stat(join(root, "c".repeat(64))));
			await assert.rejects(stat(join(root, old)), { code: "ENOENT" });
		} finally {
			await handle?.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"build cleanup preserves a live owner and unrecognized files, reclaims a crashed build, and is repeatable",
	{ skip: process.platform !== "darwin" },
	async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "amcu-build-cleanup-")),
		);
		try {
			const live = await createBuildWorkspace(root, "fixture");
			const stale = await createBuildWorkspace(root, "fixture");
			const owner = JSON.parse(
				await readFile(join(stale, "owner.json"), "utf8"),
			);
			owner.pid = spawnSync(process.execPath, ["-e", ""]).pid;
			await writeFile(join(stale, "owner.json"), JSON.stringify(owner));
			await mkdir(join(root, ".build-unknown"));
			const result = await cleanupBuildWorkspaces(root, true);
			assert.equal(result.find((item) => item.path === live).status, "busy");
			assert.equal(
				result.find((item) => item.path === stale).status,
				"removed",
			);
			assert.equal(
				result.find((item) => item.path.endsWith("unknown")).status,
				"unrecognized",
			);
			assert.equal(
				(await cleanupBuildWorkspaces(root, true)).some(
					(item) => item.status === "removed",
				),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("maintenance requires explicit apply and builds belong to the independent runtime release directory", async () => {
	assert.deepEqual(cleanupArguments([]), { apply: false });
	assert.deepEqual(cleanupArguments(["--apply"]), { apply: true });
	assert.throws(() => cleanupArguments(["--force"]), /Usage/);
	const version =
		process.platform === "darwin" ? PATCH_PIN.version : DRIVER_PIN.version;
	assert.ok(
		computerUseBuildRoot().endsWith(`/dist-release/computer-use/${version}`),
	);
});
