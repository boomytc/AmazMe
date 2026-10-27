import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
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
import { promisify } from "node:util";
import { cleanupArguments } from "../tools/native/computer-use/scripts/cleanup-computer-use.mjs";
import {
	installationRoot,
	sha256,
} from "../tools/native/computer-use/src/installation.ts";
import {
	cleanupBuildWorkspaces,
	cleanupPermissionPanels,
	cleanupRuntimeVersions,
	createBuildWorkspace,
	markReleaseDirectory,
} from "../tools/native/computer-use/src/maintenance.ts";
import {
	DRIVER_PIN,
	PATCH_PIN,
} from "../tools/native/computer-use/src/runtime-pin.ts";
import { computerUseBuildRoot } from "./computer-use-paths.mjs";
import { signedRuntime } from "./computer-use-test-fixture.mjs";

const execute = promisify(execFile);
const oldVersion = "0.38.0-amazme.1";

test(
	"version pruning requires a verified default and preserves busy, newer and unowned directories",
	{ skip: process.platform !== "darwin" },
	async () => {
		const home = await realpath(
			await mkdtemp(join(tmpdir(), "amcu-versions-")),
		);
		let handle;
		try {
			const root = installationRoot("darwin", home),
				releaseRoot = join(home, "releases");
			const old = await signedRuntime(home, {
				...PATCH_PIN,
				version: oldVersion,
			});
			await markReleaseDirectory(join(releaseRoot, oldVersion), oldVersion);
			assert.deepEqual(
				await cleanupRuntimeVersions({ root, releaseRoot, apply: true }),
				{ runtimes: [], releases: [] },
			);
			assert.ok(await stat(old.directory));
			const current = await signedRuntime(home);
			await markReleaseDirectory(
				join(releaseRoot, PATCH_PIN.version),
				PATCH_PIN.version,
			);
			const newer = "0.38.0-amazme.10",
				unknown = "0.37.0",
				linked = "0.36.0";
			for (const parent of [root, releaseRoot]) {
				await mkdir(join(parent, newer));
				await mkdir(join(parent, unknown));
				await symlink(current.directory, join(parent, linked));
			}
			const liveBuild = await createBuildWorkspace(
				join(releaseRoot, oldVersion),
				oldVersion,
			);
			handle = await open(join(old.directory, "manifest.json"));
			let result = await cleanupRuntimeVersions({
				root,
				releaseRoot,
				apply: true,
			});
			assert.equal(
				result.runtimes.find((r) => r.path === old.directory).status,
				"busy",
			);
			assert.equal(
				result.releases.find((r) => r.path.endsWith(oldVersion)).status,
				"busy",
			);
			await handle.close();
			handle = undefined;
			await rm(liveBuild, { recursive: true });
			result = await cleanupRuntimeVersions({ root, releaseRoot });
			assert.equal(
				result.runtimes.find((r) => r.path === old.directory).status,
				"candidate",
			);
			assert.ok(await stat(old.directory));
			const bytes = await readFile(current.binary);
			await writeFile(current.binary, "corrupt");
			await assert.rejects(
				cleanupRuntimeVersions({ root, releaseRoot, apply: true }),
				/differs from its pinned manifest/,
			);
			assert.ok(await stat(old.directory));
			assert.ok(await stat(join(releaseRoot, oldVersion)));
			await writeFile(current.binary, bytes);
			result = await cleanupRuntimeVersions({ root, releaseRoot, apply: true });
			for (const entries of [result.runtimes, result.releases]) {
				assert.equal(
					entries.find((r) => r.path.endsWith(oldVersion)).status,
					"removed",
				);
				assert.equal(
					entries.find((r) => r.path.endsWith(newer)).status,
					"newer",
				);
				assert.equal(
					entries.find((r) => r.path.endsWith(unknown)).status,
					"unrecognized",
				);
			}
			assert.ok(await stat(join(root, linked)));
			assert.ok(await stat(join(releaseRoot, linked)));
			const repeated = await cleanupRuntimeVersions({
				root,
				releaseRoot,
				apply: true,
			});
			assert.equal(
				[...repeated.runtimes, ...repeated.releases].some(
					(r) => r.status === "removed",
				),
				false,
			);
		} finally {
			await handle?.close();
			await rm(home, { recursive: true, force: true });
		}
	},
);

test(
	"failed preparation keeps history; offline success automatically prunes it and retries busy versions",
	{ skip: process.platform !== "darwin" },
	async () => {
		const home = await realpath(
			await mkdtemp(join(tmpdir(), "amcu-auto-cleanup-")),
		);
		let handle;
		try {
			const old = await signedRuntime(home, {
				...PATCH_PIN,
				version: oldVersion,
			});
			const releaseRoot = join(home, "releases"),
				workRoot = join(releaseRoot, PATCH_PIN.version);
			await markReleaseDirectory(join(releaseRoot, oldVersion), oldVersion);
			await markReleaseDirectory(workRoot, PATCH_PIN.version);
			const module = new URL(
				"../tools/native/computer-use/scripts/prepare-patched-computer-use.mjs",
				import.meta.url,
			).href;
			const run = (extra = {}) =>
				execute(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`const {preparePatchedComputerUse} = await import(process.argv[1]); console.log(JSON.stringify(await preparePatchedComputerUse(JSON.parse(process.argv[2]))));`,
						module,
						JSON.stringify({ workRoot, releaseRoot, ...extra }),
					],
					{ env: { ...process.env, HOME: home }, timeout: 60_000 },
				);
			await assert.rejects(
				run({ source: join(home, "missing-source") }),
				/git failed/,
			);
			assert.ok(await stat(old.directory));
			assert.ok(await stat(join(releaseRoot, oldVersion)));
			await signedRuntime(home);
			handle = await open(join(old.directory, "manifest.json"));
			let result = JSON.parse((await run()).stdout);
			assert.equal(
				result.cleanup.runtimes.find((r) => r.path === old.directory).status,
				"busy",
			);
			await handle.close();
			handle = undefined;
			result = JSON.parse((await run()).stdout);
			assert.equal(
				result.cleanup.runtimes.find((r) => r.path === old.directory).status,
				"removed",
			);
			await assert.rejects(stat(old.directory), { code: "ENOENT" });
			await assert.rejects(stat(join(releaseRoot, oldVersion)), {
				code: "ENOENT",
			});
		} finally {
			await handle?.close();
			await rm(home, { recursive: true, force: true });
		}
	},
);

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
