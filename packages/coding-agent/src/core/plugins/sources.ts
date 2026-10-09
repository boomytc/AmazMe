import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { isLocalPath, normalizePath } from "../../utils/paths.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

/** Native facets use local sources; no legacy extension factory is evaluated during discovery. */
export async function discoverPluginSources(options: {
	readonly cwd: string;
	readonly settings: SettingsManager;
	readonly extensions?: readonly string[];
	readonly noExtensions?: boolean;
}): Promise<readonly string[]> {
	const agentDir = getAgentDir();
	const projectDir = join(options.cwd, CONFIG_DIR_NAME);
	const selected: string[] = [];
	const add = async (path: string): Promise<void> => {
		if (!isLocalPath(path)) throw new Error(`Native plugins require a local source file or facet package: ${path}`);
		const canonical = await realpath(path);
		const source = basename(canonical) === "package.json" ? resolve(canonical, "..") : canonical;
		if (!selected.includes(source)) selected.push(source);
	};
	if (!options.noExtensions) {
		for (const [base, configured] of [
			[agentDir, options.settings.getGlobalSettings().extensions ?? []],
			...(options.settings.isProjectTrusted() ? [[projectDir, options.settings.getProjectSettings().extensions ?? []]] as const : []),
		] as const) {
			for (const source of await discoverDirectory(join(base, "extensions"))) await add(source);
			for (const path of configured) {
				if (/^[!+-]|[*?\[\]{}]/u.test(path)) throw new Error(`Native plugin settings require exact local paths: ${path}`);
				if (!isLocalPath(path)) throw new Error(`Native plugins require a local source file or facet package: ${path}`);
				await add(resolve(base, normalizePath(path)));
			}
		}
	}
	for (const path of options.extensions ?? []) {
		if (!isLocalPath(path)) throw new Error(`Native plugins require a local source file or facet package: ${path}`);
		await add(resolve(options.cwd, normalizePath(path)));
	}
	return Object.freeze(selected);
}

async function discoverDirectory(directory: string): Promise<readonly string[]> {
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if (missing(error)) return [];
		throw error;
	}
	if (entries.includes("package.json")) return [directory];
	for (const index of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
		if (entries.includes(index)) return [join(directory, index)];
	}
	const sources: string[] = [];
	for (const name of entries.sort()) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const path = join(directory, name);
		const info = await stat(path);
		if (info.isFile() && SOURCE_EXTENSIONS.has(extname(name)) && !/\.d\.(?:ts|mts|cts)$/u.test(name)) sources.push(path);
		else if (info.isDirectory()) {
			const children = await readdir(path);
			if (children.includes("package.json")) sources.push(path);
			else {
				const index = ["index.ts", "index.js", "index.mts", "index.mjs"].find((entry) => children.includes(entry));
				if (index !== undefined) sources.push(join(path, index));
			}
		}
	}
	return sources;
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
