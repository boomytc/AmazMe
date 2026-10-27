import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, MAC_FILES } from "../src/installation.ts";
import { DRIVER_PIN } from "../src/runtime-pin.ts";

const directory = dirname(fileURLToPath(import.meta.url));
function run(command, args) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		timeout: 120_000,
	});
	if (result.error || result.status !== 0)
		throw result.error ?? new Error(`${command} failed`);
}
export async function prepareMacBundle(
	ready,
	{
		version = DRIVER_PIN.version,
		upstreamVersion = DRIVER_PIN.version,
		build = DRIVER_PIN.version,
		signingIdentity = process.env.AMAZME_CUA_SIGNING_IDENTITY ?? "-",
	} = {},
) {
	const installed = join(ready, MAC_FILES.binary);

	const app = join(ready, APP_NAME);
	await writeFile(
		join(app, "Contents/Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>amazme-computer-use</string>
<key>CFBundleIdentifier</key><string>com.amazme.computer-use</string>
<key>CFBundleName</key><string>AmazMe Computer Use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${upstreamVersion}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>AmazMeRuntimeVersion</key><string>${version}</string>
<key>CFBundleGetInfoString</key><string>AmazMe Computer Use ${version}</string>
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
