import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { desktopUpdateAsset, fetchDesktopManifest, githubReleaseResponse, type UpdateAsset, type UpdateManifest } from "@amazme/coding-agent/update-manifest";
import type { DesktopUpdateIO, PreparedUpdate } from "./update-controller.ts";
import { handoffUpdate } from "./update-handoff.ts";
import { discardPreparedUpdate } from "./update-cleanup.ts";
import { macOSBundleVersion } from "./macos-version.ts";
import { pythonUpdateStatePath, readPythonBuildId } from "./python-backend.ts";

const exec = promisify(execFile);
export type MacTool = (command: string, args: readonly string[]) => Promise<string>;
export const macTool: MacTool = async (command, args) => {
	try { const result = await exec(command, [...args], { timeout: 120_000, maxBuffer: 1_048_576, encoding: "utf8" }); return result.stdout + result.stderr; }
	catch { throw new Error("signature"); }
};
export interface AppIdentity { readonly team: string; readonly hash: string }
export interface InstallJob {
	readonly target: string;
	readonly current: string;
	readonly version: string;
	readonly team: string;
	readonly arch: string;
	readonly originalHash: string;
	readonly parentPid: number;
	readonly nonce: string;
}

/** Independent Apple trust and the already installed publisher pin; no manifest-provided team id. */
export async function verifyApp(path: string, version: string, arch: string, expectedTeam?: string, tool: MacTool = macTool): Promise<AppIdentity> {
	await tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
	const detail = await tool("/usr/bin/codesign", ["--display", "--verbose=4", path]);
	const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(detail)?.[1];
	const hash = /^CDHash=([a-f0-9]{40,64})$/m.exec(detail)?.[1];
	if (!team || !hash || (expectedTeam !== undefined && team !== expectedTeam)) throw new Error("signature");
	await tool("/usr/bin/codesign", ["--verify", "--strict", "-R", `anchor apple generic and identifier "com.amazme.desktop" and certificate leaf[subject.OU] = "${team}"`, path]);
	await tool("/usr/sbin/spctl", ["--assess", "--type", "execute", path]);
	const plist = join(path, "Contents", "Info.plist");
	for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
		if ((await tool("/usr/bin/plutil", ["-extract", key, "raw", plist])).trim() !== macOSBundleVersion(version)) throw new Error("signature");
	}
	// This file is covered by the verified bundle seal and is Electron's app.getVersion source.
	if ((await tool("/usr/bin/plutil", ["-extract", "version", "raw", join(path, "Contents", "Resources", "app", "package.json")])).trim() !== version) throw new Error("signature");
	if ((await tool("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist])).trim() !== "com.amazme.desktop") throw new Error("signature");
	const architectures = (await tool("/usr/bin/lipo", ["-archs", join(path, "Contents", "MacOS", "AmazMe")])).trim().split(/\s+/);
	if (!architectures.includes(arch === "x64" ? "x86_64" : arch)) throw new Error("unsupported");
	return { team, hash };
}

export async function downloadRelease(asset: UpdateAsset, file: string, signal: AbortSignal, progress: (received: number, total: number) => void, get: typeof fetch = fetch): Promise<void> {
	if (asset.size === undefined) throw new Error("manifest");
	const response = await githubReleaseResponse(asset.url, AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]), get);
	const length = response.headers.get("content-length");
	if (!response.body || (length !== null && Number(length) !== asset.size)) { await response.body?.cancel(); throw new Error("integrity"); }
	const handle = await open(file, "wx", 0o600);
	const hash = createHash("sha256");
	let received = 0;
	let lastProgress = 0;
	try {
		for await (const chunk of response.body) {
			signal.throwIfAborted();
			received += chunk.byteLength;
			if (received > asset.size) throw new Error("integrity");
			hash.update(chunk);
			await handle.writeFile(chunk);
			if (Date.now() - lastProgress > 100 || received === asset.size) { lastProgress = Date.now(); progress(received, asset.size); }
		}
		if (received !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("integrity");
		await handle.sync();
	} finally { await handle.close(); }
	if (await fileDigest(file) !== asset.sha256) throw new Error("integrity");
}

export async function fileDigest(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function writableTarget(target: string): Promise<void> {
	if (!target.endsWith(".app") || target.includes("/AppTranslocation/") || target.startsWith("/Volumes/")) throw new Error("permission");
	try {
		if (await realpath(target) !== target || !(await lstat(target)).isDirectory()) throw new Error("permission");
		await access(dirname(target), constants.W_OK | constants.X_OK);
	} catch { throw new Error("permission"); }
}

export function createMacUpdateIO(options: {
	readonly target: string;
	readonly current: string;
	readonly arch: string;
	readonly cache: string;
	readonly userData?: string;
	readonly confirmQuit: () => Promise<boolean>;
	readonly prepareHost?: () => Promise<boolean>;
	readonly resumeHost?: () => Promise<void>;
	readonly quit: () => Promise<void>;
}): DesktopUpdateIO {
	let pinned: AppIdentity | undefined;
	return {
		async check(channel, signal) {
			if (process.platform !== "darwin") throw new Error("unsupported");
			pinned = await verifyApp(options.target, options.current, options.arch);
			const manifest = await fetchDesktopManifest(channel, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
			const asset = desktopUpdateAsset(manifest, options.current, channel, process.platform, options.arch);
			return asset ? { manifest, asset } : undefined;
		},
		async download(asset, signal, progress) {
			await mkdir(options.cache, { recursive: true, mode: 0o700 });
			const directory = await mkdtemp(join(options.cache, "download-"));
			const file = join(directory, "update.dmg");
			try { await downloadRelease(asset, file, signal, progress); return file; }
			catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
		},
		async verify(file, manifest: UpdateManifest, signal) {
			if (!pinned) throw new Error("signature");
			await writableTarget(options.target);
			const original = await verifyApp(options.target, options.current, options.arch, pinned.team);
			if (original.hash !== pinned.hash) throw new Error("busy");
			await macTool("/usr/bin/codesign", ["--verify", "--strict", "-R", `anchor apple generic and certificate leaf[subject.OU] = "${pinned.team}"`, file]);
			await macTool("/usr/bin/xcrun", ["stapler", "validate", file]);
			await macTool("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", file]);
			const mount = await mkdtemp(join(options.cache, "mount-"));
			const directory = await mkdtemp(join(dirname(options.target), ".AmazMe-update-"));
			let mounted = false;
			let done = false;
			try {
				signal.throwIfAborted();
				await macTool("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, file]); mounted = true;
				const candidate = join(mount, "AmazMe.app");
				await verifyApp(candidate, manifest.version, options.arch, pinned.team);
				signal.throwIfAborted();
				await macTool("/usr/bin/ditto", [candidate, join(directory, "AmazMe.app")]);
				await verifyApp(join(directory, "AmazMe.app"), manifest.version, options.arch, pinned.team);
				const job: InstallJob = { target: options.target, current: options.current, version: manifest.version, team: pinned.team,
					arch: options.arch, originalHash: pinned.hash, parentPid: process.pid, nonce: randomUUID() };
				await writeFile(join(directory, "job.json"), JSON.stringify(job), { mode: 0o600, flag: "wx" });
				done = true;
				return { directory };
			} finally {
				if (mounted) await macTool("/usr/bin/hdiutil", ["detach", mount]);
				await rm(mount, { recursive: true, force: true });
				if (!done) await rm(directory, { recursive: true, force: true });
			}
		},
		async discard(file, prepared) {
			if (file) await rm(dirname(file), { recursive: true, force: true });
			if (prepared) await discardPreparedUpdate(prepared);
		},
		async install(prepared: PreparedUpdate) {
			await writableTarget(options.target);
			const targetBuild = readPythonBuildId(prepared.directory);
			if (options.userData !== undefined && targetBuild !== undefined) {
				const path = pythonUpdateStatePath(options.userData);
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				await writeFile(path, JSON.stringify({ target_build: targetBuild }), { mode: 0o600 });
			}
			// The helper is loaded completely before the old bundle is moved. No system Node is required.
			const node = join(options.target, "Contents", "Resources", "node", "bin", "node");
			const helperEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME };
			if (options.userData) helperEnv.AMAZME_GUI_USER_DATA_DIR = options.userData;
			for (const key of ["AMAZME_CODING_AGENT_DIR", "AMAZME_SERVER_DIR", "AMAZME_GUI_CWD", "AMAZME_AGENTS_HOME", "AMAZME_GUI_SMOKE_DATA_DIR"]) {
				if (process.env[key]) helperEnv[key] = process.env[key];
			}
			await handoffUpdate({
				confirm: options.confirmQuit,
				quit: async () => {
					if (options.prepareHost !== undefined && !await options.prepareHost()) throw new Error("busy");
					await options.quit();
				},
				resume: async () => { await options.resumeHost?.(); },
				start() {
					const child = spawn(node, [fileURLToPath(new URL("./update-helper.bundle.mjs", import.meta.url)), prepared.directory], {
						detached: true, stdio: ["pipe", "pipe", "ignore"], env: helperEnv,
					});
					child.stdin.on("error", () => {});
					child.unref();
					return {
						onData(listener) { const accept = (chunk: Buffer): void => listener(chunk.toString("utf8")); child.stdout.on("data", accept); return () => { child.stdout.off("data", accept); }; },
						onDeath(listener) { child.on("error", listener); child.on("exit", listener); return () => { child.off("error", listener); child.off("exit", listener); }; },
						isAlive: () => child.pid !== undefined && child.exitCode === null && child.signalCode === null,
						sendInstall: () => new Promise<void>((resolve, reject) => { child.stdin.write("install\n", error => { if (error) reject(new Error("install")); else resolve(); }); }),
						cancel: () => { child.stdin.end("cancel\n"); },
					};
				},
			});
		},
	};
}
