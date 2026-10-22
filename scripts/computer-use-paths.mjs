import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DRIVER_PIN,
	PATCH_PIN,
} from "../packages/coding-agent/plugins/computer-use/src/runtime-pin.ts";

export function computerUseBuildRoot() {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const version =
		process.platform === "darwin" ? PATCH_PIN.version : DRIVER_PIN.version;
	return join(root, "dist-release", "computer-use", version);
}
