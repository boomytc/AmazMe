#!/usr/bin/env node
/**
 * Assemble a movable macOS preview app.
 *
 * The window runtime is @amazme/gui and @amazme/web. The Python backend is added with
 * --python-backend. This package does not include @amazme/coding-agent. A pinned Node binary
 * remains for the update helper. Nothing points at the checkout.
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createPackageArtifacts,
	installPackageArtifacts,
} from "./package-artifacts.mjs";
import { resolveSigning, signApp, signDiskImage, writeChecksum } from "./macos-signing.mjs";
import { macOSBundleVersion } from "../packages/gui/dist/macos-version.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const MANIFEST_NAME = "release-manifest.json";
/** Runtime packages inside the desktop app. The old coding-agent host is not one of them. */
export const DESKTOP_PACKAGES = ["@amazme/gui"];

function argument(name) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function run(command, args, options = {}) {
	return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}

function guard(condition, message) {
	if (!condition) throw new Error(message);
}

function versionAtLeast(version, minimum) {
	const parse = (value) => value.replace(/^v/, "").split(".").map(Number);
	const [major = 0, minor = 0] = parse(version);
	const [needMajor = 0, needMinor = 0] = parse(minimum);
	return major > needMajor || (major === needMajor && minor >= needMinor);
}

/** A Node binary must not point at a Homebrew or user prefix: the app has to survive being moved. */
function assertSelfContainedNode(nodeExecutable) {
	const linked = run("otool", ["-L", nodeExecutable])
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(" (")[0] ?? "")
		.filter((path) => path.length > 0 && !path.startsWith("/System/") && !path.startsWith("/usr/lib/"));
	guard(linked.length === 0, `Node ${nodeExecutable} depends on non-system libraries; pass --node with an official tarball:\n${linked.join("\n")}`);
}

async function releaseManifest(electronVersion, packages, nodeExecutable) {
	const node = run(nodeExecutable, ["--version"]).trim();
	guard(versionAtLeast(node, "22.19"), `Bundled Node must be 22.19 or newer, got ${node}`);
	const app = JSON.parse(await readFile(join(repoRoot, "packages/gui/package.json"), "utf8"));
	return {
		format: 1,
		app: {
			name: "AmazMe",
			version: app.version,
			identifier: "com.amazme.desktop",
			bundleVersion: macOSBundleVersion(app.version),
		},
		electron: electronVersion,
		node,
		arch: process.arch,
		builtAt: new Date().toISOString(),
		packages,
	};
}

async function stageHost(appDirectory) {
	const runtime = join(appDirectory, "Contents", "Resources", "app");
	const artifactsDirectory = join(appDirectory, "..", "artifacts");
	const selected = DESKTOP_PACKAGES;
	const lock = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
	mkdirSync(runtime, { recursive: true });
	const packed = createPackageArtifacts({ repoRoot, directory: artifactsDirectory, packageNames: selected });
	installPackageArtifacts({ artifacts: packed, directory: runtime, packageNames: selected, dependencyLock: lock });
	guard((await readdir(runtime)).includes("node_modules"), "Desktop runtime was not installed");
	const gui = join(runtime, "node_modules", "@amazme", "gui", "dist", "main.js");
	await writeFile(gui, await readFile(gui));
	guard(!existsSync(join(runtime, "node_modules", "@amazme", "coding-agent")), "Desktop package must not include @amazme/coding-agent");
	return runtime;
}

