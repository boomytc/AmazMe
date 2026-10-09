import { join } from "node:path";
import { combineFacetLoaders, type FacetLoader, type JsonValue } from "@amazme/chord";
import {
	createFacetBundleArtifactLoader,
	createFacetBundleLoader,
	type FacetBundleArtifact,
	readFacetBundleManifest,
} from "@amazme/chord/node";
import { getPackageDir } from "../../config.ts";

const PRESENTATION_FACET_BUNDLES_KEY = "presentationFacetBundles";
const AMAZME_PLUGIN_API = "@amazme/coding-agent/experimental/plugin";

export function createSessionPluginFacetLoader(manifestPaths: readonly string[]): FacetLoader | undefined {
	if (manifestPaths.length === 0) return undefined;
	return combineFacetLoaders(manifestPaths.map(createOptionalSessionFacetLoader));
}

function createOptionalSessionFacetLoader(manifestPath: string): FacetLoader {
	const loader = createFacetBundleLoader({
		manifestPath,
		entry: "session",
		resolveExternal: resolvePluginExternal,
	});
	return {
		async load() {
			const manifest = await readFacetBundleManifest(manifestPath);
			if (manifest.entries.session !== undefined) return loader.load();
			return { facets: Object.freeze([]), async dispose() {} };
		},
	};
}

export function createPresentationFacetData(artifacts: readonly FacetBundleArtifact[]): JsonValue {
	return {
		[PRESENTATION_FACET_BUNDLES_KEY]: artifacts.map((artifact) => artifact as unknown as JsonValue),
	};
}

/** Create local loaders only from artifacts selected and sent by the connected server. */
export function createPresentationFacetLoaders(data: JsonValue): readonly FacetLoader[] {
	if (data === null || Array.isArray(data) || typeof data !== "object") {
		throw new Error("Invalid presentation plugin data");
	}
	const artifacts = data[PRESENTATION_FACET_BUNDLES_KEY];
	if (artifacts === undefined) return [];
	if (!Array.isArray(artifacts)) throw new Error("Invalid presentation plugin bundle list");
	return artifacts.map((artifact) =>
		createFacetBundleArtifactLoader({ artifact, resolveExternal: resolvePluginExternal }),
	);
}

function resolvePluginExternal(specifier: string): string | undefined {
	if (specifier === "@amazme/coding-agent/plugin") {
		const source = import.meta.url.endsWith(".ts");
		return join(getPackageDir(), source ? "src" : "dist", source ? "plugin.ts" : "plugin.js");
	}
	if (specifier !== AMAZME_PLUGIN_API) return undefined;
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	return new URL(`../plugin.${extension}`, import.meta.url).href;
}
