import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Facet } from "@amazme/chord";
import { nodeLoader } from "@amazme/chord/node";
import { resolveAgentPluginExternal } from "./info.ts";

export interface PluginArtifact {
	readonly name: string;
	readonly code: string;
}
export interface PluginBuild {
	readonly name: string;
	readonly entries: Readonly<Record<string, PluginArtifact>>;
}
export const PLUGIN_BUILD_FILE = "plugin.json";
const HOST_IMPORTS = [
	"@amazme/ai",
	"@amazme/chord",
	"@amazme/durable",
	"@amazme/mcp",
	"@amazme/protocol",
	"@amazme/coding-agent/plugin",
	"@amazme/coding-agent/host/plugin",
	"proper-lockfile",
	"@silvia-odwyer/photon-node",
];

export async function buildPluginEntry(name: string, path: string): Promise<PluginArtifact> {
	const result = await build({
		entryPoints: [path],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		target: "node22",
		sourcemap: "inline",
		external: HOST_IMPORTS,
	});
	return { name, code: result.outputFiles[0]!.text };
}
export function parsePluginArtifact(value: unknown): PluginArtifact {
	if (
		!value ||
		typeof value !== "object" ||
		!("name" in value) ||
		typeof value.name !== "string" ||
		!value.name ||
		!("code" in value) ||
		typeof value.code !== "string"
	)
		throw new Error("Invalid presentation plugin artifact");
	return { name: value.name, code: value.code };
}
export async function readPluginBuild(path: string): Promise<PluginBuild> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (
		!value ||
		typeof value !== "object" ||
		!("name" in value) ||
		typeof value.name !== "string" ||
		!("entries" in value) ||
		!value.entries ||
		typeof value.entries !== "object" ||
		Array.isArray(value.entries)
	)
		throw new Error(`Invalid plugin build: ${path}`);
	return {
		name: value.name,
		entries: Object.fromEntries(
			Object.entries(value.entries).map(([key, artifact]) => [key, parsePluginArtifact(artifact)]),
		),
	};
}

/** Bundle code has no relative runtime files. Temporary modules are removed after import, including failed candidates. */
export async function loadPluginArtifacts(artifacts: readonly PluginArtifact[]): Promise<Facet[]> {
	if (!artifacts.length) return [];
	const directory = await mkdtemp(join(tmpdir(), "amazme-plugin-"));
	try {
		const paths: string[] = [];
		for (const [index, artifact] of artifacts.entries()) {
			const path = join(directory, `${index}.mjs`);
			const result = await build({
				stdin: { contents: artifact.code, resolveDir: directory, sourcefile: artifact.name },
				bundle: true,
				write: false,
				format: "esm",
				platform: "node",
				plugins: [
					{
						name: "host-imports",
						setup(builder) {
							builder.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => ({
								path: specifier.startsWith("node:")
									? specifier
									: resolveAgentPluginExternal(specifier)
										? pathToFileURL(resolveAgentPluginExternal(specifier)!).href
										: import.meta.resolve(specifier),
								external: true,
							}));
						},
					},
				],
			});
			await writeFile(path, result.outputFiles[0]!.text);
			paths.push(path);
		}
		const facets = await nodeLoader(paths);
		return facets.map((facet, index) => ({ ...facet, name: artifacts[index]!.name }));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
