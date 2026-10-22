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
import {
	BUNDLE_BUILD,
	LEGACY_PATCH_PIN,
	PATCH_PIN,
} from "../src/runtime-pin.ts";
import { prepareMacBundle } from "./macos-bundle.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const patch = join(directory, "patches/cua-driver-0.34.1-appkit.patch");
const appName = APP_NAME;
const files = MAC_FILES;

export async function patchedDriverPin() {
	if (sha256(await readFile(patch)) !== PATCH_PIN.patchSha256)
		throw new Error("Patch differs from its pin");
	return PATCH_PIN;
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
} = {}) {
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
		throw new Error("The AppKit driver patch requires macOS arm64 or x64");
	const pin = await patchedDriverPin();
	const output = resolve(destination ?? join(installationRoot(), pin.version));
	const installed = await readPatchedInstallation(output, pin, process.arch);
	if (installed) {
		await preparePermissionPanel();
		return installed;
	}
	const legacy = await readPatchedInstallation(
		join(installationRoot(), LEGACY_PATCH_PIN.version),
		LEGACY_PATCH_PIN,
		process.arch,
	);
	if (!legacy && !source)
		throw new Error(
			"Provide --source /path/to/cua containing the pinned upstream commit",
		);
	await mkdir(dirname(output), { recursive: true });
	const staging = await mkdtemp(join(dirname(output), ".patch-"));
	let build;
	try {
		const ready = join(staging, "ready");
		await mkdir(join(ready, appName, "Contents/MacOS"), { recursive: true });
		if (legacy) {
			await cp(legacy.binary, join(ready, files.binary));
		} else {
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
		}
		await cp(
			join(directory, "LICENSE.cua-driver.txt"),
			join(ready, "LICENSE.cua-driver.txt"),
		);
		await prepareMacBundle(ready, {
			version: pin.version,
			build: BUNDLE_BUILD,
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
		return { directory: output, binary: join(output, files.binary) };
	} finally {
		await rm(staging, { recursive: true, force: true });
		if (build && !(await directoryInUse(build)))
			await rm(build, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source"))
		throw new Error(
			"Usage: prepare-patched-computer-use.mjs [--source /path/to/cua]",
		);
	console.log(
		JSON.stringify(
			await preparePatchedComputerUse({ source: args[1] }),
			null,
			2,
		),
	);
}
