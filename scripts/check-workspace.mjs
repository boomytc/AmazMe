import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
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

/** Syntax-aware checks over source, including development-only host and browser modules. */
export function checkSourceContracts(repoRoot) {
	const root = resolve(repoRoot);
	const packages = workspacePackages(root);
	const failures = [];
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
				if (value.startsWith("/") || isBuiltin(value)) return;
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
		// Branch summaries, the name matcher, and the leaf file-error contract add three modules to Pi's 63-module root.
		{
			entry: "packages/durable/src/index.ts",
			maxFiles: 67,
			forbid: ["packages/ai/src/index.ts", "packages/ai/src/utils/typebox-helpers.ts"],
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
		"packages/coding-agent/src/host/web/page.ts",
	]) {
		try {
			await build({
				entryPoints: [join(root, entry)],
				absWorkingDir: root,
				bundle: true,
				write: false,
				platform: "browser",
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
	else console.log("Workspace imports, runtime dependencies, direction, and browser entries passed.");
}
