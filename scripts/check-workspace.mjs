import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isFunctionLikeDeclaration,
	isIdentifier,
	isImportDeclaration,
	isImportTypeNode,
	isLiteralTypeNode,
	isNamedExports,
	isNamedImports,
	isNoSubstitutionTemplateLiteral,
	isPropertyAccessExpression,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";
import { runtimePackages, workspacePackages } from "./package-artifacts.mjs";

const layers = new Map([
	["@amazme/chord", 0],
	["@amazme/codemode", 0],
	["@amazme/mcp", 0],
	["@amazme/telemetry", 0],
	["@amazme/tui", 0],
	["@amazme/ai", 1],
	["@amazme/agent", 2],
	["@amazme/durable", 2],
	["@amazme/protocol", 2],
	["@amazme/env", 3],
	["@amazme/client", 3],
	["@amazme/web", 3],
	["@amazme/server", 4],
	["@amazme/gui", 6],
	["@amazme/coding-agent", 5],
	["@amazme/evals", 6],
]);

function sourceFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? sourceFiles(path)
			: entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
				? [path]
				: [];
	});
}

/**
 * Whether a source file is a process entry, judged from declarations and syntax alone. A process
 * executes an entry directly and no module imports it, so only an entry may suspend its own
 * evaluation. Published bin targets map back from their build output to their source.
 */
function declaredEntry(pkg, file) {
	if (readFileSync(file, "utf8").startsWith("#!")) return true;
	const bin = pkg.manifest.bin;
	const targets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
	return targets.some((target) => {
		const sourcePath = String(target)
			.replace(/^\.\//, "")
			.replace(/^dist\//, "src/")
			.replace(/\.js$/, ".ts");
		return resolve(pkg.directory, sourcePath) === file;
	});
}

/**
 * Positions where the module suspends evaluation: an `await`, `for await`, or `await using` whose
 * nearest enclosing function body is the module itself. Top-level if, block, try, loop, switch, and
 * export initializers all count as module scope; function, method, accessor, constructor, and
 * arrow bodies do not.
 */
function moduleScopeAwaits(source) {
	const found = [];
	const visit = (node, inFunction) => {
		const nested = inFunction || isFunctionLikeDeclaration(node);
		if (!nested) {
			if (node.kind === SyntaxKind.AwaitExpression) found.push(node.getStart(source));
			else if (node.kind === SyntaxKind.ForOfStatement && node.awaitModifier !== undefined)
				found.push(node.getStart(source));
			else if (
				node.kind === SyntaxKind.VariableStatement &&
				(node.declarationList.flags & NodeFlags.AwaitUsing) === NodeFlags.AwaitUsing
			)
				found.push(node.getStart(source));
		}
		node.forEachChild((child) => visit(child, nested));
	};
	visit(source, false);
	return found;
}

/** Direct registry dependencies stay exact; workspace dependencies also match their release version. */
export function checkDependencyVersions(
	repoRoot,
	packages = workspacePackages(repoRoot),
) {
	const files = [];
	const rootManifest = join(repoRoot, "package.json");
	if (existsSync(rootManifest)) files.push(rootManifest);
	const collect = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (
				entry.isDirectory() &&
				!["node_modules", "dist", ".git"].includes(entry.name)
			)
				collect(join(directory, entry.name));
			else if (entry.isFile() && entry.name === "package.json")
				files.push(join(directory, entry.name));
		}
	};
	collect(join(repoRoot, "packages"));
	const failures = [];
	const exact =
		/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
	for (const file of files) {
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		for (const section of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
		]) {
			for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
				if (
					/^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:)/.test(
						specifier,
					)
				)
					continue;
				const alias = specifier.startsWith("npm:");
				const version = alias
					? specifier.slice(specifier.lastIndexOf("@") + 1)
					: specifier;
				const location = `${relative(repoRoot, file)}: ${section}.${name}`;
				if (!exact.test(version))
					failures.push(`${location} must be pinned, found ${specifier}`);
				else if (
					!alias &&
					packages.has(name) &&
					version !== packages.get(name).manifest.version
				)
					failures.push(
						`${location} must match workspace version ${packages.get(name).manifest.version}, found ${version}`,
					);
			}
		}
	}
	return failures;
}

const changelogSections = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];

