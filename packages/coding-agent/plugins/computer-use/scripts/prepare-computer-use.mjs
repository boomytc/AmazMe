import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
export async function driverPin() {
	return JSON.parse(await readFile(join(directory, "cua-driver.json"), "utf8"));
}
export function verifyArchive(bytes, asset) {
	if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
		throw new Error(`Checksum mismatch: ${asset.name}`);
}
function run(command, args) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		timeout: 120_000,
	});
	if (result.error || result.status !== 0)
		throw result.error ?? new Error(`${command} failed`);
}
async function findBinary(root, name) {
	for (const item of await readdir(root, { withFileTypes: true })) {
		if (item.isFile() && item.name === name) return join(root, item.name);
		if (item.isDirectory()) {
			const found = await findBinary(join(root, item.name), name);
			if (found) return found;
		}
	}
}

export async function prepareComputerUse({
	platform = process.platform,
	arch = process.arch,
	destination,
	signingIdentity = process.env.AMAZME_CUA_SIGNING_IDENTITY ?? "-",
} = {}) {
	const pin = await driverPin();
	if (!["arm64", "x64"].includes(arch))
		throw new Error(`Unsupported architecture: ${arch}`);
	const asset =
		pin.assets[platform === "darwin" ? "darwin" : `${platform}-${arch}`];
	if (!asset) throw new Error(`Unsupported platform: ${platform}`);
	const output =
		destination ??
		(platform === "darwin"
			? join(
					homedir(),
					"Library/Application Support/AmazMe/ComputerUse",
					pin.version,
				)
			: join(homedir(), ".local/share/AmazMe/ComputerUse", pin.version));
	const executable =
		platform === "darwin"
			? "AmazMe Computer Use.app/Contents/MacOS/cua-driver"
			: platform === "win32"
				? "cua-driver.exe"
				: "cua-driver";
	const existing = await readFile(join(output, "manifest.json"), "utf8").catch(
		(error) => {
			if (error.code === "ENOENT") return;
			throw error;
		},
	);
	if (existing !== undefined) {
		const manifest = JSON.parse(existing);
		const hash = createHash("sha256")
			.update(await readFile(join(output, executable)))
			.digest("hex");
		if (
			manifest.version !== pin.version ||
			manifest.platform !== platform ||
			manifest.arch !== arch ||
			manifest.archiveSha256 !== asset.sha256 ||
			manifest.binarySha256 !== hash
		)
			throw new Error(
				"Installed component differs from its pinned manifest; select another destination",
			);
		return { directory: output, binary: join(output, executable) };
	}
	await mkdir(dirname(output), { recursive: true });
	const staging = await mkdtemp(join(dirname(output), ".prepare-"));
	try {
		const response = await fetch(
			`https://github.com/${pin.repository}/releases/download/${pin.tag}/${asset.name}`,
			{ signal: AbortSignal.timeout(120_000) },
		);
		if (!response.ok)
			throw new Error(`Driver download failed: HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		verifyArchive(bytes, asset);
		const archive = join(staging, asset.name),
			extracted = join(staging, "unpacked"),
			ready = join(staging, "ready");
		await writeFile(archive, bytes);
		await mkdir(extracted);
		if (platform === "win32") run("tar", ["-xf", archive, "-C", extracted]);
		else run("tar", ["-xzf", archive, "-C", extracted]);
		const name = platform === "win32" ? "cua-driver.exe" : "cua-driver";
		const binary = await findBinary(extracted, name);
		if (!binary)
			throw new Error("Pinned archive contains no cua-driver executable");
		const installed = join(ready, executable);
		await mkdir(dirname(installed), { recursive: true });
		await copyFile(binary, installed);
		if (platform !== "win32") await chmod(installed, 0o755);
		await copyFile(
			join(directory, "LICENSE.cua-driver.txt"),
			join(ready, "LICENSE.cua-driver.txt"),
		);
		if (platform === "darwin") {
			const app = join(ready, "AmazMe Computer Use.app");
			await writeFile(
				join(app, "Contents/Info.plist"),
				`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>amazme-computer-use</string>
<key>CFBundleIdentifier</key><string>com.amazme.computer-use</string>
<key>CFBundleName</key><string>AmazMe Computer Use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${pin.version}</string>
<key>CFBundleVersion</key><string>${pin.version}</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSScreenCaptureUsageDescription</key><string>Capture windows for computer tasks requested by the user.</string>
<key>NSAppleEventsUsageDescription</key><string>Control apps for computer tasks requested by the user.</string>
</dict></plist>\n`,
			);
			run("/usr/bin/xcrun", [
				"clang",
				"-fobjc-arc",
				"-mmacosx-version-min=13.0",
				"-arch",
				"arm64",
				"-arch",
				"x86_64",
				join(directory, "macos-host.m"),
				"-framework",
				"Cocoa",
				"-framework",
				"ApplicationServices",
				"-o",
				join(app, "Contents/MacOS/amazme-computer-use"),
			]);
			run("/usr/bin/codesign", [
				"--force",
				"--sign",
				signingIdentity,
				"--options",
				"runtime",
				installed,
			]);
			run("/usr/bin/codesign", [
				"--force",
				"--sign",
				signingIdentity,
				"--options",
				"runtime",
				app,
			]);
		}
		await writeFile(
			join(ready, "manifest.json"),
			JSON.stringify(
				{
					version: pin.version,
					platform,
					arch,
					executable,
					archiveSha256: asset.sha256,
					binarySha256: createHash("sha256")
						.update(await readFile(installed))
						.digest("hex"),
				},
				null,
				2,
			),
		);
		// Never replace a user's installed component or a service that may still be running.
		await rename(ready, output);
		return { directory: output, binary: join(output, executable) };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	console.log(JSON.stringify(await prepareComputerUse(), null, 2));
