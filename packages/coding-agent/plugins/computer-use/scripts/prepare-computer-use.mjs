import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	archivePin,
	binaryPath,
	installationHashes,
	installationRoot,
	readInstallation,
} from "../src/installation.ts";
import { preparePermissionPanel } from "../src/permission-panel.ts";
import { DRIVER_PIN } from "../src/runtime-pin.ts";
import { prepareMacBundle } from "./macos-bundle.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
export async function driverPin() {
	return DRIVER_PIN;
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
	const expected = archivePin(platform, arch);
	const asset = Object.values(pin.assets).find(
		(asset) => asset.sha256 === expected.archiveSha256,
	);
	const output = destination ?? join(installationRoot(platform), pin.version);
	const executable = binaryPath(platform);
	const existing = await readInstallation(output, expected);
	if (existing) {
		if (platform === "darwin") await preparePermissionPanel(signingIdentity);
		return existing;
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
		if (platform === "darwin")
			await prepareMacBundle(ready, { signingIdentity });
		await writeFile(
			join(ready, "manifest.json"),
			JSON.stringify(
				{
					version: pin.version,
					platform,
					arch,
					executable,
					archiveSha256: asset.sha256,
					...(await installationHashes(ready, platform)),
				},
				null,
				2,
			),
		);
		// Never replace a user's installed component or a service that may still be running.
		if (platform === "darwin") await preparePermissionPanel(signingIdentity);
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
