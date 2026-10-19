import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { checkChangelogs, checkDependencyVersions, checkSourceContracts, checkEntryContracts } from "./check-workspace.mjs";

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

test("dependency checks reject registry ranges in every direct section and exact mismatched workspace versions", () => {
	const root = fixture();
	packageFixture(root, "ai", "export {};");
	packageFixture(root, "agent", "export {};", {
		dependencies: { "@amazme/ai": "^1.0.0", external: "~2.0.0" },
		devDependencies: { alias: "npm:@vendor/dep@^1.0.0" },
		optionalDependencies: { "@amazme/ai": "0.9.0" },
	});
	const failures = checkDependencyVersions(root);
	assert.equal(failures.length, 4);
	assert.ok(
		failures.some((message) =>
			message.includes(
				"optionalDependencies.@amazme/ai must match workspace version",
			),
		),
	);
});

test("dependency checks preserve exact registry aliases and non-registry references", () => {
	const root = fixture();
	packageFixture(root, "ai", "export {};");
	packageFixture(root, "agent", "export {};", {
		dependencies: {
			"@amazme/ai": "1.0.0",
			external: "2.0.0-rc.1",
			alias: "npm:@vendor/dep@0.9.0",
		},
		devDependencies: { local: "file:../local", workspace: "workspace:*" },
		optionalDependencies: { git: "git+https://example.com/repo.git" },
	});
	assert.deepEqual(checkDependencyVersions(root), []);
});

test("syntax checks distinguish type-only imports from runtime dependencies and ignore source-looking strings", () => {
	const root = fixture();
	packageFixture(
		root,
		"chord",
		'import type { Value } from "types-only"; import { type Other } from "other-types"; export type { Third } from "third-types"; const sample = "import(\\\"unrelated\\\")"; // import("comment")\nexport const value = 1;',
	);
	assert.deepEqual(checkSourceContracts(root), []);
});

