#!/usr/bin/env node
// Build latest.json for a GitHub Release: every installer with its sha256, checked against the
// `<installer>.sha256` file the desktop build published next to it. Clients read this manifest.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Pure manifest builder; `installers` maps asset name to { digest, published } sha256 text. */
export function buildManifest({ tag, repository, installers }) {
	if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`not a release tag: ${tag}`);
	if (installers.length === 0) throw new Error("no installers to list");
	const assets = installers.map(({ name, digest, published }) => {
		const [listed, listedName] = published.trim().split(/\s+/);
		if (listed !== digest || listedName !== name) throw new Error(`${name}.sha256 does not match ${name}`);
		return { name, url: `https://github.com/${repository}/releases/download/${tag}/${name}`, sha256: digest };
	});
	return { version: tag.slice(1), tag, assets };
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function main([tag, repository, directory, out]) {
	if (!out) throw new Error("usage: release-manifest.mjs <tag> <owner/repo> <asset-dir> <out.json>");
	const names = (await readdir(directory)).filter((name) => name.endsWith(".dmg")).sort();
	const installers = await Promise.all(
		names.map(async (name) => ({
			name,
			digest: await sha256(join(directory, name)),
			published: await readFile(join(directory, `${name}.sha256`), "utf8"),
		})),
	);
	await writeFile(out, `${JSON.stringify(buildManifest({ tag, repository, installers }), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
