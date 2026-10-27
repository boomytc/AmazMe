import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareMacBundle } from "../tools/native/computer-use/scripts/macos-bundle.mjs";
import {
	installationHashes,
	installationRoot,
	MAC_FILES,
} from "../tools/native/computer-use/src/installation.ts";
import {
	PATCH_BUILDS,
	PATCH_PIN,
} from "../tools/native/computer-use/src/runtime-pin.ts";

export async function signedRuntime(home, pin = PATCH_PIN) {
	const directory = join(installationRoot("darwin", home), pin.version);
	const binary = join(directory, MAC_FILES.binary);
	await mkdir(dirname(binary), { recursive: true });
	execFileSync("/usr/bin/clang", ["-x", "c", "-", "-o", binary], {
		input: "int main(void) { return 0; }",
	});
	const build = PATCH_BUILDS.find((build) => build.pin.version === pin.version);
	await prepareMacBundle(directory, {
		version: pin.version,
		build: build?.bundleBuild ?? PATCH_BUILDS[0].bundleBuild,
		upstreamVersion: build?.upstreamVersion ?? PATCH_BUILDS[0].upstreamVersion,
		signingIdentity: "-",
	});
	const manifest = {
		...pin,
		platform: "darwin",
		arch: process.arch,
		...(await installationHashes(directory, "darwin")),
	};
	await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
	return { directory, binary, manifest };
}