test("Cloudflare runtime modules are built-ins, not npm dependencies", () => {
	const root = fixture();
	packageFixture(
		root,
		"codemode",
		'import { DurableObject } from "cloudflare:workers"; export class Sandbox extends DurableObject {}',
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

test("package sources must not suspend module evaluation with await", () => {
	const root = fixture();
	const directory = packageFixture(root, "ai", "export {};");
	writeFileSync(
		join(directory, "src/flow.ts"),
		'import { readFile } from "node:fs/promises";\nexport const value = await readFile("a");\nif (value) { for await (const part of value) { part; } }\nawait using handle = open();\n',
	);
	const failures = checkSourceContracts(root);
	assert.equal(failures.filter((failure) => failure.includes("must not await at module scope")).length, 3);
});

test("await inside functions, methods, and arrows does not suspend the module", () => {
	const root = fixture();
	const directory = packageFixture(root, "ai", "export {};");
	writeFileSync(
		join(directory, "src/flow.ts"),
		'async function a() { await b(); }\nexport const c = async () => { await d(); };\nclass E { async f() { for await (const g of h) { g; } } }\n',
	);
	assert.deepEqual(checkSourceContracts(root), []);
});

test("only bins and shebang entries may await at module scope", () => {
	const root = fixture();
	const directory = packageFixture(root, "ai", "export {};", { bin: { tool: "./dist/cli.js" } });
	writeFileSync(join(directory, "src/cli.ts"), 'await import("./index.ts");\n');
	writeFileSync(join(directory, "src/hook.ts"), '#!/usr/bin/env node\nawait import("./index.ts");\n');
	assert.deepEqual(checkSourceContracts(root), []);
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
	const codemode = packageFixture(root, "codemode", 'export { value } from "./cloudflare.ts";');
	mkdirSync(join(codemode, "src/runtime"), { recursive: true });
	writeFileSync(
		join(codemode, "src/runtime/host.ts"),
		'import fs from "node:fs"; export const value = fs.readFileSync;',
	);
	writeFileSync(join(codemode, "src/portable.ts"), 'export { value } from "./runtime/host.ts";');
	writeFileSync(join(codemode, "src/cloudflare.ts"), 'export { value } from "./portable.ts";');
	const ai = packageFixture(root, "ai", "export const value = 1;");
	writeFileSync(join(ai, "src/models.ts"), 'export { value } from "./index.ts";');
	const durable = packageFixture(root, "durable", 'import fs from "node:fs"; export const read = fs.readFileSync;');
	mkdirSync(join(durable, "src/codemode"), { recursive: true });
	writeFileSync(join(durable, "src/codemode/index.ts"), 'import fs from "node:fs"; export const read = fs.readFileSync;');
	mkdirSync(join(durable, "src/tools"), { recursive: true });
	writeFileSync(join(durable, "src/tools/index.ts"), "export const value = 1;");
	const agent = packageFixture(root, "coding-agent", "export const value = 1;");
	mkdirSync(join(agent, "src/host/web"), { recursive: true });
	writeFileSync(join(agent, "src/host/web/page.ts"), 'import fs from "node:fs"; export const read = fs.readFileSync;');
	const { failures } = await checkEntryContracts(root);
	assert.ok(failures.some((failure) => failure.includes("forbidden runtime import packages/ai/src/index.ts")));
	assert.ok(
		failures.some(
			(failure) =>
				failure.startsWith("packages/codemode/src/index.ts:") &&
				failure.includes("forbidden runtime import packages/codemode/src/cloudflare.ts"),
		),
	);
	for (const name of ["portable", "cloudflare"]) {
		assert.ok(
			failures.some(
				(failure) =>
					failure.startsWith(`packages/codemode/src/${name}.ts:`) &&
					failure.includes("forbidden runtime import packages/codemode/src/runtime/host.ts"),
			),
		);
		assert.ok(
			failures.some(
				(failure) => failure.startsWith(`packages/codemode/src/${name}.ts:`) && failure.includes("node:fs"),
			),
		);
	}
	for (const entry of ["index.ts", "codemode/index.ts"]) {
		assert.ok(failures.some((failure) => failure.startsWith(`packages/durable/src/${entry}:`) && failure.includes("node:fs")));
	}
	assert.ok(
		failures.some(
			(failure) => failure.startsWith("packages/coding-agent/src/host/web/page.ts:") && failure.includes("node:fs"),
		),
	);
});

test("Durable root and file tools keep the optional Photon processor in its own entry", async () => {
	const root = fixture();
	const ai = packageFixture(root, "ai", "export const value = 1;");
	writeFileSync(join(ai, "src/models.ts"), "export const value = 1;");
	const codemode = packageFixture(root, "codemode", "export const value = 1;");
	for (const name of ["portable", "cloudflare"])
		writeFileSync(join(codemode, `src/${name}.ts`), "export const value = 1;");
	const agent = packageFixture(root, "coding-agent", "export const value = 1;");
	mkdirSync(join(agent, "src/host/web"), { recursive: true });
	writeFileSync(join(agent, "src/host/web/page.ts"), "export const value = 1;");
	const durable = packageFixture(root, "durable", 'export { photon } from "./images/index.ts";');
	mkdirSync(join(durable, "src/codemode"), { recursive: true });
	writeFileSync(join(durable, "src/codemode/index.ts"), "export const value = 1;");
	mkdirSync(join(durable, "src/images"), { recursive: true });
	mkdirSync(join(durable, "src/tools"), { recursive: true });
	writeFileSync(join(durable, "src/images/index.ts"), "export const photon = 1;");
	writeFileSync(join(durable, "src/tools/index.ts"), 'export { photon } from "../images/index.ts";');
	const { failures } = await checkEntryContracts(root);
	for (const entry of ["index.ts", "tools/index.ts"])
		assert.ok(failures.some((failure) => failure.startsWith(`packages/durable/src/${entry}:`) && failure.includes("forbidden runtime import packages/durable/src/images/index.ts")));
	writeFileSync(join(durable, "src/index.ts"), "export const value = 1;");
	writeFileSync(join(durable, "src/tools/index.ts"), "export const value = 1;");
	assert.deepEqual((await checkEntryContracts(root)).failures, []);
});

function changelogFixture(root, name, text) {
	mkdirSync(join(root, "packages", name), { recursive: true });
	writeFileSync(join(root, "packages", name, "CHANGELOG.md"), text);
}

test("changelog checks accept the shared headings in order and leave older sections as written", () => {
	const root = fixture();
	changelogFixture(
		root,
		"agent",
		"# Changelog\n\n## [Unreleased]\n\n### Breaking Changes\n\n- a\n\n### Fixed\n\n- b\n\n## [1.1.0] - 2026-10-07\n\n### Added\n\n- c\n\n## [1.0.0] - 2026-10-01\n\n### New Features\n\n- d\n",
	);
	changelogFixture(root, "ai", "# Changelog\n\n## [Unreleased]\n");
	assert.deepEqual(checkChangelogs(root), []);
});

test("changelog checks reject unknown, repeated, out-of-order, and empty sections and malformed release headings", () => {
	const root = fixture();
	changelogFixture(
		root,
		"agent",
		"# Changelog\n\n## [Unreleased]\n\n### 修复\n\n- a\n\n### Fixed\n\n- b\n\n### Added\n\n- c\n\n### Fixed\n\n## [1.1.0]\n\n### Removed\n\n- d\n",
	);
	changelogFixture(root, "ai", "Changelog\n\n## [1.0.0] - 2026-10-01\n");
	const failures = checkChangelogs(root);
	assert.equal(failures.length, 7, failures.join("\n"));
	for (const fragment of [
		'agent/CHANGELOG.md:5: section must be one of',
		'agent/CHANGELOG.md:13: "Added" is repeated or out of order',
		'agent/CHANGELOG.md:17: "Fixed" is repeated or out of order',
		'agent/CHANGELOG.md:17: "Fixed" has no entries',
		'agent/CHANGELOG.md:19: release heading must read',
		'ai/CHANGELOG.md: first line must be "# Changelog"',
		'ai/CHANGELOG.md:3: first section must be "## [Unreleased]"',
	])
		assert.ok(failures.some((failure) => failure.includes(fragment)), `missing ${fragment} in\n${failures.join("\n")}`);
});
