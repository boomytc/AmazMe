import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
	checkBuildConfigs,
	checkChangelogs,
	checkDependencyVersions,
	checkProductVersions,
	checkSourceContracts,
	checkEntryContracts,
	checkTempDirAllowlistFiles,
	checkTempDirUsage,
	checkVersionLiterals,
	sourceTempDirAllowlist,
} from "./check-workspace.mjs";

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

/** Write one nested source file of an existing package fixture. */
function packageSource(root, name, path, source) {
	const file = join(root, "packages", name, "src", path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
	return file;
}

test("product versions reject mixed desktop, client and backend release lines", () => {
	const root = fixture();
	writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
	packageFixture(root, "gui", "export {};", { version: "2.0.0" });
	packageFixture(root, "web", "export {};", { version: "1.0.0" });
	mkdirSync(join(root, "backend"));
	writeFileSync(join(root, "backend/pyproject.toml"), '[project]\nversion = "1.0.0"\n');
	assert.equal(checkProductVersions(root).length, 2);
	packageFixture(root, "web", "export {};", { version: "2.0.0" });
	writeFileSync(join(root, "backend/pyproject.toml"), '[project]\nversion = "2.0.0"\n');
	assert.deepEqual(checkProductVersions(root), []);
});

test("dependency checks reject registry ranges in every direct section and exact mismatched workspace versions", () => {
	const root = fixture();
	packageFixture(root, "web", "export {};");
	packageFixture(root, "agent", "export {};", {
		dependencies: { "@amazme/web": "^1.0.0", external: "~2.0.0" },
		devDependencies: { alias: "npm:@vendor/dep@^1.0.0" },
		optionalDependencies: { "@amazme/web": "0.9.0" },
	});
	const failures = checkDependencyVersions(root);
	assert.equal(failures.length, 4);
	assert.ok(
		failures.some((message) => message.includes("optionalDependencies.@amazme/web must match workspace version")),
	);
});

test("dependency checks preserve exact registry aliases and non-registry references", () => {
	const root = fixture();
	packageFixture(root, "web", "export {};");
	packageFixture(root, "agent", "export {};", {
		dependencies: {
			"@amazme/web": "1.0.0",
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
		"codemode",
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
		"codemode",
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
		"codemode",
		'import "./old.js"; export { value } from "./extensionless"; type Shape = import("./types.js").Value; import "../../ai/src/index.ts";',
	);
	const failures = checkSourceContracts(root);
	assert.equal(failures.filter((failure) => failure.includes("must use .ts")).length, 3);
	assert.ok(failures.some((failure) => failure.includes("cross-package source import")));
});

test("package sources must not suspend module evaluation with await", () => {
	const root = fixture();
	const directory = packageFixture(root, "web", "export {};");
	writeFileSync(
		join(directory, "src/flow.ts"),
		'import { readFile } from "node:fs/promises";\nexport const value = await readFile("a");\nif (value) { for await (const part of value) { part; } }\nawait using handle = open();\n',
	);
	const failures = checkSourceContracts(root);
	assert.equal(failures.filter((failure) => failure.includes("must not await at module scope")).length, 3);
});

test("await inside functions, methods, and arrows does not suspend the module", () => {
	const root = fixture();
	const directory = packageFixture(root, "web", "export {};");
	writeFileSync(
		join(directory, "src/flow.ts"),
		"async function a() { await b(); }\nexport const c = async () => { await d(); };\nclass E { async f() { for await (const g of h) { g; } } }\n",
	);
	assert.deepEqual(checkSourceContracts(root), []);
});

test("only bins and shebang entries may await at module scope", () => {
	const root = fixture();
	const directory = packageFixture(root, "web", "export {};", { bin: { tool: "./dist/cli.js" } });
	writeFileSync(join(directory, "src/cli.ts"), 'await import("./index.ts");\n');
	writeFileSync(join(directory, "src/hook.ts"), '#!/usr/bin/env node\nawait import("./index.ts");\n');
	assert.deepEqual(checkSourceContracts(root), []);
});

test("foundations cannot depend upward and runtime dependency cycles are refused", () => {
	const root = fixture();
	packageFixture(root, "codemode", 'import type { Model } from "@amazme/web";', {
		dependencies: { "@amazme/web": "1.0.0" },
	});
	packageFixture(root, "web", "export const value = 1;", {
		dependencies: { "@amazme/codemode": "1.0.0" },
	});
	const failures = checkSourceContracts(root);
	assert.ok(failures.some((failure) => failure.includes("points upward")));
	assert.ok(failures.some((failure) => failure.includes("dependency cycle")));
});

test("manifest dependencies cannot point upward even when source does not import them", () => {
	const root = fixture();
	packageFixture(root, "codemode", "export const value = 1;", {
		dependencies: { "@amazme/web": "1.0.0" },
	});
	packageFixture(root, "web", "export const value = 1;");
	assert.ok(
		checkSourceContracts(root).some(
			(failure) => failure.startsWith("packages/codemode/package.json:") && failure.includes("points upward"),
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
	packageFixture(root, "web", "export const value = 1;");
	mkdirSync(join(root, "packages/web/src"), { recursive: true });
	writeFileSync(
		join(root, "packages/web/src/index.ts"),
		'import fs from "node:fs"; export const read = fs.readFileSync;',
	);
	const { failures } = await checkEntryContracts(root);
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
	assert.ok(
		failures.some((failure) => failure.startsWith("packages/web/src/index.ts:") && failure.includes("node:fs")),
	);
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
		"agent/CHANGELOG.md:5: section must be one of",
		'agent/CHANGELOG.md:13: "Added" is repeated or out of order',
		'agent/CHANGELOG.md:17: "Fixed" is repeated or out of order',
		'agent/CHANGELOG.md:17: "Fixed" has no entries',
		"agent/CHANGELOG.md:19: release heading must read",
		'ai/CHANGELOG.md: first line must be "# Changelog"',
		'ai/CHANGELOG.md:3: first section must be "## [Unreleased]"',
	])
		assert.ok(
			failures.some((failure) => failure.includes(fragment)),
			`missing ${fragment} in\n${failures.join("\n")}`,
		);
});

function buildConfigFixture(root, name, config) {
	mkdirSync(join(root, "packages", name), { recursive: true });
	writeFileSync(join(root, "packages", name, "tsconfig.build.json"), JSON.stringify(config));
}

test("build configs resolve workspace packages through node_modules, not paths", () => {
	const root = fixture();
	writeFileSync(join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true } }));
	buildConfigFixture(root, "agent", { extends: "../../tsconfig.base.json", compilerOptions: { outDir: "./dist" } });
	assert.deepEqual(checkBuildConfigs(root), []);
});