async function finalizeBundle(appDirectory, manifest, nodeExecutable) {
	const contents = join(appDirectory, "Contents");
	const resources = join(contents, "Resources");
	await rm(join(resources, "default_app.asar"), { force: true });
	await rm(join(resources, "app", "package-lock.json"), { force: true });
	// Notarization unpacks the cached tarballs and rejects the unsigned binaries inside them.
	await rm(join(resources, "app", ".npm-cache"), { recursive: true, force: true });
	await mkdir(join(resources, "node", "bin"), { recursive: true });
	await cp(nodeExecutable, join(resources, "node", "bin", "node"), { mode: constants.COPYFILE_FICLONE });
	await chmod(join(resources, "node", "bin", "node"), 0o755);
	await cp(join(repoRoot, "packages/gui/assets/app-icon.icns"), join(resources, "app-icon.icns"));
	await writeFile(
		join(resources, "app", "package.json"),
		`${JSON.stringify({ name: "AmazMe", version: manifest.app.version, private: true, type: "module", main: "main.mjs" }, null, "\t")}\n`,
	);
	await writeFile(
		join(resources, "app", "main.mjs"),
		[
			'import { homedir } from "node:os";',
			'import { join } from "node:path";',
			"// The update helper uses the bundled Node. The window does not start a Node business host.",
			"process.env.INIT_CWD ??= homedir();",
			'await import("./node_modules/@amazme/gui/dist/main.js");',
			"",
		].join("\n"),
	);
	await writeFile(join(resources, MANIFEST_NAME), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function smokeBundle(appDirectory) {
	const scratch = await mkdtemp(join(tmpdir(), "amazme-standalone-"));
	const moved = join(scratch, "AmazMe.app");
	await cp(appDirectory, moved, { recursive: true, verbatimSymlinks: true });
	const data = join(scratch, "data");
	const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
	Object.assign(env, {
		AMAZME_GUI_SMOKE: "1",
		AMAZME_GUI_SMOKE_DATA_DIR: data,
		AMAZME_GUI_CWD: data,
		AMAZME_SERVER_DIR: join(scratch, "server"),
		AMAZME_CODING_AGENT_DIR: join(scratch, "agent"),
		AMAZME_GUI_READY_TIMEOUT_MS: "120000",
	});
	const child = spawn(join(moved, "Contents", "MacOS", "AmazMe"), ["--no-sandbox"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const expectsPython = existsSync(join(moved, "Contents", "Resources", "amazme-backend", "amazme-backend"));
	const report = await new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`Packaged app did not report within 180s:\n${output}`)), 180_000);
		child.stdout.on("data", (chunk) => { output += String(chunk); });
		child.stderr.on("data", (chunk) => { output += String(chunk); });
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (!expectsPython) {
				if (output.includes("桌面需要包内的 Python 后端")) resolvePromise("refused without python backend");
				else reject(new Error(`Packaged app without Python backend did not refuse (${code}):\n${output}`));
				return;
			}
			const line = output.split("\n").find((entry) => entry.startsWith("desktop smoke: "));
			if (code !== 0 || line === undefined) reject(new Error(`Packaged app failed (${code}):\n${output}`));
			else resolvePromise(line);
		});
	});
	await rm(scratch, { recursive: true, force: true });
	return report;
}

async function createDmg(appDirectory, out, manifest, signing) {
	const staging = await mkdtemp(join(tmpdir(), "amazme-dmg-"));
	const image = join(out, `AmazMe-${manifest.app.version}-macos-${manifest.arch}.dmg`);
	try {
		await cp(appDirectory, join(staging, "AmazMe.app"), { recursive: true, verbatimSymlinks: true });
		await symlink("/Applications", join(staging, "Applications"));
		run("hdiutil", ["create", "-volname", "AmazMe", "-srcfolder", staging, "-ov", "-format", "UDZO", image]);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	signDiskImage(image, signing);
	const digest = await writeChecksum(image);
	const mounted = await mkdtemp(join(tmpdir(), "amazme-mount-"));
	try {
		run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mounted, image]);
		const inside = JSON.parse(await readFile(join(mounted, "AmazMe.app", "Contents", "Resources", MANIFEST_NAME), "utf8"));
		guard(inside.app.version === manifest.app.version, "Mounted app version does not match its release manifest");
		guard(existsSync(join(mounted, "Applications")), "DMG is missing the Applications shortcut");
	} finally {
		try {
			run("hdiutil", ["detach", mounted, "-force"]);
		} finally {
			await rm(mounted, { recursive: true, force: true });
		}
	}
	return { image, digest };
}

