import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DRIVER_PIN, PATCH_BUILDS, PATCH_PIN } from "./runtime-pin.ts";

const execute = promisify(execFile);
export const APP_NAME = "AmazMe Computer Use.app";
export const MAC_FILES = {
	binary: `${APP_NAME}/Contents/MacOS/cua-driver`,
	host: `${APP_NAME}/Contents/MacOS/amazme-computer-use`,
	plist: `${APP_NAME}/Contents/Info.plist`,
};
export const sha256 = (bytes: string | Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

export function installationRoot(
	platform = process.platform,
	home = homedir(),
): string {
	return join(
		home,
		platform === "darwin"
			? "Library/Application Support/AmazMe/ComputerUse"
			: ".local/share/AmazMe/ComputerUse",
	);
}

export function binaryPath(platform: string): string {
	return platform === "darwin"
		? MAC_FILES.binary
		: platform === "win32"
			? "cua-driver.exe"
			: "cua-driver";
}

export async function installationHashes(
	output: string,
	platform: string,
): Promise<Record<string, string>> {
	const files =
		platform === "darwin" ? MAC_FILES : { binary: binaryPath(platform) };
	return Object.fromEntries(
		await Promise.all(
			Object.entries(files).map(async ([key, path]) => [
				`${key}Sha256`,
				sha256(await readFile(join(output, path))),
			]),
		),
	);
}

export function archivePin(platform: string, arch: string) {
	if (arch !== "arm64" && arch !== "x64")
		throw new Error(`Unsupported architecture: ${arch}`);
	const key = platform === "darwin" ? "darwin" : `${platform}-${arch}`;
	const asset = Object.entries(DRIVER_PIN.assets).find(
		([name]) => name === key,
	)?.[1];
	if (!asset) throw new Error(`Unsupported platform: ${platform}`);
	return {
		version: DRIVER_PIN.version,
		platform,
		arch,
		archiveSha256: asset.sha256,
	};
}

/** Both installation and discovery reject an incomplete or changed managed directory. */
export async function readInstallation(
	output: string,
	expected: { version: string; platform: string; arch: string } & Record<
		string,
		string
	>,
): Promise<{ directory: string; binary: string } | undefined> {
	const entry = await lstat(output).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return;
		throw error;
	});
	if (!entry) return;
	if (!entry.isDirectory() || entry.isSymbolicLink())
		throw new Error(`Invalid managed runtime directory: ${output}`);
	const manifest: unknown = JSON.parse(
		await readFile(join(output, "manifest.json"), "utf8"),
	);
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		Array.isArray(manifest)
	)
		throw new Error(`Invalid runtime manifest: ${output}`);
	const values = new Map(Object.entries(manifest));
	const hashes = await installationHashes(output, expected.platform);
	if (
		Object.entries({ ...expected, ...hashes }).some(
			([key, value]) => values.get(key) !== value,
		)
	)
		throw new Error(
			`Installed component differs from its pinned manifest: ${output}`,
		);
	const binary = join(output, binaryPath(expected.platform));
	await access(
		binary,
		expected.platform === "win32" ? constants.F_OK : constants.X_OK,
	);
	if (expected.platform === "darwin") {
		await execute(
			"/usr/bin/codesign",
			["--verify", "--deep", "--strict", join(output, APP_NAME)],
			{ timeout: 10_000 },
		);
		const build = PATCH_BUILDS.find(
			(build) => build.pin.version === expected.version,
		);
		for (const [key, value] of Object.entries({
			AmazMeRuntimeVersion: expected.version,
			...(build
				? {
						CFBundleShortVersionString: build.upstreamVersion,
						CFBundleVersion: build.bundleBuild,
					}
				: {}),
			CFBundleIdentifier: "com.amazme.computer-use",
			CFBundleExecutable: "amazme-computer-use",
		})) {
			const { stdout } = await execute(
				"/usr/bin/plutil",
				["-extract", key, "raw", "-o", "-", join(output, MAC_FILES.plist)],
				{ timeout: 2000 },
			);
			if (stdout.trim() !== value)
				throw new Error(
					`Runtime bundle ${key} differs from its pin: ${output}`,
				);
		}
	}
	return { directory: output, binary };
}

export async function resolveManagedInstallation({
	platform = process.platform,
	arch = process.arch,
	home = homedir(),
}: {
	platform?: NodeJS.Platform;
	arch?: string;
	home?: string;
} = {}) {
	const root = installationRoot(platform, home);
	const archive = archivePin(platform, arch);
	const pins =
		platform === "darwin" ? [{ ...PATCH_PIN, platform, arch }] : [archive];
	for (const pin of pins) {
		const installed = await readInstallation(join(root, pin.version), pin);
		if (installed) return installed;
	}
}