test("build configs reject paths in the package config and in configs it extends", () => {
	const root = fixture();
	writeFileSync(
		join(root, "tsconfig.base.json"),
		JSON.stringify({ compilerOptions: { paths: { "@amazme/web": ["x"] } } }),
	);
	buildConfigFixture(root, "agent", {
		extends: "../../tsconfig.base.json",
		compilerOptions: { paths: { "@amazme/web": ["../ai/dist/index.d.ts"] } },
	});
	buildConfigFixture(root, "client", { extends: "../../tsconfig.base.json" });
	buildConfigFixture(root, "web", { compilerOptions: { outDir: "./dist" } });
	const failures = checkBuildConfigs(root);
	assert.equal(failures.length, 2, failures.join("\n"));
	assert.ok(failures.some((failure) => failure.startsWith("packages/agent/tsconfig.build.json:")));
	assert.ok(failures.some((failure) => failure.startsWith("tsconfig.base.json:")));
});

function versionFixture(files) {
	const root = fixture();
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "amazme", version: "9.8.7" }));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

test("the release version is written only in package.json and changelogs", () => {
	const files = {
		"packages/a/src/driver.ts": 'const client = { version: "9.8.7" };\n',
		"packages/gui/README.md": "intro\n当前 `9.8.7`，tag v9.8.7。\n",
		".github/workflows/release.yml": "name: release 9.8.7\n",
		"packages/a/CHANGELOG.md": "## [9.8.7] - 2026-10-19\n",
		"packages/a/package.json": '{"version":"9.8.7"}',
		"package-lock.json": '{"version":"9.8.7"}',
		"packages/a/dist/index.js": 'const v = "9.8.7";\n',
		"packages/a/src/data.json": '{"model":"9.8.7"}',
		"packages/a/src/other.ts": 'const near = ["19.8.7", "9.8.71", "9.8.7.1", "9.8.70"];\n',
		"packages/codemode/README.md": "On Bun 9.8.7 the worker stays alive; a Bun\t9.8.7 build too.\n",
	};
	const root = versionFixture(files);
	const failures = checkVersionLiterals(root, Object.keys(files));
	assert.deepEqual(
		failures.map((failure) => failure.slice(0, failure.indexOf(": "))),
		[
			"packages/a/src/driver.ts:1",
			"packages/gui/README.md:2",
			"packages/gui/README.md:2",
			".github/workflows/release.yml:1",
		],
		failures.join("\n"),
	);
	assert.match(failures[0], /release version 9\.8\.7 is hand-written/);
});

