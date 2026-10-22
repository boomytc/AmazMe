import { spawn } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	APP_NAME,
	installationHashes,
	installationRoot,
	MAC_FILES,
	readInstallation,
	sha256,
} from "../src/installation.ts";
import {
	buildCacheRoot,
	createBuildWorkspace,
	directoryInUse,
} from "../src/maintenance.ts";
import { preparePermissionPanel } from "../src/permission-panel.ts";
import { PATCH_PIN, patchBuild } from "../src/runtime-pin.ts";
import { prepareMacBundle } from "./macos-bundle.mjs";
import { cleanupComputerUse } from "./cleanup-computer-use.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const patchPath = (build) => join(directory, "patches", build.patchFile);
const appName = APP_NAME;
const files = MAC_FILES;

export async function patchedDriverPin(version = PATCH_PIN.version) {
	const build = patchBuild(version);
	if (sha256(await readFile(patchPath(build))) !== build.pin.patchSha256)
		throw new Error("Patch differs from its pin");
	return build.pin;
}

export async function readPatchedInstallation(output, pin, arch) {
	return readInstallation(output, { ...pin, platform: "darwin", arch });
}

function run(command, args, cwd, env = process.env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else reject(new Error(`${command} failed (${signal ?? code})`));
		});
	});
}

export async function preparePatchedComputerUse({
	source,
	destination,
	workRoot = buildCacheRoot(),
	version = PATCH_PIN.version,
	releaseRoot,
} = {}) {
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
		throw new Error("The AppKit driver patch requires macOS arm64 or x64");
	const buildRecipe = patchBuild(version);
	const pin = await patchedDriverPin(version);
	const patch = patchPath(buildRecipe);
	const output = resolve(destination ?? join(installationRoot(), pin.version));
	const finish = async (installed) => {
		if (
			pin.version !== PATCH_PIN.version ||
			output !== join(installationRoot(), PATCH_PIN.version)
		)
			return installed;
		return {
			...installed,
			cleanup: await cleanupComputerUse({
				apply: true,
				workRoots: [workRoot],
				releaseRoot,
			}),
		};
	};
	const installed = await readPatchedInstallation(output, pin, process.arch);
	if (installed) {
		await preparePermissionPanel();
		return finish(installed);
	}
	if (!source)
		throw new Error(
			"Provide --source /path/to/cua containing the pinned upstream commit",
		);
	await mkdir(dirname(output), { recursive: true });
	const staging = await mkdtemp(join(dirname(output), ".patch-"));
	let build;
	try {
		const ready = join(staging, "ready");
		await mkdir(join(ready, appName, "Contents/MacOS"), { recursive: true });
		build = await createBuildWorkspace(resolve(workRoot), pin.version);
		const archive = join(build, "source.tar");
		// Export Git objects at the immutable commit, never the caller's working tree.
		await run("git", [
			"-C",
			resolve(source),
			"archive",
			"--format=tar",
			`--output=${archive}`,
			pin.sourceCommit,
			"libs/cua-driver",
			"libs/cua",
			"libs/images/sandbox-images.json",
		]);
		await run("tar", ["-xf", archive, "-C", build]);
		await run("git", ["apply", "--check", patch], build);
		await run("git", ["apply", patch], build);
		const rust = join(build, "libs/cua-driver/rust");
		if (
			(await readFile(join(rust, "VERSION"), "utf8")).trim() !==
			buildRecipe.upstreamVersion
		)
			throw new Error("Source commit does not match the upstream version");
		await run(
			"cargo",
			[
				"test",
				"--locked",
				"--release",
				"-p",
				"platform-macos",
				"--lib",
				"input::mouse::tests",
				"--config",
				"profile.release.build-override.debug=2",
				"--config",
				'profile.release.build-override.strip="none"',
			],
			rust,
			{ ...process.env, CARGO_TARGET_DIR: join(build, "target") },
		);
		// A private target directory prevents a caller's cache from substituting an
		// unrelated executable. The locked dependency graph and upstream toolchain apply.
		// Keep compile-time proc macros loadable on macOS linkers affected by
		// rust-lang/rust#157750. The final driver still uses release optimization.
		await run(
			"cargo",
			[
				"build",
				"--locked",
				"--release",
				"-p",
				"cua-driver",
				"--config",
				"profile.release.build-override.debug=2",
				"--config",
				'profile.release.build-override.strip="none"',
			],
			rust,
			{
				...process.env,
				CARGO_TARGET_DIR: join(build, "target"),
			},
		);
		await cp(
			join(build, "target/release/cua-driver"),
			join(ready, files.binary),
		);
		await cp(
			join(directory, "LICENSE.cua-driver.txt"),
			join(ready, "LICENSE.cua-driver.txt"),
		);
		await prepareMacBundle(ready, {
			version: pin.version,
			build: buildRecipe.bundleBuild,
			upstreamVersion: buildRecipe.upstreamVersion,
		});
		if (sha256(await readFile(patch)) !== pin.patchSha256)
			throw new Error("Patch changed during compilation; rerun preparation");
		await writeFile(
			join(ready, "manifest.json"),
			`${JSON.stringify(
				{
					...pin,
					platform: "darwin",
					arch: process.arch,
					...(await installationHashes(ready, "darwin")),
				},
				null,
				2,
			)}\n`,
		);
		await readPatchedInstallation(ready, pin, process.arch);
		await preparePermissionPanel();
		await rename(ready, output);
	} finally {
		await rm(staging, { recursive: true, force: true });
		if (build && !(await directoryInUse(build)))
			await rm(build, { recursive: true, force: true });
	}
	return finish({ directory: output, binary: join(output, files.binary) });
}

export function preparationArguments(args) {
	const result = {};
	for (let i = 0; i < args.length; i += 2) {
		const key =
			args[i] === "--source"
				? "source"
				: args[i] === "--version"
					? "version"
					: undefined;
		if (!key || !args[i + 1] || result[key])
			throw new Error(
				"Usage: prepare-computer-use.mjs [--source /path/to/cua] [--version <supported-runtime>]",
			);
		result[key] = args[i + 1];
	}
	if (result.version) patchBuild(result.version);
	return result;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	console.log(
		JSON.stringify(
			await preparePatchedComputerUse(
				preparationArguments(process.argv.slice(2)),
			),
			null,
			2,
		),
	);