/**
 * Package changelogs open with `# Changelog` and `## [Unreleased]`, date every release, and keep the
 * unreleased and newest release sections to the shared `###` headings in their fixed order.
 * Older sections are history and stay as written.
 */
export function checkChangelogs(repoRoot) {
	const failures = [];
	const packagesDirectory = join(repoRoot, "packages");
	if (!existsSync(packagesDirectory)) return failures;
	for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
		const file = join(packagesDirectory, entry.name, "CHANGELOG.md");
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const location = relative(repoRoot, file);
		const lines = readFileSync(file, "utf8").split("\n");
		if (lines[0] !== "# Changelog") failures.push(`${location}: first line must be "# Changelog"`);
		const releases = [];
		lines.forEach((line, index) => {
			if (!line.startsWith("## ")) return;
			if (releases.length === 0 && line !== "## [Unreleased]")
				failures.push(`${location}:${index + 1}: first section must be "## [Unreleased]", found "${line}"`);
			else if (releases.length > 0 && !/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/.test(line))
				failures.push(`${location}:${index + 1}: release heading must read "## [x.y.z] - YYYY-MM-DD", found "${line}"`);
			releases.push(index);
		});
		for (const start of releases.slice(0, 2)) {
			const end = releases.find((index) => index > start) ?? lines.length;
			let previous = -1;
			for (let index = start + 1; index < end; index++) {
				if (!lines[index].startsWith("### ")) continue;
				const name = lines[index].slice(4);
				const order = changelogSections.indexOf(name);
				if (order === -1)
					failures.push(`${location}:${index + 1}: section must be one of ${changelogSections.join(", ")}, found "${name}"`);
				else if (order <= previous)
					failures.push(`${location}:${index + 1}: "${name}" is repeated or out of order (${changelogSections.join(", ")})`);
				else previous = order;
				const next = lines.slice(index + 1, end).find((line) => line.trim() !== "");
				if (next === undefined || next.startsWith("#"))
					failures.push(`${location}:${index + 1}: "${name}" has no entries`);
			}
		}
	}
	return failures;
}

/**
 * Package build configs resolve sibling packages through the workspace links in node_modules, never
 * through `paths`. A `paths` entry is expanded against the logical working directory while the links
 * resolve to the real one, so on a symlinked checkout (macOS /tmp is /private/tmp) the same
 * declaration file loads twice and branded types stop matching. The rule covers each build config and
 * every relative config it extends.
 */
export function checkBuildConfigs(repoRoot) {
	const failures = [];
	const packagesDirectory = join(repoRoot, "packages");
	if (!existsSync(packagesDirectory)) return failures;
	const seen = new Set();
	for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
		let file = join(packagesDirectory, entry.name, "tsconfig.build.json");
		if (!entry.isDirectory() || !existsSync(file)) continue;
		while (file !== undefined && !seen.has(file)) {
			seen.add(file);
			const location = relative(repoRoot, file);
			let config;
			try {
				config = JSON.parse(readFileSync(file, "utf8"));
			} catch (error) {
				failures.push(`${location}: cannot parse build config: ${error.message}`);
				break;
			}
			if (config.compilerOptions?.paths !== undefined)
				failures.push(
					`${location}: build configs must not set compilerOptions.paths; resolve workspace packages through node_modules`,
				);
			const parent = typeof config.extends === "string" && config.extends.startsWith(".") ? config.extends : undefined;
			file = parent === undefined ? undefined : resolve(dirname(file), parent);
			if (file !== undefined && !existsSync(file)) file = undefined;
		}
	}
	return failures;
}

/** Hand-written text the release-version rule reads. Generated data and binaries are not scanned. */
const versionLiteralExtensions = /\.(?:[cm]?[jt]sx?|md|ya?ml|sh|html|css|swift|m|rs|txt)$/;
/** Files that own the version or record history: the version lives in package.json, releases in changelogs. */
const versionLiteralOwners = /(?:^|\/)(?:package\.json|package-lock\.json|CHANGELOG\.md)$/;
/**
 * Third-party products whose own versions may coincide with the release number. A match directly after
 * one of these words is that product's version, not AmazMe's.
 */
const versionLiteralThirdParty = ["Bun"];

function trackedFiles(repoRoot) {
	return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\0")
		.filter(Boolean);
}

