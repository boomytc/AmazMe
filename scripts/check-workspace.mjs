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
	["@amazme/codemode", 0],
	["@amazme/tui", 0],
	["@amazme/web", 3],
	["@amazme/gui", 6],
	["@amazme/coding-agent", 5],
	["@amazme/evals", 6],
]);

/**
 * Complete ownership of the CLI package's internal modules. A role lists every role its modules may
 * reach, including indirectly: the check walks the internal import graph, so client -> utils -> modes
 * fails instead of hiding behind a neutral helper. Every source file needs a role, so a new directory
 * cannot quietly escape the model.
 */
const codingAgentRoleRules = new Map([
	[
		"entry",
		["entry", "interactive", "headless", "connection", "client", "cli", "product", "media", "presentation", "neutral"],
	],
	["interactive", ["interactive", "connection", "client", "cli", "media", "presentation", "neutral"]],
	["headless", ["headless", "connection", "client", "cli", "neutral"]],
	["connection", ["connection", "client", "neutral"]],
	["cli", ["cli", "client", "media", "neutral"]],
	["client", ["client", "neutral"]],
	["product", ["product", "connection", "client", "neutral"]],
	["media", ["media", "neutral"]],
	["presentation", ["presentation", "media", "neutral"]],
	["neutral", ["neutral"]],
]);

const codingAgentModuleRoles = new Map([
	...["main.ts", "index.ts", "cli.ts", "rpc-entry.ts"].map((path) => [path, "entry"]),
	["python-product.ts", "product"],
	...[
		"config.ts",
		"source-resolver.ts",
		"update-check.ts",
		"update-manifest.ts",
		"utils/paths.ts",
		"utils/text.ts",
		"utils/fs-watch.ts",
		"utils/open-browser.ts",
		"utils/version-check.ts",
		"utils/wsl.ts",
	].map((path) => [path, "neutral"]),
	...[
		"utils/photon.ts",
		"utils/exif-orientation.ts",
		"utils/image-convert.ts",
		"utils/image-process.ts",
		"utils/image-resize-core.ts",
		"utils/image-resize-worker.ts",
		"utils/image-resize.ts",
		"utils/mime.ts",
	].map((path) => [path, "media"]),
	...[
		"utils/clipboard.ts",
		"utils/clipboard-command.ts",
		"utils/clipboard-paste.ts",
		"utils/highlight-js.d.ts",
		"utils/html.ts",
		"utils/syntax-highlight.ts",
	].map((path) => [path, "presentation"]),
]);

const codingAgentRolePrefixes = [
	["client/", "client"],
	["connection/", "connection"],
	["cli/", "cli"],
	["modes/headless/", "headless"],
	["modes/interactive/", "interactive"],
];

/** The role of one source path relative to the CLI package's src directory. */
function codingAgentRole(sourcePath) {
	const exact = codingAgentModuleRoles.get(sourcePath);
	if (exact) return exact;
	for (const [prefix, role] of codingAgentRolePrefixes) if (sourcePath.startsWith(prefix)) return role;
	return undefined;
}

/**
 * Every module must stay inside the roles it may reach. Indirect routes are reported with the whole
 * chain, which names the real files and the role the origin is not allowed to depend on.
 */
function codingAgentRoleFailures(root, entries, edges) {
	const failures = [];
	const roles = new Map();
	for (const { file, sourcePath } of entries) {
		const role = codingAgentRole(sourcePath);
		if (!role) {
			failures.push(
				`${relative(root, file)}: needs an explicit role in codingAgentModuleRoles or codingAgentRolePrefixes`,
			);
			continue;
		}
		roles.set(file, role);
	}
	for (const { file } of entries) {
		const role = roles.get(file);
		if (!role) continue;
		const allowed = new Set(codingAgentRoleRules.get(role));
		const seen = new Set([file]);
		const queue = [[file]];
		let violation;
		while (queue.length > 0 && !violation) {
			const chain = queue.shift();
			for (const target of edges.get(chain.at(-1)) ?? []) {
				if (seen.has(target)) continue;
				seen.add(target);
				const targetRole =
					roles.get(target) ?? codingAgentRole(relative(entries[0].sourceRoot, target).replaceAll("\\", "/"));
				if (!targetRole) continue;
				const next = [...chain, target];
				if (!allowed.has(targetRole)) {
					violation = next;
					break;
				}
				queue.push(next);
			}
		}
		if (violation)
			failures.push(
				`${relative(root, violation[0])} reaches ${roles.get(violation.at(-1))} through ` +
					`${violation.map((path) => relative(root, path)).join(" -> ")}; ` +
					`${role} may only reach ${[...allowed].join(", ")}`,
			);
	}
	return failures;
}

function sourceFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? sourceFiles(path)
			: /\.(?:[cm]?ts|tsx)$/.test(entry.name)
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
export function checkDependencyVersions(repoRoot, packages = workspacePackages(repoRoot)) {
	const files = [];
	const rootManifest = join(repoRoot, "package.json");
	if (existsSync(rootManifest)) files.push(rootManifest);
	const collect = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name))
				collect(join(directory, entry.name));
			else if (entry.isFile() && entry.name === "package.json") files.push(join(directory, entry.name));
		}
	};
	collect(join(repoRoot, "packages"));
	const failures = [];
	const exact = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
	for (const file of files) {
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
			for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
				if (/^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:)/.test(specifier)) continue;
				const alias = specifier.startsWith("npm:");
				const version = alias ? specifier.slice(specifier.lastIndexOf("@") + 1) : specifier;
				const location = `${relative(repoRoot, file)}: ${section}.${name}`;
				if (!exact.test(version)) failures.push(`${location} must be pinned, found ${specifier}`);
				else if (!alias && packages.has(name) && version !== packages.get(name).manifest.version)
					failures.push(
						`${location} must match workspace version ${packages.get(name).manifest.version}, found ${version}`,
					);
			}
		}
	}
	return failures;
}

export function checkProductVersions(repoRoot, packages = workspacePackages(repoRoot)) {
	const manifest = join(repoRoot, "package.json");
	if (!existsSync(manifest)) return [];
	const version = JSON.parse(readFileSync(manifest, "utf8")).version;
	if (typeof version !== "string") return [];
	const failures = [];
	for (const [name, pkg] of packages) {
		if (pkg.manifest.version !== version)
			failures.push(`${name}: product version must match root ${version}, found ${pkg.manifest.version}`);
	}
	const backend = join(repoRoot, "backend/pyproject.toml");
	if (existsSync(backend)) {
		const project = readFileSync(backend, "utf8").split(/^\[project\]\s*$/m)[1]?.split(/^\[/m)[0];
		const backendVersion = project?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
		if (backendVersion !== version)
			failures.push(`backend/pyproject.toml: product version must match root ${version}, found ${backendVersion}`);
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
					failures.push(
						`${location}:${index + 1}: section must be one of ${changelogSections.join(", ")}, found "${name}"`,
					);
				else if (order <= previous)
					failures.push(
						`${location}:${index + 1}: "${name}" is repeated or out of order (${changelogSections.join(", ")})`,
					);
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
/** A version pinned to an external scoped package, such as `@scope/tool@1.2.3`, is that package's version. */
const versionLiteralScopedPackage = /@[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*@$/;

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
					const before = line.slice(0, match.index);
					if (thirdParty.test(before) || versionLiteralScopedPackage.test(before)) continue;
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
	"packages/coding-agent/src/utils/clipboard.ts": "WSL clipboard hand-off file",
	"packages/tui/src/tui-main-screen.ts": "crash log fallback when no log directory is set",
};

/**
 * Package sources (`packages/<pkg>/src`) may not call `tmpdir()` / `os.tmpdir()`
 * outside `allowed` (repo-relative path -> reason). Every entry is one exact source file with a
 * non-empty reason: no directories, no globs. An entry goes stale, and fails, when its file no longer
 * calls `tmpdir()`; {@link checkTempDirAllowlistFiles} fails one whose file is gone.
 */
export function checkTempDirUsage(repoRoot, allowed = sourceTempDirAllowlist) {
	const failures = [];
	const packagesDirectory = join(repoRoot, "packages");
	if (!existsSync(packagesDirectory)) return failures;
	const tmpdirCall = /\btmpdir\s*\(/;
	const sourceExtensions = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;
	const exactSourceFile = /^packages\/[^/*?[\]{}]+\/src\/[^*?[\]{}]+\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;
	for (const [file, reason] of Object.entries(allowed)) {
		if (
			!exactSourceFile.test(file) ||
			file.endsWith(".d.ts") ||
			file.split("/").some((part) => part === "." || part === "..")
		) {
			failures.push(
				`${file}: sourceTempDirAllowlist entries must be one exact packages/<pkg>/src/... source file, not a directory or pattern`,
			);
			continue;
		}
		if (typeof reason !== "string" || reason.trim().length === 0)
			failures.push(`${file}: sourceTempDirAllowlist entry needs a reason`);
	}
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
	for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
		if (entry.isDirectory()) walkSource(join(packagesDirectory, entry.name, "src"));
	}
	return failures;
}

/**
 * Every `sourceTempDirAllowlist` entry names a file in this repository. A deleted or moved file is
 * never visited by {@link checkTempDirUsage}, so without this its stale entry would stay silently.
 */
export function checkTempDirAllowlistFiles(repoRoot, allowed = sourceTempDirAllowlist) {
	return Object.keys(allowed)
		.filter((file) => !existsSync(join(repoRoot, file)))
		.map(
			(file) =>
				`${file}: listed in sourceTempDirAllowlist but no such source file; remove it from sourceTempDirAllowlist`,
		);
}

/** Keep permanent regression suites out of the workspace; model evaluation is a product capability. */
export function checkDevelopmentAssets(repoRoot) {
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
	}).split("\0").filter((file) => file && existsSync(join(repoRoot, file)));
	const suite = /(?:^|\/)(?:tests?|__tests__|__mocks__|__snapshots__|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py|conftest\.py|pytest\.ini|tsconfig\.test\.json|vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s)$/;
	const failures = files.filter((file) => file !== "packages/evals/vitest.evals.config.ts" && suite.test(file))
		.map((file) => `${file}: permanent test asset; use disposable verification under a temporary or ignored directory`);
	for (const file of files.filter((file) => file === "package.json" || /^packages\/[^/]+\/package\.json$/.test(file))) {
		const manifest = JSON.parse(readFileSync(join(repoRoot, file), "utf8"));
		for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
			const evaluation = file === "packages/evals/package.json" && /^eval(?::|$)/.test(name);
			if (/^test(?::|$)/.test(name) || (!evaluation && /(?:^|\s)(?:vitest|pytest)(?:\s|$)|node\s+--test/.test(command)))
				failures.push(`${file}: scripts.${name} is a permanent test entry; keep build, type and artifact checks`);
		}
		for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
			if (/^(?:vitest|@vitest\/[^/]+|happy-dom|jsdom|@playwright\/test|@xterm\/headless)$/.test(name) && !(name === "vitest" && file === "packages/evals/package.json"))
				failures.push(`${file}: ${name} is a test-only dependency`);
		}
	}
	const pyproject = join(repoRoot, "backend/pyproject.toml");
	if (existsSync(pyproject)) {
		const config = JSON.parse(execFileSync(join(repoRoot, "backend/.venv/bin/python"), ["-I", "-c", `
import json, sys, tomllib
from pathlib import Path
data = tomllib.loads(Path(sys.argv[1]).read_text())
project = data.get("project", {})
groups = [project.get("dependencies", []), data.get("build-system", {}).get("requires", [])]
groups.extend(project.get("optional-dependencies", {}).values())
groups.extend(data.get("dependency-groups", {}).values())
print(json.dumps({"dependencies": [item for group in groups for item in group if isinstance(item, str)],
                  "pytest_config": "pytest" in data.get("tool", {})}))
`, pyproject], { encoding: "utf8" }));
		for (const dependency of config.dependencies) {
			const name = dependency.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0].toLowerCase().replaceAll("_", "-");
			if (/^(?:pytest(?:-|$)|tox$|hypothesis$|coverage$)/.test(name ?? ""))
				failures.push(`backend/pyproject.toml: ${name} is a test-only dependency`);
		}
		if (config.pytest_config) failures.push("backend/pyproject.toml: remove permanent pytest configuration");
	}
	return failures;
}

/** Syntax-aware checks over source, including development-only host and browser modules. */
export function checkSourceContracts(repoRoot) {
	const root = resolve(repoRoot);
	const packages = workspacePackages(root);
	const failures = [
		...checkDevelopmentAssets(root),
		...checkDependencyVersions(root, packages),
		...checkProductVersions(root, packages),
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
		const codingAgentEdges = new Map();
		const codingAgentEntries = [];
		for (const { file, pkg, development, excluded } of files) {
			const source = program.getSourceFile(file);
			const sourceRoot = join(pkg.directory, "src");
			const sourcePath = relative(sourceRoot, file).replaceAll("\\", "/");
			if (pkg.manifest.name === "@amazme/coding-agent")
				codingAgentEntries.push({ file, sourcePath, sourceRoot });
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
					if (!/\.(?:ts|tsx|mts|cts|json|node)(?:[?#].*)?$/.test(value))
						failures.push(`${location}: relative TypeScript import must use .ts or .tsx: ${value}`);
					const target = resolve(dirname(file), value.split(/[?#]/)[0]);
					const targetPath = relative(pkg.directory, target);
					if (isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith(`..${sep}`))
						failures.push(`${location}: cross-package source import must use a declared package entry: ${value}`);
					const normalized = targetPath.replaceAll("\\", "/");
					if (pkg.manifest.name === "@amazme/coding-agent" && normalized.startsWith("src/")) {
						const targetSource = normalized.slice("src/".length);
						if (/\.(?:[cm]?ts)$/.test(targetSource)) {
							const reached = codingAgentEdges.get(file) ?? new Set();
							reached.add(resolve(target));
							codingAgentEdges.set(file, reached);
						}
						if (targetSource === "index.ts" && sourcePath !== "index.ts")
							failures.push(
								`${location}: ${value} imports this package's public entry; import a concrete module instead`,
							);
					}
					if (
						!development &&
						excluded.some((item) => !item.includes("*") && (normalized === item || normalized.startsWith(`${item}/`)))
					)
						failures.push(`${location}: published source imports a build-excluded module: ${value}`);
					return;
				}
				if (value.startsWith("/") || value.startsWith("cloudflare:") || isBuiltin(value)) return;
				if (
					pkg.manifest.name === "@amazme/coding-agent" &&
					(value === pkg.manifest.name || value.startsWith(`${pkg.manifest.name}/`))
				) {
					failures.push(
						`${location}: ${value} imports this package through its public exports; use a relative module instead`,
					);
					const reached = codingAgentEdges.get(file) ?? new Set();
					reached.add(join(pkg.directory, "src", "index.ts"));
					codingAgentEdges.set(file, reached);
				}
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
		if (codingAgentEntries.length > 0)
			failures.push(...codingAgentRoleFailures(root, codingAgentEntries, codingAgentEdges));
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
	for (const entry of ["packages/coding-agent/src/rpc-entry.ts"]) {
		try {
			const result = await build({
				entryPoints: [join(root, entry)],
				absWorkingDir: root,
				bundle: true,
				splitting: true,
				write: false,
				outdir: join(root, ".workspace-contract-rpc"),
				platform: "node",
				format: "esm",
				metafile: true,
				logLevel: "silent",
				plugins: [
					{
						name: "rpc-tui-external",
						setup(builder) {
							builder.onResolve({ filter: /^@amazme\/tui(?:\/|$)/ }, ({ path }) => ({ path, external: true }));
						},
					},
					workspaceResolver(packages, true),
				],
			});
			const outputs = result.metafile.outputs;
			const first = Object.entries(outputs).find(([, output]) => output.entryPoint?.replaceAll("\\", "/") === entry);
			if (!first) throw new Error("RPC entry output is missing");
			const pending = [first[0]];
			const visited = new Set();
			const sources = new Set();
			while (pending.length > 0) {
				const name = pending.pop();
				if (visited.has(name)) continue;
				visited.add(name);
				const output = outputs[name];
				if (!output) throw new Error(`RPC output dependency is missing: ${name}`);
				for (const input of Object.keys(output.inputs)) {
					const path = input.replaceAll("\\", "/");
					if (path.startsWith("packages/coding-agent/src/") && /\.(?:[cm]?ts)$/.test(path)) sources.add(path);
				}
				for (const dependency of output.imports) {
					if (dependency.kind !== "import-statement") continue;
					if (!dependency.external) pending.push(dependency.path);
					else if (dependency.path === "@amazme/tui" || dependency.path.startsWith("@amazme/tui/"))
						failures.push(`${entry}: presentation dependency in the RPC startup graph ${dependency.path}`);
				}
			}
			measurements.push(`${entry}: ${sources.size}/12 startup source modules`);
			if (sources.size > 12) failures.push(`${entry}: startup source graph ${sources.size} exceeds 12`);
			for (const path of sources)
				if (
					path.includes("modes/interactive/") ||
					path.endsWith("cli/file-processor.ts") ||
					/utils\/(?:image-|photon)/.test(path)
				)
					failures.push(`${entry}: presentation or media module in the RPC entry graph ${path}`);
		} catch (error) {
			failures.push(`${entry}: ${error.message}`);
		}
	}
	const lightweightWebEntries = ["errors", "locale", "strings", "typography"].map(name => `packages/web/src/${name}.ts`);
	for (const entry of [
		...lightweightWebEntries,
		"packages/web/src/index.ts",
		"packages/web/src/page.ts",
		"packages/codemode/src/portable.ts",
		"packages/codemode/src/cloudflare.ts",
	]) {
		try {
			const result = await build({
				entryPoints: [join(root, entry)],
				absWorkingDir: root,
				bundle: true,
				write: false,
				platform: "browser",
				// Wrangler supplies these two modules, but still reject all Node dependencies in Workers entries.
				external: entry.endsWith("/cloudflare.ts") ? ["cloudflare:workers", "quickjs-wasi/quickjs.wasm"] : [],
				format: "esm",
				...(entry === "packages/web/src/page.ts" ? { jsx: "automatic" } : {}),
				metafile: true,
				logLevel: "silent",
				plugins: [workspaceResolver(packages, false)],
			});
			if (lightweightWebEntries.includes(entry)) {
				for (const path of Object.keys(result.metafile.inputs).map((input) => `/${input.replaceAll("\\", "/")}`))
					if (/\/node_modules\/(?:react|react-dom|scheduler)(?:\/|$)/.test(path))
						failures.push(`${entry}: React runtime leaked into the lightweight export ${path.slice(1)}`);
			}
			measurements.push(`${entry}: browser bundle passed`);
		} catch (error) {
			failures.push(`${entry}: ${error.message}`);
		}
	}
	return { failures, measurements };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const failures = [...checkSourceContracts(process.cwd()), ...checkTempDirAllowlistFiles(process.cwd())];
	try {
		const output = execFileSync(
			join(process.cwd(), "backend/.venv/bin/python"),
			[join(process.cwd(), "backend/tools/check_architecture.py")],
			{ cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
		);
		console.log(output.trim());
	} catch (error) {
		failures.push(error.stdout?.trim() || error.message);
	}
	const entries = await checkEntryContracts(process.cwd());
	for (const measurement of entries.measurements) console.log(measurement);
	for (const failure of [...failures, ...entries.failures]) console.error(failure);
	if (failures.length + entries.failures.length > 0) process.exitCode = 1;
	else
		console.log(
			"Workspace imports, runtime dependencies, direction, browser entries, changelogs, build configs, development assets, source temp dirs, and version literals passed.",
		);
}
