import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The document and its stylesheets live in `src/page`; the host serves them from the tree. */
export const PAGE_DIRECTORY = fileURLToPath(new URL("./page/", import.meta.url));
export const PAGE_DOCUMENT = "index.html";
/** Served path of the bundled page entry. */
export const PAGE_SCRIPT = "/page.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};

export function contentTypeFor(path: string): string {
	return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Resolve a served path inside the page directory, or undefined when it escapes. */
export function resolvePageAsset(urlPath: string): string | undefined {
	const decoded = decodeURIComponent(urlPath);
	if (decoded.includes("\0")) return undefined;
	const candidate = normalize(join(PAGE_DIRECTORY, decoded));
	const inside = relative(PAGE_DIRECTORY, candidate);
	if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return undefined;
	return candidate;
}

/** Read the document the host injects its boot manifest into. */
export async function readPageDocument(name: string = PAGE_DOCUMENT): Promise<string> {
	const path = resolvePageAsset(name);
	if (path === undefined) throw new Error(`Invalid page asset name: ${name}`);
	return readFile(path, "utf8");
}