/**
 * The release version is written only in package.json and changelogs. Code reads it from package.json
 * (`VERSION` in `@amazme/coding-agent/config`) and docs point to the releases, so a bump never leaves a
 * stale copy behind. `files` are repo-relative paths; the default is every file git tracks.
 */
export function checkVersionLiterals(repoRoot, files) {
	const failures = [];
	const manifest = join(repoRoot, "package.json");
	if (!existsSync(manifest)) return failures;
	const version = JSON.parse(readFileSync(manifest, "utf8")).version;
	if (typeof version !== "string" || version === "") return failures;
	files ??= trackedFiles(repoRoot);
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const literal = new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d)`, "g");
	const thirdParty = new RegExp(`\\b(?:${versionLiteralThirdParty.join("|")})\\s+$`);
	for (const file of files) {
		const path = file.replaceAll("\\", "/");
		if (!versionLiteralExtensions.test(path) || versionLiteralOwners.test(path)) continue;
		if (path.split("/").some((part) => part === "node_modules" || part === "dist")) continue;
		const absolute = join(repoRoot, path);
		if (!existsSync(absolute)) continue;
		readFileSync(absolute, "utf8")
			.split("\n")
			.forEach((line, index) => {
				for (const match of line.matchAll(literal)) {
					if (thirdParty.test(line.slice(0, match.index))) continue;
					failures.push(
						`${path}:${index + 1}: release version ${version} is hand-written; read it from package.json or link the releases`,
					);
				}
			});
	}
	return failures;
}

/**
 * Package sources that may still call `tmpdir()`, with the reason. Session output (truncated tool
 * output, MCP resources, codemode files) goes to the session's artifact directory instead, so it is
 * deleted with the session. The one session-scoped exemption is the `--no-session` artifact
 * directory, removed on release and at process exit. The other entries predate the rule: short-lived
 * scratch their owner removes, or locations that are not session output. Shrink this list; never
 * grow it for session output.
 */
export const sourceTempDirAllowlist = {
	"packages/coding-agent/src/durable/sessions.ts":
		"--no-session artifact directory, removed on release and on process exit",
	"packages/coding-agent/src/durable/export.ts": "export scratch directory, removed in finally",
	"packages/coding-agent/src/durable/runtime.ts": "/share upload scratch directory",
	"packages/coding-agent/src/host/services/share-command.ts": "/share upload scratch directory",
	"packages/coding-agent/src/modes/interactive/external-editor.ts": "external editor scratch file",
	"packages/coding-agent/src/utils/clipboard.ts": "WSL clipboard hand-off file",
	"packages/coding-agent/src/utils/clipboard-image.ts": "WSL clipboard hand-off file",
	"packages/coding-agent/src/core/plugins/artifact.ts": "plugin build scratch directory",
	"packages/durable/src/env/node.ts": "ExecutionEnv.createTempDir contract (not used for spills)",
	"packages/env/src/ssh.ts": "SSH host-key scratch directory",
	"packages/chord/src/manager.ts": "local IPC socket path",
	"packages/tui/src/tui-main-screen.ts": "crash log fallback when no log directory is set",
	"packages/evals/src/harness.ts": "eval workspaces and cache sweep",
};

/**
 * Package test trees may not call mkdtemp/mkdtempSync except from packages/<pkg>/test/temp-dir.ts at
 * the test root. Package sources (`packages/<pkg>/src`) may not call `tmpdir()` / `os.tmpdir()`
 * outside `allowed` (repo-relative path -> reason), and an allowed file that no longer calls it must
 * leave the list.
 */
export function checkTempDirUsage(repoRoot, allowed = sourceTempDirAllowlist) {
	const failures = [];
	const packagesDirectory = join(repoRoot, "packages");
	if (!existsSync(packagesDirectory)) return failures;
	const tmpdirCall = /\btmpdir\s*\(/;
	const sourceExtensions = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;
	const walkSource = (directory) => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walkSource(path);
				continue;
			}
			if (!sourceExtensions.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
			const file = relative(repoRoot, path).replaceAll("\\", "/");
			const lines = readFileSync(path, "utf8").split("\n");
			const calls = lines.flatMap((line, index) => (tmpdirCall.test(line) ? [index + 1] : []));
			if (Object.hasOwn(allowed, file)) {
				if (calls.length === 0)
					failures.push(`${file}: no longer calls tmpdir(); remove it from sourceTempDirAllowlist`);
				continue;
			}
			for (const line of calls)
				failures.push(
					`${file}:${line}: tmpdir() in package source; write session output under the session's artifactDirectory (ExecutionEnv.artifactDirectory)`,
				);
		}
	};
	const banned = /\bmkdtemp(?:Sync)?\s*\(/;
	const canonicalPath = join(packagesDirectory, "ai", "test", "temp-dir.ts");
	const canonical = existsSync(canonicalPath) ? readFileSync(canonicalPath) : undefined;
	const walk = (testRoot, directory) => {
		if (!existsSync(directory)) return;
		const helper = join(testRoot, "temp-dir.ts");
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(testRoot, path);
				continue;
			}
			if (
				!entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".js") &&
				!entry.name.endsWith(".mjs")
			)
				continue;
			if (path === helper) continue;
			const source = readFileSync(path, "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				if (!banned.test(line)) continue;
				failures.push(
					`${relative(repoRoot, path)}:${index + 1}: use createTempDir from temp-dir.ts instead of ${line.includes("mkdtempSync") ? "mkdtempSync" : "mkdtemp"}`,
				);
			}
		}
	};
	for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		walkSource(join(packagesDirectory, entry.name, "src"));
		const testRoot = join(packagesDirectory, entry.name, "test");
		walk(testRoot, testRoot);
		const helper = join(testRoot, "temp-dir.ts");
		if (!existsSync(helper)) continue;
		if (entry.name === "tui") continue;
		if (canonical === undefined) continue;
		const content = readFileSync(helper);
		if (!content.equals(canonical))
			failures.push(
				`${relative(repoRoot, helper)}: must match packages/ai/test/temp-dir.ts byte-for-byte (vitest helper); only packages/tui/test/temp-dir.ts may differ`,
			);
	}
	return failures;
}

