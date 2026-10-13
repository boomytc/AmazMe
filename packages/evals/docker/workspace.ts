import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assertDirectoryEntries(
	path: string,
	expectedEntries: readonly string[],
): void {
	const actual = readdirSync(path).sort();
	const expected = [...expectedEntries].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`Unexpected eval image contents in ${path}: ${actual.join(", ")}`,
		);
	}
}

export function assertWorkspace(
	root: string,
	variant: string | undefined,
): void {
	assertDirectoryEntries(root, [
		"node_modules",
		"package.json",
		"packages",
		"vitest.base.ts",
	]);
	assertDirectoryEntries(join(root, "packages"), ["evals"]);
	assertDirectoryEntries(join(root, "packages/evals"), [
		"docker",
		"evals",
		"package.json",
		"src",
		"vitest.evals.config.ts",
	]);
	const codingAgentDir = join(root, "node_modules/@amazme/coding-agent");
	for (const name of ["package.json", "dist/index.js"]) {
		if (!existsSync(join(codingAgentDir, name)))
			throw new Error(`Installed coding-agent is missing ${name}.`);
	}
	const internalScope = join(root, "node_modules/@amazme");
	for (const packageName of readdirSync(internalScope)) {
		if (packageName === "coding-agent") continue;
		const packageDirectory = join(internalScope, packageName);
		for (const entry of readdirSync(packageDirectory, {
			withFileTypes: true,
		})) {
			if (
				(entry.isDirectory() &&
					["docs", "examples", "src", "test", "tests"].includes(entry.name)) ||
				(entry.isFile() && /^(?:readme|changelog)(?:\..+)?$/i.test(entry.name))
			) {
				throw new Error(
					`Internal dependency documentation is model-visible: ${packageName}/${entry.name}`,
				);
			}
		}
	}
	if (variant === "without_docs") {
		for (const name of ["README.md", "CHANGELOG.md", "docs", "examples"]) {
			if (existsSync(join(codingAgentDir, name)))
				throw new Error(`without_docs contains coding-agent ${name}.`);
		}
		return;
	}
	if (variant !== "with_docs")
		throw new Error("Eval image has no valid AMAZME_EVAL_VARIANT.");
	for (const path of [
		join(codingAgentDir, "README.md"),
		join(codingAgentDir, "CHANGELOG.md"),
		join(codingAgentDir, "docs/models.md"),
		join(codingAgentDir, "examples/README.md"),
	]) {
		if (!existsSync(path) || readFileSync(path).length === 0)
			throw new Error(`Missing documentation: ${path}`);
	}
}