test("the third-party allowance applies only right after the product name", () => {
	const files = { "docs/a.md": "Bundled 9.8.7\nBun: 9.8.7\nBun 9.8.7 and AmazMe 9.8.7\n" };
	const root = versionFixture(files);
	const failures = checkVersionLiterals(root, Object.keys(files));
	assert.deepEqual(
		failures.map((failure) => failure.slice(0, failure.indexOf(": "))),
		["docs/a.md:1", "docs/a.md:2", "docs/a.md:3"],
		failures.join("\n"),
	);
});

test("a version pinned to a scoped third-party package is not the release version", () => {
	const files = { "docs/a.md": "npx @modelcontextprotocol/conformance@9.8.7\nAmazMe@9.8.7\nvendor/pkg@9.8.7\n" };
	const root = versionFixture(files);
	const failures = checkVersionLiterals(root, Object.keys(files));
	assert.deepEqual(
		failures.map((failure) => failure.slice(0, failure.indexOf(": "))),
		["docs/a.md:2", "docs/a.md:3"],
		failures.join("\n"),
	);
});

test("by default the release-version rule reads only files git tracks", () => {
	const root = versionFixture({
		"src/tracked.ts": 'export const v = "9.8.7";\n',
		"src/scratch.ts": 'export const v = "9.8.7";\n',
	});
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "package.json", "src/tracked.ts"], { cwd: root });
	const failures = checkVersionLiterals(root);
	assert.deepEqual(
		failures.map((failure) => failure.slice(0, failure.indexOf(": "))),
		["src/tracked.ts:1"],
		failures.join("\n"),
	);
});

test("temp dir checks allow only packages/*/test/temp-dir.ts and reject bare mkdtemp", () => {
	const root = fixture();
	const aiTest = join(root, "packages", "ai", "test");
	mkdirSync(aiTest, { recursive: true });
	const helper =
		'import { mkdtempSync } from "node:fs";\nexport const createTempDir = (prefix) => mkdtempSync("/tmp/" + prefix);\n';
	writeFileSync(join(aiTest, "temp-dir.ts"), helper);
	writeFileSync(
		join(aiTest, "leaky.test.ts"),
		'import { mkdtempSync } from "node:fs";\nconst dir = mkdtempSync("/tmp/x-");\n',
	);
	mkdirSync(join(aiTest, "nested"), { recursive: true });
	writeFileSync(
		join(aiTest, "nested", "temp-dir.ts"),
		'import { mkdtempSync } from "node:fs";\nconst dir = mkdtempSync("/tmp/nested-");\n',
	);
	const failures = checkTempDirUsage(root);
	assert.equal(failures.length, 2, failures.join("\n"));
	assert.ok(failures.some((message) => message.includes("leaky.test.ts:")));
	assert.ok(failures.some((message) => message.includes("nested/temp-dir.ts:")));
	assert.equal(failures.filter((message) => message.includes("/test/temp-dir.ts:")).length, 0);
});

test("temp dir helpers match the client vitest copy; tui may differ", () => {
	const root = fixture();
	const helper =
		'import { mkdtempSync } from "node:fs";\nexport const createTempDir = (prefix) => mkdtempSync("/tmp/" + prefix);\n';
	mkdirSync(join(root, "packages", "coding-agent", "test"), { recursive: true });
	mkdirSync(join(root, "packages", "web", "test"), { recursive: true });
	mkdirSync(join(root, "packages", "tui", "test"), { recursive: true });
	writeFileSync(join(root, "packages", "coding-agent", "test", "temp-dir.ts"), helper);
	writeFileSync(join(root, "packages", "web", "test", "temp-dir.ts"), helper + "// drift\n");
	writeFileSync(
		join(root, "packages", "tui", "test", "temp-dir.ts"),
		'import type { TestContext } from "node:test";\nexport const createTempDir = (t, prefix) => prefix;\n',
	);
	const failures = checkTempDirUsage(root);
	assert.equal(failures.length, 1, failures.join("\n"));
	assert.ok(failures[0].includes("packages/web/test/temp-dir.ts:"));
	assert.ok(failures[0].includes("byte-for-byte"));
});