/** Syntax-aware checks over source, including development-only host and browser modules. */
export function checkSourceContracts(repoRoot) {
	const root = resolve(repoRoot);
	const packages = workspacePackages(root);
	const failures = [
		...checkDependencyVersions(root, packages),
		...checkChangelogs(root),
		...checkBuildConfigs(root),
		...checkTempDirUsage(root),
		...checkVersionLiterals(root),
	];
	try {
		runtimePackages(packages, [...packages.keys()]);
	} catch (error) {
		failures.push(error.message);
	}
	const files = [];
	for (const [name, pkg] of packages) {
		if (!layers.has(name)) failures.push(`Package needs an explicit dependency layer: ${name}`);
		for (const dependency of Object.keys({
			...pkg.manifest.dependencies,
			...pkg.manifest.optionalDependencies,
			...pkg.manifest.peerDependencies,
		})) {
			if (dependency.startsWith("@amazme/") && packages.has(dependency) && layers.get(dependency) > layers.get(name)) {
				failures.push(
					`${relative(root, pkg.directory)}/package.json: dependency points upward from ${name} to ${dependency}`,
				);
			}
		}
		const configPath = join(pkg.directory, "tsconfig.build.json");
		const excluded = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")).exclude ?? []) : [];
		for (const file of sourceFiles(join(pkg.directory, "src"))) {
			const path = relative(pkg.directory, file).replaceAll("\\", "/");
			const development =
				pkg.manifest.private === true ||
				excluded.some((item) => !item.includes("*") && (path === item || path.startsWith(`${item}/`)));
			files.push({ file, pkg, development, excluded });
		}
	}
	if (files.length === 0) return failures;
	const configPath = join(root, "tsconfig.workspace-contracts.json");
	const config = JSON.stringify({
		compilerOptions: { noResolve: true, noLib: true, types: [] },
		files: files.map(({ file }) => file),
	});
	const api = new API({
		cwd: root,
		fs: {
			fileExists: (file) => (resolve(file) === configPath ? true : undefined),
			readFile: (file) => (resolve(file) === configPath ? config : undefined),
		},
	});
	try {
		const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
		for (const { file, pkg, development, excluded } of files) {
			const source = program.getSourceFile(file);
			const declared = new Set([
				pkg.manifest.name,
				...Object.keys(pkg.manifest.dependencies ?? {}),
				...Object.keys(pkg.manifest.optionalDependencies ?? {}),
				...Object.keys(pkg.manifest.peerDependencies ?? {}),
				...Object.keys(development ? (pkg.manifest.devDependencies ?? {}) : {}),
			]);
			const specifier = (node, runtime) => {
				if (!node || !(isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))) return;
				const value = node.text;
				const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
				const location = `${relative(root, file)}:${line + 1}`;
				if (value.startsWith(".")) {
					if (!/\.(?:ts|mts|cts|json|node)(?:[?#].*)?$/.test(value))
						failures.push(`${location}: relative TypeScript import must use .ts: ${value}`);
					const target = resolve(dirname(file), value.split(/[?#]/)[0]);
					const targetPath = relative(pkg.directory, target);
					if (isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith(`..${sep}`))
						failures.push(`${location}: cross-package source import must use a declared package entry: ${value}`);
					const normalized = targetPath.replaceAll("\\", "/");
					if (
						!development &&
						excluded.some((item) => !item.includes("*") && (normalized === item || normalized.startsWith(`${item}/`)))
					)
						failures.push(`${location}: published source imports a build-excluded module: ${value}`);
					return;
				}
				if (value.startsWith("/") || value.startsWith("cloudflare:") || isBuiltin(value)) return;
				const name = value
					.split("/")
					.slice(0, value.startsWith("@") ? 2 : 1)
					.join("/");
				if (runtime && !declared.has(name))
					failures.push(`${location}: undeclared ${development ? "development" : "runtime"} dependency ${name}`);
				if (name.startsWith("@amazme/") && name !== pkg.manifest.name) {
					if (!packages.has(name)) failures.push(`${location}: unknown workspace package ${name}`);
					else if (layers.get(name) > layers.get(pkg.manifest.name))
						failures.push(`${location}: dependency points upward from ${pkg.manifest.name} to ${name}`);
				}
			};
			const visit = (node) => {
				if (isImportDeclaration(node)) {
					const clause = node.importClause;
					const bindings = clause?.namedBindings;
					const runtime =
						!clause ||
						(clause.phaseModifier !== SyntaxKind.TypeKeyword &&
							(clause.name ||
								!bindings ||
								!isNamedImports(bindings) ||
								bindings.elements.length === 0 ||
								bindings.elements.some((element) => !element.isTypeOnly)));
					specifier(node.moduleSpecifier, Boolean(runtime));
				} else if (isExportDeclaration(node)) {
					const clause = node.exportClause;
					specifier(
						node.moduleSpecifier,
						!node.isTypeOnly &&
							(!clause ||
								!isNamedExports(clause) ||
								clause.elements.length === 0 ||
								clause.elements.some((element) => !element.isTypeOnly)),
					);
				} else if (
					isCallExpression(node) &&
					(node.expression.kind === SyntaxKind.ImportKeyword ||
						(isIdentifier(node.expression) && node.expression.text === "require") ||
						(isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
				) {
					specifier(node.arguments[0], true);
				} else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) specifier(node.argument.literal, false);
				node.forEachChild(visit);
			};
			visit(source);
			const awaits = moduleScopeAwaits(source);
			if (awaits.length > 0 && !declaredEntry(pkg, file)) {
				for (const position of awaits) {
					const { line } = source.getLineAndCharacterOfPosition(position);
					failures.push(
						`${relative(root, file)}:${line + 1}: package source must not await at module scope; move the work into a function`,
					);
				}
			}
		}
	} finally {
		api.close();
	}
	return failures;
}

function runtimeExport(value) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	for (const condition of ["source", "import", "default"]) {
		const found = runtimeExport(value[condition]);
		if (found) return found;
	}
	return undefined;
}

function workspaceResolver(packages, external) {
	return {
		name: "workspace-source",
		setup(builder) {
			builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
				const name = path
					.split("/")
					.slice(0, path.startsWith("@") ? 2 : 1)
					.join("/");
				const pkg = packages.get(name);
				if (!pkg) return external ? { path, external: true } : undefined;
				const subpath = path === name ? "." : `.${path.slice(name.length)}`;
				let target = runtimeExport(pkg.manifest.exports?.[subpath]);
				if (!target) {
					for (const [key, value] of Object.entries(pkg.manifest.exports ?? {})) {
						if (!key.includes("*")) continue;
						const [prefix, suffix] = key.split("*");
						if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
							target = runtimeExport(value)?.replace(
								"*",
								subpath.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length),
							);
							if (target) break;
						}
					}
				}
				if (!target) throw new Error(`No source entry for ${path}`);
				return {
					path: resolve(pkg.directory, target.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts")),
				};
			});
		},
	};
}

/** Public lean entries and the shipped page must remain browser-safe and within their source graph budgets. */
export async function checkEntryContracts(repoRoot) {
	const root = resolve(repoRoot);
	const packages = workspacePackages(root);
	const failures = [];
	const measurements = [];
	for (const budget of [
		{
			entry: "packages/ai/src/models.ts",
			maxFiles: 15,
			forbid: ["packages/ai/src/providers/", "packages/ai/src/models.generated.ts", "packages/ai/src/index.ts"],
		},
		{
			entry: "packages/codemode/src/index.ts",
			maxFiles: 12,
			forbid: ["packages/codemode/src/cloudflare.ts"],
		},
		...["portable", "cloudflare"].map((name) => ({
			entry: `packages/codemode/src/${name}.ts`,
			maxFiles: name === "portable" ? 8 : 9,
			forbid: [
				"packages/codemode/src/index.ts",
				"packages/codemode/src/runtime/host.ts",
				"packages/codemode/src/runtime/worker.ts",
				"packages/codemode/src/wasm.ts",
			],
		})),
		// Product branch summaries/search/file contracts and the new Chord host graph are included.
		{
			entry: "packages/durable/src/index.ts",
			// Chord's default telemetry reaches four leaf modules; Durable adds its host timer adapter.
			maxFiles: 75,
			forbid: ["packages/ai/src/index.ts", "packages/ai/src/utils/typebox-helpers.ts", "packages/durable/src/images/"],
		},
		{
			entry: "packages/durable/src/tools/index.ts",
			// File observations and portable search tools add their document and environment helpers.
			maxFiles: 54,
			forbid: ["packages/durable/src/images/"],
		},
	]) {
		const result = await build({
			entryPoints: [join(root, budget.entry)],
			absWorkingDir: root,
			bundle: true,
			write: false,
			platform: "neutral",
			format: "esm",
			metafile: true,
			logLevel: "silent",
			plugins: [workspaceResolver(packages, true)],
		});
		const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
		measurements.push(`${budget.entry}: ${inputs.length}/${budget.maxFiles} source modules`);
		if (inputs.length > budget.maxFiles)
			failures.push(`${budget.entry}: source graph ${inputs.length} exceeds ${budget.maxFiles}`);
		for (const path of inputs)
			if (budget.forbid.some((forbidden) => path.startsWith(forbidden)))
				failures.push(`${budget.entry}: forbidden runtime import ${path}`);
	}
	for (const entry of [
		"packages/ai/src/models.ts",
		"packages/durable/src/index.ts",
		"packages/durable/src/tools/index.ts",
		"packages/durable/src/codemode/index.ts",
		"packages/codemode/src/portable.ts",
		"packages/codemode/src/cloudflare.ts",
		"packages/coding-agent/src/host/web/page.ts",
	]) {
		try {
			await build({
				entryPoints: [join(root, entry)],
				absWorkingDir: root,
				bundle: true,
				write: false,
				platform: "browser",
				// Wrangler supplies these two modules, but still reject all Node dependencies in Workers entries.
				external: entry.endsWith("/cloudflare.ts") ? ["cloudflare:workers", "quickjs-wasi/quickjs.wasm"] : [],
				format: "esm",
				logLevel: "silent",
				plugins: [workspaceResolver(packages, false)],
			});
			measurements.push(`${entry}: browser bundle passed`);
		} catch (error) {
			failures.push(`${entry}: ${error.message}`);
		}
	}
	return { failures, measurements };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const failures = checkSourceContracts(process.cwd());
	const entries = await checkEntryContracts(process.cwd());
	for (const measurement of entries.measurements) console.log(measurement);
	for (const failure of [...failures, ...entries.failures]) console.error(failure);
	if (failures.length + entries.failures.length > 0) process.exitCode = 1;
	else console.log("Workspace imports, runtime dependencies, direction, browser entries, changelogs, build configs, test and source temp dirs, and version literals passed.");
}
