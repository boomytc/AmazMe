import { stat } from "node:fs/promises";
import type { FacetLoader } from "@amazme/chord";
import { pathToFileURL } from "node:url";
import { buildPluginEntry, loadPluginArtifacts } from "./artifact.ts";
import { inspectPluginPackage } from "./package.ts";

/** Rebuild source entries, then let Chord load their fresh module generations. */
export function createSourcePluginLoader(sources: readonly string[]): FacetLoader {
	return async () => {
		const entries: string[] = [];
		for (const source of sources) {
			const info = await stat(source);
			if (info.isDirectory() || source.endsWith("/package.json")) {
				const pkg = await inspectPluginPackage(source);
				if (pkg.entries.session) entries.push(pkg.entries.session);
			} else entries.push(source);
		}
		return loadPluginArtifacts(
			await Promise.all(entries.map((entry) => buildPluginEntry(pathToFileURL(entry).href, entry))),
		);
	};
}
