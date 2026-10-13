import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface PluginPackage {
	name: string;
	packageDirectory: string;
	entries: Record<string, string>;
}

/** Inspect the product package convention without evaluating plugin code. */
export async function inspectPluginPackage(path: string): Promise<PluginPackage> {
	const packageDirectory = basename(path) === "package.json" ? dirname(resolve(path)) : resolve(path);
	const data: unknown = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
	if (!data || typeof data !== "object" || !("name" in data) || typeof data.name !== "string" || !data.name)
		throw new Error(`Invalid plugin package: ${path}`);
	const chord = "chord" in data ? data.chord : undefined;
	const configured = chord && typeof chord === "object" && "facets" in chord ? chord.facets : undefined;
	if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured)))
		throw new Error(`Invalid plugin facets: ${path}`);
	const entries: Record<string, string> = {};
	for (const [kind, entry] of Object.entries(
		configured ?? { session: "src/session.ts", tui: "src/tui.ts", server: "src/server.ts" },
	)) {
		if (entry === false) continue;
		if (!["session", "tui", "server"].includes(kind) || typeof entry !== "string" || !entry)
			throw new Error(`Invalid plugin entry: ${kind}`);
		const file = resolve(packageDirectory, entry);
		try {
			if (!(await stat(file)).isFile()) throw new Error(`Plugin entry is not a file: ${file}`);
		} catch (error) {
			if (configured === undefined && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		entries[kind] = file;
	}
	return { name: data.name, packageDirectory, entries };
}
