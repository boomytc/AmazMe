import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The page lives next to this module; the host serves it straight from the source tree. */
export const WEB_PAGE_DIRECTORY = fileURLToPath(new URL("./page/", import.meta.url));
export const WEB_PAGE_ENTRY = join(WEB_PAGE_DIRECTORY, "main.ts");
/** Served path of the bundled page entry. */
export const WEB_PAGE_SCRIPT = "/page.js";

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

/** Resolve a served path inside the page directory, or undefined when it escapes or is not a file. */
export function resolvePageAsset(urlPath: string): string | undefined {
	const decoded = decodeURIComponent(urlPath);
	if (decoded.includes("\0")) return undefined;
	const candidate = normalize(join(WEB_PAGE_DIRECTORY, decoded));
	const inside = relative(WEB_PAGE_DIRECTORY, candidate);
	if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return undefined;
	return candidate;
}

/**
 * Bundle the page's TypeScript entry for the browser with the repository's esbuild and the
 * root tsconfig paths, so the page shares the real protocol and client code instead of a copy.
 */
export async function bundlePageEntry(
	repositoryRoot: string,
	entry: string = WEB_PAGE_ENTRY,
): Promise<{ code: string; warnings: readonly string[] }> {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: ["es2022"],
		tsconfig: join(repositoryRoot, "tsconfig.json"),
		logLevel: "silent",
		metafile: false,
	});
	const [output] = result.outputFiles;
	if (output === undefined) throw new Error("Page bundle produced no output");
	return { code: output.text, warnings: result.warnings.map((warning) => warning.text) };
}

/** Read one page document from the source tree. */
export async function readPageDocument(name = "index.html"): Promise<string> {
	const path = resolvePageAsset(name);
	if (path === undefined) throw new Error(`Invalid page asset name: ${name}`);
	return readFile(path, "utf8");
}
