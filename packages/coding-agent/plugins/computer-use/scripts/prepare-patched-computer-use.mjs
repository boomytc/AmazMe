import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { driverPin, prepareComputerUse } from "./prepare-computer-use.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const patch = join(directory, "patches/cua-driver-0.34.1-appkit.patch");
const appName = "AmazMe Computer Use.app";
const files = {
	binary: `${appName}/Contents/MacOS/cua-driver`,
	host: `${appName}/Contents/MacOS/amazme-computer-use`,
	plist: `${appName}/Contents/Info.plist`,
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function patchedDriverPin() {
	const base = await driverPin();
	if (base.version !== "0.34.1" || base.tag !== "cua-driver-rs-v0.34.1")
		throw new Error("The AppKit patch requires the 0.34.1 base pin");
	return {
		version: "0.34.1-amazme.1",
		sourceCommit: "0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc",
		patchSha256: sha256(await readFile(patch)),
	};
}

async function hashes(output) {
	return Object.fromEntries(
		await Promise.all(
			Object.entries(files).map(async ([key, path]) => [
				`${key}Sha256`,
				sha256(await readFile(join(output, path))),
			]),
		),
	);
}

// Reuse must check provenance as well as all executable/identity bytes. A missing
// manifest in an existing directory is an incomplete install, never permission to overwrite it.
export async function readPatchedInstallation(output, pin, arch) {
	const exists = await lstat(output).catch((error) => {
		if (error.code === "ENOENT") return;
		throw error;
	});
	if (!exists) return;
	const manifest = JSON.parse(
		await readFile(join(output, "manifest.json"), "utf8"),
	);
	const expected = {
		...pin,
		platform: "darwin",
		arch,
		...(await hashes(output)),
	};
	if (Object.entries(expected).some(([key, value]) => manifest[key] !== value))
		throw new Error(
			"Patched component differs from its pinned manifest; select another destination",
		);
	return { directory: output, binary: join(output, files.binary) };
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

export async function preparePatchedComputerUse({ source, destination } = {}) {
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
		throw new Error("The AppKit driver patch requires macOS arm64 or x64");
	const pin = await patchedDriverPin();
	const output = resolve(
		destination ??
			join(
				homedir(),
				"Library/Application Support/AmazMe/ComputerUse",
				pin.version,
			),
	);
	const installed = await readPatchedInstallation(output, pin, process.arch);
	if (installed) {
		await run("/usr/bin/codesign", [
			"--verify",
			"--deep",
			"--strict",
			join(output, appName),
		]);
		return installed;
	}
	if (!source)
		throw new Error(
			"Provide --source /path/to/cua containing the pinned upstream commit",
		);
	const base = await prepareComputerUse();
	await run("/usr/bin/codesign", [
		"--verify",
		"--deep",
		"--strict",
		join(base.directory, appName),
	]);
	await mkdir(dirname(output), { recursive: true });
	const staging = await mkdtemp(join(dirname(output), ".patch-"));
	let build;
	try {
		build = await mkdtemp(join(tmpdir(), "amcu-source-"));
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
		const ready = join(staging, "ready");
		await cp(base.directory, ready, { recursive: true });
		await cp(
			join(build, "target/release/cua-driver"),
			join(ready, files.binary),
		);
		const identity = process.env.AMAZME_CUA_SIGNING_IDENTITY ?? "-";
		for (const path of [join(ready, files.binary), join(ready, appName)])
			await run("/usr/bin/codesign", [
				"--force",
				"--sign",
				identity,
				"--options",
				"runtime",
				path,
			]);
		await run("/usr/bin/codesign", [
			"--verify",
			"--deep",
			"--strict",
			join(ready, appName),
		]);
		if (sha256(await readFile(patch)) !== pin.patchSha256)
			throw new Error("Patch changed during compilation; rerun preparation");
		await writeFile(
			join(ready, "manifest.json"),
			`${JSON.stringify(
				{
					...pin,
					platform: "darwin",
					arch: process.arch,
					...(await hashes(ready)),
				},
				null,
				2,
			)}\n`,
		);
		await rename(ready, output);
		return { directory: output, binary: join(output, files.binary) };
	} finally {
		await Promise.all([
			rm(staging, { recursive: true, force: true }),
			build ? rm(build, { recursive: true, force: true }) : undefined,
		]);
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