test("package sources may not call tmpdir() outside the allowlist", () => {
	const root = fixture();
	const src = join(root, "packages", "coding-agent", "src");
	mkdirSync(join(src, "utils"), { recursive: true });
	mkdirSync(join(src, "durable"), { recursive: true });
	writeFileSync(
		join(src, "utils", "output-files.ts"),
		'import { tmpdir } from "node:os";\nexport const path = () => join(tmpdir(), "amazme-mcp-x");\n',
	);
	writeFileSync(join(src, "utils", "os-call.ts"), 'import os from "node:os";\nexport const dir = os.tmpdir();\n');
	// A variable named tmpdir is not a call.
	writeFileSync(join(src, "utils", "remote.ts"), "export const join = (tmpdir) => tmpdir + '/x';\n");
	writeFileSync(
		join(src, "utils", "clipboard.ts"),
		'import { tmpdir } from "node:os";\nexport const dir = join(tmpdir(), "amazme-session-artifacts-x");\n',
	);
	const failures = checkTempDirUsage(root, {
		"packages/coding-agent/src/utils/clipboard.ts": "--no-session artifact directory",
	});
	assert.equal(failures.length, 2, failures.join("\n"));
	assert.ok(failures.some((message) => message.startsWith("packages/coding-agent/src/utils/output-files.ts:2:")));
	assert.ok(failures.some((message) => message.startsWith("packages/coding-agent/src/utils/os-call.ts:2:")));
	assert.ok(failures.every((message) => message.includes("artifactDirectory")));
});

test("an allowlisted source that stops calling tmpdir() must leave the allowlist", () => {
	const root = fixture();
	const src = join(root, "packages", "coding-agent", "src", "utils");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "clipboard.ts"), "export const dir = '/var/sessions';\n");
	const failures = checkTempDirUsage(root, {
		"packages/coding-agent/src/utils/clipboard.ts": "--no-session artifact directory",
	});
	assert.equal(failures.length, 1, failures.join("\n"));
	assert.ok(failures[0].includes("remove it from sourceTempDirAllowlist"));
});

test("an allowlisted source file that no longer exists must leave the allowlist", () => {
	const root = fixture();
	const src = join(root, "packages", "coding-agent", "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "kept.ts"), 'import { tmpdir } from "node:os";\nexport const dir = tmpdir();\n');
	const allowed = {
		"packages/coding-agent/src/utils/clipboard.ts": "--no-session artifact directory",
		"packages/coding-agent/src/kept.ts": "still calls it",
	};
	// The walk never visits a file that is gone, so only the file check can see this entry.
	assert.deepEqual(checkTempDirUsage(root, allowed), []);
	const failures = checkTempDirAllowlistFiles(root, allowed);
	assert.equal(failures.length, 1, failures.join("\n"));
	assert.ok(failures[0].startsWith("packages/coding-agent/src/utils/clipboard.ts:"));
	assert.ok(failures[0].includes("no such source file"));
	assert.ok(failures[0].includes("remove it from sourceTempDirAllowlist"));
});

test("allowlist entries are exact source files with a reason", () => {
	const root = fixture();
	const src = join(root, "packages", "coding-agent", "src", "utils");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "scratch.ts"), 'import { tmpdir } from "node:os";\nexport const dir = tmpdir();\n');
	const failures = checkTempDirUsage(root, {
		"packages/coding-agent/src/utils": "a whole directory",
		"packages/coding-agent/src/utils/*.ts": "a pattern",
		"packages/coding-agent/src/../src/utils/scratch.ts": "a path that leaves and re-enters",
		"packages/coding-agent/src/utils/scratch.ts": "  ",
	});
	assert.equal(failures.length, 4, failures.join("\n"));
	assert.equal(
		failures.filter((message) => message.includes("one exact packages/<pkg>/src/... source file")).length,
		3,
	);
	assert.ok(
		failures.includes("packages/coding-agent/src/utils/scratch.ts: sourceTempDirAllowlist entry needs a reason"),
	);
});

test("every real allowlist entry is an existing source file with a reason that still calls tmpdir()", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	for (const [file, reason] of Object.entries(sourceTempDirAllowlist)) {
		assert.match(file, /^packages\/[^/]+\/src\/.+\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/);
		assert.ok(reason.trim().length > 0, file);
		assert.ok(existsSync(join(repoRoot, file)), `${file} does not exist`);
	}
	assert.deepEqual(checkTempDirUsage(repoRoot), []);
	assert.deepEqual(checkTempDirAllowlistFiles(repoRoot), []);
});

