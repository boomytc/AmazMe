import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node strips TypeScript natively, but it does not apply the workspace source
// aliases from tsconfig.json. Internal source processes preload this resolver so
// they cannot silently fall through to stale package dist files. A path that
// points at a package dist declaration is loaded from that package's src: the
// node project uses the declaration because it excludes browser source, and
// Node would otherwise follow the declaration's .ts specifiers into dist.

interface TsConfig {
	readonly compilerOptions?: {
		readonly paths?: Readonly<Record<string, readonly string[]>>;
	};
}

interface SourceAlias {
	readonly pattern: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly replacements: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsconfigPath = resolve(repositoryRoot, "tsconfig.json");
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsConfig;
const paths = tsconfig.compilerOptions?.paths;
if (!paths) throw new Error(`Source runtime requires compilerOptions.paths in ${tsconfigPath}`);

const aliases: SourceAlias[] = Object.entries(paths)
	.filter(([pattern]) => pattern.startsWith("@amazme/"))
	.map(([pattern, replacements]) => {
		const wildcard = pattern.indexOf("*");
		if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
			throw new Error(`Source runtime does not support multiple wildcards in ${pattern}`);
		}
		return {
			pattern,
			prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
			suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
			replacements,
		};
	})
	.sort((left, right) => right.pattern.length - left.pattern.length);

registerHooks({
	resolve(specifier, context, nextResolve) {
		let matchedPattern: string | undefined;
		for (const alias of aliases) {
			const wildcard = matchAlias(alias, specifier);
			if (wildcard === undefined) continue;
			matchedPattern ??= alias.pattern;
			for (const replacement of alias.replacements) {
				const resolved = resolveSourcePath(replacement.replace("*", wildcard));
				if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
			}
		}
		if (matchedPattern) {
			throw new Error(`Source runtime could not resolve ${specifier} through tsconfig path ${matchedPattern}`);
		}
		return nextResolve(specifier, context);
	},
});

function matchAlias(alias: SourceAlias, specifier: string): string | undefined {
	if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
	if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
	return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

function resolveSourcePath(replacement: string): string | undefined {
	const basePath = resolve(repositoryRoot, replacement);
	const rootPrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;
	if (!basePath.startsWith(rootPrefix)) return undefined;
	for (const candidate of sourcePathCandidates(basePath, rootPrefix)) {
		if (!candidate.startsWith(rootPrefix)) continue;
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

// extname("index.d.ts") is ".ts", so a declaration target would otherwise be the
// only candidate and win. A package dist declaration maps to that package's src,
// then to a sibling .ts. The declaration itself is left out: loading it makes
// Node follow its .ts specifiers into dist. Missing source fails as an unresolved
// tsconfig path instead of a missing file inside dist.
function sourcePathCandidates(basePath: string, rootPrefix: string): readonly string[] {
	const packageSource = packageDeclarationSource(basePath, rootPrefix);
	const preferred: string[] = [];
	if (packageSource !== undefined) preferred.push(packageSource);
	if (basePath.endsWith(".d.ts")) {
		const besideDeclaration = `${basePath.slice(0, -".d.ts".length)}.ts`;
		if (besideDeclaration !== packageSource) preferred.push(besideDeclaration);
	}
	if (packageSource !== undefined) return preferred;
	return [...preferred, ...extensionCandidates(basePath)];
}

function packageDeclarationSource(basePath: string, rootPrefix: string): string | undefined {
	if (!basePath.endsWith(".d.ts")) return undefined;
	const relativePath = basePath.slice(rootPrefix.length);
	const packagesPrefix = `packages${sep}`;
	if (!relativePath.startsWith(packagesPrefix)) return undefined;
	const afterPackages = relativePath.slice(packagesPrefix.length);
	const nameEnd = afterPackages.indexOf(sep);
	if (nameEnd <= 0) return undefined;
	const insidePackage = afterPackages.slice(nameEnd + 1);
	const distPrefix = `dist${sep}`;
	if (!insidePackage.startsWith(distPrefix)) return undefined;
	const sourceStem = insidePackage.slice(distPrefix.length, -".d.ts".length);
	if (sourceStem.length === 0 || sourceStem.endsWith(sep)) return undefined;
	return resolve(repositoryRoot, "packages", afterPackages.slice(0, nameEnd), "src", `${sourceStem}.ts`);
}

function extensionCandidates(basePath: string): readonly string[] {
	const extension = extname(basePath);
	const sourceExtension =
		extension === ".js" ? ".ts" : extension === ".mjs" ? ".mts" : extension === ".cjs" ? ".cts" : undefined;
	if (sourceExtension) return [basePath, `${basePath.slice(0, -extension.length)}${sourceExtension}`];
	if (extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".json") return [basePath];
	return [basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];
}
