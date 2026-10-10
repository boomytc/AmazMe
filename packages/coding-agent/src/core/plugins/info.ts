import { join } from "node:path";
import { getPackageDir } from "../../config.ts";

export function resolveAgentPluginExternal(specifier: string): string | undefined {
	const entry = specifier === "@amazme/coding-agent/plugin" ? "plugin"
		: specifier === "@amazme/coding-agent/host/plugin" ? "host/plugin" : undefined;
	if (entry === undefined) return undefined;
	const source = import.meta.url.endsWith(".ts");
	return join(getPackageDir(), source ? "src" : "dist", `${entry}.${source ? "ts" : "js"}`);
}

/** Source paths and the installed contract are discoverable without inventing another plugin catalogue. */
export function describePluginSources(sources: readonly string[]): string {
	return describePluginDevelopment(["Native plugin sources:", ...sources.map((path) => `- ${path}`)]);
}

/** The hosted session already owns these manifests; source maps identify their original files. */
export function describePluginManifests(manifestPaths: readonly string[]): string {
	return describePluginDevelopment([
		"Native plugin manifests for this session:",
		...manifestPaths.map((path) => `- ${path}`),
		"Read the manifest's session entry and its sourceMap to locate original files. Resolve source-map sources relative to that map, applying sourceRoot if present. Edit original source files, not generated bundles. A bundle without a source map does not identify editable source; use the configured package's source location.",
	]);
}

function describePluginDevelopment(locations: readonly string[]): string {
	const packageDir = getPackageDir();
	const source = import.meta.url.endsWith(".ts");
	const api = join(packageDir, source ? "src" : "dist", source ? "plugin.ts" : "plugin.d.ts");
	return [
		...locations,
		`API: @amazme/coding-agent/plugin (${api})`,
		`Guide: ${join(packageDir, "docs", "plugin-runtime.md")}`,
		"Edit these sources, finish or abort active tasks, then run /reload to rebuild and activate them. Candidate preparation failure keeps the current version. Core and application-shell changes require a build and restart.",
	].join("\n");
}