test("the source allowlist retains clipboard scratch but rejects session output", () => {
	assert.ok(Object.hasOwn(sourceTempDirAllowlist, "packages/coding-agent/src/utils/clipboard.ts"));
	assert.ok(!Object.hasOwn(sourceTempDirAllowlist, "packages/coding-agent/src/utils/output-files.ts"));
	assert.ok(!Object.keys(sourceTempDirAllowlist).some((file) => file.includes("/mcp/")));
});

test("headless and interactive cannot import each other", () => {
	const root = fixture();
	packageFixture(root, "coding-agent", "export {};");
	packageSource(
		root,
		"coding-agent",
		"modes/headless/run.ts",
		'import { handleLine } from "../interactive/session.ts";\nexport const run = handleLine;',
	);
	packageSource(
		root,
		"coding-agent",
		"modes/interactive/session.ts",
		'import { runPythonHeadless } from "../headless/run.ts";\nexport const line = runPythonHeadless;',
	);
	const failures = checkSourceContracts(root);
	const direction = failures.filter((failure) => failure.includes("breaks a CLI module direction"));
	assert.equal(direction.length, 2, failures.join("\n"));
	assert.ok(
		direction.some((failure) => failure.includes("headless and interactive share client and connection")),
		failures.join("\n"),
	);
	assert.ok(
		direction.some((failure) => failure.includes("interactive and headless share client and connection")),
		failures.join("\n"),
	);
	assert.ok(direction.every((failure) => failure.includes("run.ts")));
});

test("client, connection and CLI helpers cannot reach back into a presentation mode", () => {
	const root = fixture();
	packageFixture(root, "coding-agent", "export {};");
	packageSource(
		root,
		"coding-agent",
		"client/host-client.ts",
		'import { theme } from "../modes/interactive/theme/theme.ts";\nexport const client = theme;',
	);
	packageSource(
		root,
		"coding-agent",
		"connection/connection.ts",
		'import { runPythonSessionTui } from "../modes/interactive/session.ts";\nexport const connect = runPythonSessionTui;',
	);
	packageSource(
		root,
		"coding-agent",
		"cli/args.ts",
		'import { runPythonHeadless } from "../modes/headless/run.ts";\nexport const parse = runPythonHeadless;',
	);
	const failures = checkSourceContracts(root);
	const direction = failures.filter((failure) => failure.includes("breaks a CLI module direction"));
	assert.equal(direction.length, 3, failures.join("\n"));
	assert.ok(direction.some((failure) => failure.includes("client stays below connection")));
	assert.ok(direction.some((failure) => failure.includes("connection may use client")));
	assert.ok(direction.some((failure) => failure.includes("CLI argument and file helpers stay independent")));
});

test("the split CLI layout passes when client, connection and both modes keep their direction", () => {
	const root = fixture();
	packageFixture(root, "coding-agent", 'export { HostClient } from "./client/host-client.ts";');
	packageSource(root, "coding-agent", "client/types.ts", "export interface RunOptions {\n\treadonly cwd: string;\n}");
	packageSource(
		root,
		"coding-agent",
		"client/host-client.ts",
		'import type { RunOptions } from "./types.ts";\nexport class HostClient {\n\tconstructor(readonly options: RunOptions) {}\n}',
	);
	packageSource(
		root,
		"coding-agent",
		"connection/connection.ts",
		'import { HostClient } from "../client/host-client.ts";\nexport const connect = (options: { cwd: string }) => new HostClient(options);',
	);
	packageSource(root, "coding-agent", "cli/args.ts", "export interface Args {\n\treadonly cwd: string;\n}");
	packageSource(
		root,
		"coding-agent",
		"modes/headless/run.ts",
		'import type { Args } from "../../cli/args.ts";\nimport { connect } from "../../connection/connection.ts";\nexport const run = (args: Args) => connect(args);',
	);
	packageSource(
		root,
		"coding-agent",
		"modes/interactive/session.ts",
		'import { connect } from "../../connection/connection.ts";\nexport const session = (cwd: string) => connect({ cwd });',
	);
	packageSource(
		root,
		"coding-agent",
		"main.ts",
		'import { run } from "./modes/headless/run.ts";\nimport { session } from "./modes/interactive/session.ts";\nexport const main = () => [run({ cwd: "" }), session("")];',
	);
	assert.deepEqual(checkSourceContracts(root), []);
});
