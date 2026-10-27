import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DRIVER_PIN,
	PATCH_PIN,
	patchBuild,
} from "../tools/native/computer-use/src/runtime-pin.ts";
import { markReleaseDirectory } from "../tools/native/computer-use/src/maintenance.ts";

export function computerUseReleaseRoot() {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	return join(root, "dist-release", "computer-use");
}

export function computerUseBuildRoot(patchedVersion = PATCH_PIN.version) {
	const version =
		process.platform === "darwin"
			? patchBuild(patchedVersion).pin.version
			: DRIVER_PIN.version;
	return join(computerUseReleaseRoot(), version);
}

export async function prepareComputerUseBuildRoot(version = PATCH_PIN.version) {
	const root = computerUseBuildRoot(version);
	await markReleaseDirectory(
		root,
		process.platform === "darwin" ? version : DRIVER_PIN.version,
	);
	return root;
}
