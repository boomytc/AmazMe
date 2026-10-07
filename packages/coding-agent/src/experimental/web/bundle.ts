import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
/** The page entry is the host's own presentation bootstrap, next to this module. */
export const WEB_PAGE_ENTRY = fileURLToPath(new URL("./page.ts", import.meta.url));

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

