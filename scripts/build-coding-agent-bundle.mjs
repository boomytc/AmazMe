#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/coding-agent/dist");
const bundle = join(dist, "bundle");
const entries = {
	"cli-runtime": join(dist, "cli.js"),
	index: join(dist, "index.js"),
	"rpc-entry": join(dist, "rpc-entry.js"),
};
for (const path of [...Object.values(entries), join(dist, "utils/image-resize-worker.js")]) {
	if (!existsSync(path)) throw new Error(`Bundle input missing: ${relative(root, path)}`);
}
rmSync(bundle, { force: true, recursive: true });
mkdirSync(bundle, { recursive: true });
const options = {
	absWorkingDir: root,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22.19",
	define: { AMAZME_BUNDLED_NODE: "true" },
	external: ["@silvia-odwyer/photon-node"],
	banner: {
		js: 'import { createRequire as __amazmeCreateRequire } from "node:module"; const require = __amazmeCreateRequire(import.meta.url);',
	},
	legalComments: "none",
	logLevel: "warning",
	metafile: true,
	minifySyntax: true,
	minifyWhitespace: true,
	tsconfigRaw: { compilerOptions: {} },
};
const main = await build({
	...options,
	entryPoints: entries,
	outdir: bundle,
	entryNames: "[name]",
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});
// The only out-of-graph worker is a media helper. It resolves beside image-resize's chunk.
const imageOutput = Object.entries(main.metafile.outputs).find(([, value]) =>
	Object.keys(value.inputs).some((path) => path.endsWith("coding-agent/dist/utils/image-resize.js")),
);
if (!imageOutput) throw new Error("Image helper missing from client bundle");
const media = await build({
	...options,
	entryPoints: { "image-resize-worker": join(dist, "utils/image-resize-worker.js") },
	outdir: dirname(resolve(root, imageOutput[0])),
});
for (const graph of [main.metafile, media.metafile]) {
	for (const [path, input] of Object.entries(graph.inputs)) {
		if (
			/packages\/(?:ai|durable|chord|agent|mcp|server)\/dist\//.test(path) ||
			/coding-agent\/dist\/(?:host|durable|extensions)\//.test(path)
		)
			throw new Error(`Legacy business runtime in product bundle: ${path}`);
		for (const item of input.imports) {
			if (item.external && !isBuiltin(item.path) && item.path !== "@silvia-odwyer/photon-node")
				throw new Error(`Unexpected external import: ${item.path}`);
		}
	}
}
const launcher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";
enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
writeFileSync(join(bundle, "cli.js"), launcher);
chmodSync(join(bundle, "cli.js"), 0o755);
chmodSync(join(bundle, "rpc-entry.js"), 0o755);
writeFileSync(
	join(bundle, "inputs.json"),
	JSON.stringify(
		[...new Set([...Object.keys(main.metafile.inputs), ...Object.keys(media.metafile.inputs)])].sort(),
		null,
		2,
	) + "\n",
);
console.log(`Built ${relative(root, bundle)} with Python clients and media helpers`);
