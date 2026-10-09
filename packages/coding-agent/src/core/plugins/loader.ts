import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { combineFacetLoaders } from "@amazme/chord";
import type { FacetLoader } from "@amazme/chord";
import { bundleFacetPackage, bundleFacets } from "@amazme/chord/bundler";
import { createFacetBundleLoader } from "@amazme/chord/node";
import { resolveAgentPluginExternal } from "./info.ts";

const HOST_IMPORTS = ["@amazme/ai", "@amazme/chord", "@amazme/durable", "@amazme/coding-agent/plugin"];

/** Rebuild selected source files or packages for every candidate; artifacts live only for that generation. */
export function createSourcePluginLoader(sources: readonly string[]): FacetLoader {
	return combineFacetLoaders(sources.map((source) => ({
		async load() {
			const directory = await mkdtemp(join(tmpdir(), "amazme-plugin-"));
			try {
				const info = await stat(source);
				const result = info.isDirectory()
					? await bundleFacetPackage({
						packagePath: source,
						outdir: directory,
						defaultFacets: { session: "src/session.ts" },
						external: HOST_IMPORTS,
						entryNames: ["session"],
					})
					: await bundleFacets({
						plugin: { id: source },
						entries: { session: source },
						outdir: directory,
						workingDirectory: dirname(source),
						external: HOST_IMPORTS,
						sourceMap: true,
					});
				const loaded = await createFacetBundleLoader({
					manifestPath: result.manifestPath,
					entry: "session",
					resolveExternal: resolveAgentPluginExternal,
				}).load();
				return {
					facets: loaded.facets,
					async dispose() {
						try {
							await loaded.dispose();
						} finally {
							await rm(directory, { recursive: true, force: true });
						}
					},
				};
			} catch (error) {
				try {
					await rm(directory, { recursive: true, force: true });
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Plugin source loading and cleanup failed");
				}
				throw error;
			}
		},
	})));
}
