import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildCacheRoot,
	cleanupBuildWorkspaces,
	cleanupPermissionPanels,
	cleanupRuntimeVersions,
} from "../src/maintenance.ts";
import { permissionPanelKey } from "../src/permission-panel.ts";

export async function cleanupComputerUse({
	apply = false,
	workRoots = [],
	releaseRoot,
} = {}) {
	if (process.platform !== "darwin")
		throw new Error("Computer-use cleanup currently supports macOS");
	const panels = await cleanupPermissionPanels(
		join(homedir(), "Library/Caches/AmazMe/ComputerUse/permissions"),
		permissionPanelKey(),
		apply,
	);
	const builds = [];
	for (const root of new Set([
		buildCacheRoot(),
		...workRoots.map((root) => resolve(root)),
	]))
		builds.push(...(await cleanupBuildWorkspaces(root, apply)));
	const versions = await cleanupRuntimeVersions({ releaseRoot, apply });
	return { apply, panels, builds, ...versions };
}

export function cleanupArguments(args) {
	if (args.length > 1 || (args.length === 1 && args[0] !== "--apply"))
		throw new Error("Usage: cleanup-computer-use.mjs [--apply]");
	return { apply: args[0] === "--apply" };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	console.log(
		JSON.stringify(
			await cleanupComputerUse(cleanupArguments(process.argv.slice(2))),
			null,
			2,
		),
	);
