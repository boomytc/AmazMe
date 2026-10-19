import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertWorkspace } from "../docker/workspace.ts";
import { createTempDir } from "./temp-dir.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function write(root: string, path: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "fixture");
}

function workspace(withDocs = false): string {
	const root = createTempDir("amazme-eval-workspace-");
	directories.push(root);
	for (const path of [
		"package.json",
		"vitest.base.ts",
		"packages/evals/package.json",
		"packages/evals/vitest.evals.config.ts",
		"node_modules/@amazme/coding-agent/package.json",
		"node_modules/@amazme/coding-agent/dist/index.js",
		"node_modules/@amazme/ai/dist/index.js",
	])
		write(root, path);
	for (const directory of ["docker", "evals", "src"])
		mkdirSync(join(root, "packages/evals", directory));
	if (withDocs) {
		for (const path of [
			"README.md",
			"CHANGELOG.md",
			"docs/models.md",
			"examples/README.md",
		])
			write(root, `node_modules/@amazme/coding-agent/${path}`);
	}
	return root;
}

test("accepts both AmazMe artifact variants without an upstream package scope", () => {
	expect(() => assertWorkspace(workspace(), "without_docs")).not.toThrow();
	expect(() => assertWorkspace(workspace(true), "with_docs")).not.toThrow();
});

test.each(["docs/models.md", "README.md", "src/index.ts"])(
	"rejects model-visible internal dependency material: %s",
	(path) => {
		const root = workspace(true);
		write(root, `node_modules/@amazme/ai/${path}`);
		expect(() => assertWorkspace(root, "with_docs")).toThrow(
			"Internal dependency documentation is model-visible",
		);
	},
);

test("rejects documentation in the control variant and missing treatment documentation", () => {
	expect(() => assertWorkspace(workspace(true), "without_docs")).toThrow(
		"without_docs contains coding-agent",
	);
	expect(() => assertWorkspace(workspace(), "with_docs")).toThrow(
		"Missing documentation",
	);
});

test("rejects extra evaluator content and an unknown variant", () => {
	const root = workspace();
	expect(() => assertWorkspace(root, "unknown")).toThrow(
		"no valid AMAZME_EVAL_VARIANT",
	);
	write(root, "unexpected.ts");
	expect(() => assertWorkspace(root, "without_docs")).toThrow(
		"Unexpected eval image contents",
	);
});
