import { join } from "node:path";
import { getPackageDir } from "../../config.ts";

export function resolveAgentPluginExternal(specifier: string): string | undefined {
	if (specifier !== "@amazme/coding-agent/plugin") return undefined;
	const source = import.meta.url.endsWith(".ts");
	return join(getPackageDir(), source ? "src" : "dist", source ? "plugin.ts" : "plugin.js");
}

/** Source paths and the installed contract are discoverable without inventing another plugin catalogue. */
export function describePluginSources(sources: readonly string[]): string {
	const packageDir = getPackageDir();
	const source = import.meta.url.endsWith(".ts");
	const api = join(packageDir, source ? "src" : "dist", source ? "plugin.ts" : "plugin.d.ts");
	return [
		"Native plugins:",
		...sources.map((path) => `- ${path}`),
		`API: @amazme/coding-agent/plugin (${api})`,
		`Guide: ${join(packageDir, "docs", "plugin-runtime.md")}`,
		"Edit these sources, finish or abort active tasks, then run /reload to rebuild and activate them. Candidate preparation failure keeps the current version. Core and application-shell changes require a build and restart.",
	].join("\n");
}
