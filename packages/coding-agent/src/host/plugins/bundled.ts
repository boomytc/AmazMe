import type { FacetLoader, JsonValue } from "@amazme/chord";
import {
	loadPluginArtifacts,
	parsePluginArtifact,
	readPluginBuild,
	type PluginArtifact,
} from "../../core/plugins/artifact.ts";

const PRESENTATION_MODULES_KEY = "presentationModules";
export function createSessionPluginFacetLoader(paths: readonly string[]): FacetLoader | undefined {
	return packageLoader(paths, "session");
}
export function createServerPluginFacetLoader(paths: readonly string[]): FacetLoader | undefined {
	return packageLoader(paths, "server");
}
function packageLoader(paths: readonly string[], kind: string): FacetLoader | undefined {
	if (!paths.length) return undefined;
	return async () => {
		const artifacts: PluginArtifact[] = [];
		for (const path of paths) {
			const entry = (await readPluginBuild(path)).entries[kind];
			if (entry) artifacts.push(entry);
		}
		return loadPluginArtifacts(artifacts);
	};
}
export function createPresentationFacetData(artifacts: readonly PluginArtifact[]): JsonValue {
	return { [PRESENTATION_MODULES_KEY]: artifacts.map(({ name, code }) => ({ name, code })) };
}
export function createPresentationFacetLoaders(data: JsonValue): readonly FacetLoader[] {
	if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("Invalid presentation plugin data");
	const artifacts = data[PRESENTATION_MODULES_KEY];
	if (artifacts === undefined) return [];
	if (!Array.isArray(artifacts)) throw new Error("Invalid presentation plugin list");
	const modules = artifacts.map(parsePluginArtifact);
	return [async () => loadPluginArtifacts(modules)];
}
export async function loadFacets(loaders: readonly FacetLoader[]) {
	return (await Promise.all(loaders.map((loader) => loader([])))).flat();
}