async function main() {
	if (process.platform !== "darwin") throw new Error("The standalone preview currently targets macOS only");
	const out = resolve(argument("--out") ?? join(repoRoot, "dist-desktop"));
	const verify = process.argv.includes("--verify");
	const withDmg = process.argv.includes("--dmg");
	const signing = resolveSigning({
		keychain: argument("--keychain"),
		teamId: argument("--team-id"),
		entitlements: join(repoRoot, "packages/gui/assets/entitlements.mac.plist"),
	});
	const nodeArgument = argument("--node");
	const nodeExecutable = resolve(nodeArgument ?? process.execPath);
	assertSelfContainedNode(nodeExecutable);
	guard(!resolve(out).startsWith(repoRoot + "/packages/"), "Output must stay outside package sources");
	await rm(out, { recursive: true, force: true });
	await mkdir(out, { recursive: true });

	const electron = require("electron");
	guard(typeof electron === "string" && electron.length > 0, "Electron executable is unavailable");
	const electronVersion = JSON.parse(await readFile(join(repoRoot, "node_modules", "electron", "package.json"), "utf8")).version;
	const sourceApp = dirname(dirname(dirname(electron)));
	const appDirectory = join(out, "AmazMe.app");
	await cp(sourceApp, appDirectory, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });

	const contents = join(appDirectory, "Contents");
	const plist = join(contents, "Info.plist");
	for (const [key, value] of Object.entries({
		CFBundleName: "AmazMe",
		CFBundleDisplayName: "AmazMe",
		CFBundleIdentifier: "com.amazme.desktop",
		CFBundleExecutable: "AmazMe",
		CFBundleIconFile: "app-icon.icns",
		CFBundleShortVersionString: macOSBundleVersion(JSON.parse(await readFile(join(repoRoot, "packages/gui/package.json"), "utf8")).version),
		CFBundleVersion: macOSBundleVersion(JSON.parse(await readFile(join(repoRoot, "packages/gui/package.json"), "utf8")).version),
	})) {
		run("/usr/bin/plutil", ["-replace", key, "-string", String(value), plist]);
	}
	await rename(join(contents, "MacOS", basename(electron)), join(contents, "MacOS", "AmazMe"));
	const staged = await stageHost(appDirectory);
	const manifest = await releaseManifest(electronVersion, Object.fromEntries(
		(await readdir(join(staged, "node_modules", "@amazme"))).map((name) => {
			const pkg = JSON.parse(readFileSync(join(staged, "node_modules", "@amazme", name, "package.json"), "utf8"));
			return [pkg.name, pkg.version];
		}),
	), nodeExecutable);
	await finalizeBundle(appDirectory, manifest, nodeExecutable);
	const pythonBackend = argument("--python-backend");
	if (pythonBackend !== undefined) {
		const source = resolve(pythonBackend);
		guard(existsSync(join(source, "amazme-backend")), "Python backend bundle is missing amazme-backend");
		await cp(source, join(contents, "Resources", "amazme-backend"), {
			recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
		});
	}
	await signApp(appDirectory, signing, async () => {
		const bundle = join(appDirectory, "Contents", "Resources", "amazme-backend");
		if (!existsSync(join(bundle, "build.json"))) return;
		const python = join(repoRoot, "backend/.venv/bin/python");
		execFileSync(python, ["-c", "import sys; from pathlib import Path; from amazme_backend.platform.identity import rewrite_frozen_manifest; print(rewrite_frozen_manifest(Path(sys.argv[1])))", bundle], {
			cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"],
		});
	});
	console.log(`Built ${appDirectory}`);
	console.log(`Version ${manifest.app.version} · Node ${manifest.node} · Electron ${manifest.electron}`);
	console.log(signing.kind === "ad-hoc" ? "Signed ad-hoc (no hardened runtime)" : `Signed with Developer ID, team ${signing.teamId}`);
	if (verify) console.log(`Standalone smoke: ${await smokeBundle(appDirectory)}`);
	if (withDmg) {
		const { image, digest } = await createDmg(appDirectory, out, manifest, signing);
		console.log(`DMG ${image}`);
		console.log(`SHA256 ${digest}`);
	}
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
