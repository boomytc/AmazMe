/**
 * The boot contract between the host and the page. Deliberately dependency-free so the
 * browser bundle carries the constants and the manifest type without the host's code.
 */

/** Global the page reads before it starts; absent means the host served an unbootable document. */
export const BOOT_GLOBAL = "__AMAZME_BOOT__";

/** Marker the served document carries so the host can inject the manifest per request. */
export const BOOT_PLACEHOLDER = "<!--amazme-boot-->";

/** How the host assembles and serves the page. Recorded so the page never guesses its runtime. */
export type WebMode = "source";

/**
 * The stored interface preferences the host read when it served this document. The document has
 * already applied them, so the page starts in the right language and palette and only has to keep
 * following the replicated settings afterwards. `locale` may be `auto`; the page resolves that from
 * the browser the same way the host resolved it from the request.
 */
export interface WebBootPreferences {
	readonly locale: string;
	readonly appearance: string;
}

/** Everything the page needs before it can reach the host: identity, mode, and transport. */
export interface WebBootManifest {
	readonly app: { readonly name: string; readonly version: string };
	readonly mode: WebMode;
	readonly protocolVersion: number;
	readonly server: { readonly id: string };
	readonly transport: { readonly url: string; readonly path: string };
	readonly preferences: WebBootPreferences;
}
