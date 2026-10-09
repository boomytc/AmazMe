import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { isLocalPath, normalizePath } from "../../utils/paths.ts";

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".js",
	".mts",
	".mjs",
	".cts",
	".cjs",
]);

type PluginCandidate = {
	readonly source: string;
	readonly entry: string;
	readonly selection: string;
};

/** Resolve sources without evaluating a factory; package installation and filtering use the shared manager. */
export async function discoverPluginSources(options: {
	readonly cwd: string;
	readonly settings: SettingsManager;
	readonly extensions?: readonly string[];
	readonly noExtensions?: boolean;
}): Promise<readonly string[]> {
	const explicit = [...(options.extensions ?? [])];
	const agentDir = getAgentDir();
	const projectDir = join(options.cwd, CONFIG_DIR_NAME);
	const global = options.settings.getGlobalSettings();
	const project = options.settings.isProjectTrusted()
		? options.settings.getProjectSettings()
		: {};
	const selected = new Map<string, boolean>();
	const put = async (
		candidate: PluginCandidate,
		enabled: boolean,
		force = false,
	): Promise<void> => {
		const source = await realpath(candidate.source);
		if (force || !selected.has(source)) selected.set(source, enabled);
	};
	if (!options.noExtensions) {
		for (const [base, configured] of [
			[projectDir, project.extensions ?? []],
			[agentDir, global.extensions ?? []],
		] as const) {
			if (base === projectDir && !options.settings.isProjectTrusted()) continue;
			const paths = [...(await discoverDirectory(join(base, "extensions")))];
			const candidates: PluginCandidate[] = [];
			if (configured.length > 0) {
				const {
					isOverridePattern,
					expandPackageGlob,
					hasGlobPattern,
					isEnabledByOverrides,
				} = await import("../package-manager.ts");
				for (const path of configured.filter(
					(entry) => !isOverridePattern(entry),
				)) {
					if (!isLocalPath(path))
						throw new Error(
							`Plugin settings require local paths; use packages for npm/git sources: ${path}`,
						);
					paths.push(
						...(hasGlobPattern(path)
							? expandPackageGlob(path, base)
							: [resolve(base, normalizePath(path))]),
					);
				}
				for (const path of paths)
					candidates.push(...(await pluginCandidates(path)));
				for (const candidate of candidates)
					await put(
						candidate,
						isEnabledByOverrides(
							candidate.entry,
							selectionPatterns(candidate, configured, base),
							base,
						),
					);
			} else {
				for (const path of paths)
					candidates.push(...(await pluginCandidates(path)));
				for (const candidate of candidates) await put(candidate, true);
			}
		}
		if ((project.packages?.length ?? 0) + (global.packages?.length ?? 0) > 0) {
			const {
				DefaultPackageManager,
				applyPatterns,
				applyAutoloadDisabledPatterns,
			} = await import("../package-manager.ts");
			const manager = new DefaultPackageManager({
				cwd: options.cwd,
				agentDir,
				settingsManager: options.settings,
			});
			for (const pkg of await manager.resolvePackagePaths({
				resource: "extensions",
			})) {
				const candidates = await pluginCandidates(pkg.path);
				const info = await stat(pkg.path);
				const base = info.isDirectory() ? pkg.path : dirname(pkg.path);
				const paths = candidates.map(({ entry }) => entry);
				if (pkg.filter?.autoload === false) {
					const overrides = applyAutoloadDisabledPatterns(
						paths,
						pkg.filter.extensions ?? [],
						base,
					);
					for (const candidate of candidates)
						if (overrides.has(candidate.entry))
							await put(candidate, overrides.get(candidate.entry)!);
				} else {
					const enabled =
						pkg.filter?.extensions === undefined
							? new Set(paths)
							: applyPatterns(paths, pkg.filter.extensions, base);
					for (const candidate of candidates)
						await put(candidate, enabled.has(candidate.entry));
				}
			}
		}
	}
	for (const source of explicit) {
		let path: string;
		if (isLocalPath(source)) path = resolve(options.cwd, normalizePath(source));
		else {
			if (source.startsWith("builtin:"))
				throw new Error(
					`Native plugins use defineFacet, not built-in SDK factories: ${source}`,
				);
			const { DefaultPackageManager } = await import("../package-manager.ts");
			const manager = new DefaultPackageManager({
				cwd: options.cwd,
				agentDir,
				settingsManager: options.settings,
			});
			const paths = await manager.resolvePackagePaths({ sources: [source] });
			if (paths[0] === undefined)
				throw new Error(`Plugin source is unavailable: ${source}`);
			path = paths[0].path;
		}
		for (const candidate of await pluginCandidates(path))
			await put(candidate, true, true);
	}
	return Object.freeze(
		[...selected].filter(([, enabled]) => enabled).map(([source]) => source),
	);
}

/** A package path and its session entry name select the same executable unit. */
function selectionPatterns(
	candidate: PluginCandidate,
	patterns: readonly string[],
	base: string,
): string[] {
	return patterns.map((pattern) => {
		if (!/^[!+-]/u.test(pattern)) return pattern;
		const target = resolve(base, normalizePath(pattern.slice(1)));
		return target === resolve(candidate.selection)
			? pattern[0] + candidate.entry
			: pattern;
	});
}

async function pluginCandidates(path: string): Promise<PluginCandidate[]> {
	const info = await stat(path);
	if (info.isFile() && basename(path) !== "package.json")
		return [{ source: path, entry: path, selection: path }];
	if (info.isDirectory()) {
		try {
			await stat(join(path, "package.json"));
		} catch (error) {
			if (!missing(error)) throw error;
			const result: PluginCandidate[] = [];
			for (const entry of await discoverDirectory(path))
				result.push(...(await pluginCandidates(entry)));
			return result;
		}
	}
	const { inspectFacetPackage } = await import("@amazme/chord/bundler");
	const pkg = await inspectFacetPackage({
		packagePath: path,
		defaultFacets: { session: "src/session.ts" },
		entryNames: ["session"],
	});
	const entry = pkg.entries.session;
	if (entry === undefined) return [];
	const logicalRoot = info.isDirectory() ? path : dirname(path);
	return [
		{
			source: pkg.packageDirectory,
			entry: resolve(logicalRoot, relative(pkg.packageDirectory, entry)),
			selection: path,
		},
	];
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
