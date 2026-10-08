import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { checkSourceContracts, checkEntryContracts } from "./check-workspace.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "amazme-contracts-"));
	roots.push(root);
	mkdirSync(join(root, "packages"));
	return root;
}

function packageFixture(root, name, source, metadata = {}) {
	const directory = join(root, "packages", name);
	mkdirSync(join(directory, "src"), { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: `@amazme/${name}`,
			version: "1.0.0",
			exports: { ".": { source: "./src/index.ts" } },
			...metadata,
		}),
	);
	writeFileSync(join(directory, "src/index.ts"), source);
	return directory;
}

test("syntax checks distinguish type-only imports from runtime dependencies and ignore source-looking strings", () => {
	const root = fixture();
	packageFixture(
		root,
		"chord",
		'import type { Value } from "types-only"; import { type Other } from "other-types"; export type { Third } from "third-types"; const sample = "import(\\\"unrelated\\\")"; // import("comment")\nexport const value = 1;',
	);
	assert.deepEqual(checkSourceContracts(root), []);
});

test("side effects, mixed imports, re-exports, dynamic imports and require must declare runtime dependencies", () => {
	const root = fixture();
	packageFixture(
		root,
		"chord",
		'import "side-effect"; import { type Shape, value } from "mixed"; export { value } from "re-export"; import("dynamic"); require("commonjs"); require.resolve("resolved");',
	);
	const failures = checkSourceContracts(root);
	for (const name of ["side-effect", "mixed", "re-export", "dynamic", "commonjs", "resolved"])
		assert.ok(
			failures.some((failure) => failure.endsWith(`dependency ${name}`)),
			name,
		);
});

test("relative imports, including type expressions, keep TypeScript extensions and package ownership", () => {
	const root = fixture();
	packageFixture(
		root,
		"chord",
		'import "./old.js"; export { value } from "./extensionless"; type Shape = import("./types.js").Value; import "../../ai/src/index.ts";',
	);
	const failures = checkSourceContracts(root);
	assert.equal(failures.filter((failure) => failure.includes("must use .ts")).length, 3);
	assert.ok(failures.some((failure) => failure.includes("cross-package source import")));
});

test("foundations cannot depend upward and runtime dependency cycles are refused", () => {
	const root = fixture();
	packageFixture(root, "chord", 'import type { Model } from "@amazme/ai";', {
		dependencies: { "@amazme/ai": "1.0.0" },
	});
	packageFixture(root, "ai", "export const value = 1;", {
		dependencies: { "@amazme/chord": "1.0.0" },
	});
	const failures = checkSourceContracts(root);
	assert.ok(failures.some((failure) => failure.includes("points upward")));
	assert.ok(failures.some((failure) => failure.includes("dependency cycle")));
});

test("manifest dependencies cannot point upward even when source does not import them", () => {
	const root = fixture();
	packageFixture(root, "chord", "export const value = 1;", {
		dependencies: { "@amazme/ai": "1.0.0" },
	});
	packageFixture(root, "ai", "export const value = 1;");
	assert.ok(
		checkSourceContracts(root).some(
			(failure) => failure.startsWith("packages/chord/package.json:") && failure.includes("points upward"),
		),
	);
});

test("development dependencies are accepted only in private or build-excluded source", () => {
	const root = fixture();
	const directory = packageFixture(root, "coding-agent", 'import "development";', {
		devDependencies: { development: "1.0.0" },
	});
	assert.ok(checkSourceContracts(root).some((failure) => failure.includes("undeclared runtime")));
	writeFileSync(join(directory, "tsconfig.build.json"), JSON.stringify({ exclude: ["src/index.ts"] }));
	assert.deepEqual(checkSourceContracts(root), []);
});

test("published entries cannot pull excluded implementation modules back into the artifact", () => {
	const root = fixture();
	const directory = packageFixture(root, "coding-agent", 'export type { Shape } from "./experimental.ts";');
	writeFileSync(join(directory, "src/experimental.ts"), "export type Shape = { value: string };");
	writeFileSync(join(directory, "tsconfig.build.json"), JSON.stringify({ exclude: ["src/experimental.ts"] }));
	assert.ok(
		checkSourceContracts(root).some((failure) => failure.includes("published source imports a build-excluded module")),
	);
});

test("production entry checks reject Node-only browser imports and heavy lean-entry graphs", async () => {
	const root = fixture();
	const ai = packageFixture(root, "ai", "export const value = 1;");
	writeFileSync(join(ai, "src/models.ts"), 'export { value } from "./index.ts";');
	packageFixture(root, "durable", 'import fs from "node:fs"; export const read = fs.readFileSync;');
	const agent = packageFixture(root, "coding-agent", "export const value = 1;");
	mkdirSync(join(agent, "src/experimental/web"), { recursive: true });
	writeFileSync(
		join(agent, "src/experimental/web/page.ts"),
		'import fs from "node:fs"; export const read = fs.readFileSync;',
	);
	const { failures } = await checkEntryContracts(root);
	assert.ok(failures.some((failure) => failure.includes("forbidden runtime import packages/ai/src/index.ts")));
	assert.ok(
		failures.some((failure) => failure.startsWith("packages/durable/src/index.ts:") && failure.includes("node:fs")),
	);
	assert.ok(
		failures.some(
			(failure) =>
				failure.startsWith("packages/coding-agent/src/experimental/web/page.ts:") && failure.includes("node:fs"),
		),
	);
});
