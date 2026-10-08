import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	createPackageArtifacts,
	consumerLock,
	installPackageArtifacts,
	readPackageArtifacts,
	runtimePackages,
	verifyInstalledArtifacts,
	verifyPackedFiles,
	workspacePackages,
} from "./package-artifacts.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(prefix = "amazme-artifacts-test-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	mkdirSync(join(root, "packages"));
	return root;
}

function packageFixture(root, name, dependencies = {}) {
	const directory = join(root, "packages", name);
	mkdirSync(join(directory, "dist"), { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: `@amazme/${name}`,
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
			},
			files: ["dist"],
			dependencies,
			scripts: {
				prepack: "node -e 'process.exit(73)'",
				postinstall: "node -e 'process.exit(74)'",
			},
		}),
	);
	writeFileSync(
		join(directory, "dist/index.js"),
		name === "product"
			? 'import { value } from "@amazme/base"; export const result = value + 1;\n'
			: "export const value = 41;\n",
	);
	writeFileSync(
		join(directory, "dist/index.d.ts"),
		`export declare const ${name === "product" ? "result" : "value"}: number;\n`,
	);
	return directory;
}

test("runtime closure is dependency ordered and excludes unrelated packages and examples", () => {
	const root = fixture();
	packageFixture(root, "base");
	const product = packageFixture(root, "product", { "@amazme/base": "^1.0.0" });
	packageFixture(root, "unused");
	mkdirSync(join(product, "examples/demo"), { recursive: true });
	writeFileSync(join(product, "examples/demo/package.json"), '{"name":"@amazme/example"}');
	assert.deepEqual(
		runtimePackages(workspacePackages(root), ["@amazme/product"]).map((pkg) => pkg.manifest.name),
		["@amazme/base", "@amazme/product"],
	);
});

test("runtime closure refuses missing local dependencies and cycles", () => {
	const root = fixture();
	packageFixture(root, "base", { "@amazme/product": "^1.0.0" });
	assert.throws(() => runtimePackages(workspacePackages(root), ["@amazme/base"]), /Unknown workspace package/);
	packageFixture(root, "product", { "@amazme/base": "^1.0.0" });
	assert.throws(() => runtimePackages(workspacePackages(root), ["@amazme/base"]), /dependency cycle/);
});

test("workspace discovery rejects duplicate package identities", () => {
	const root = fixture();
	packageFixture(root, "base");
	const duplicate = packageFixture(root, "duplicate");
	const path = join(duplicate, "package.json");
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	manifest.name = "@amazme/base";
	writeFileSync(path, JSON.stringify(manifest));
	assert.throws(() => workspacePackages(root), /duplicate workspace package/);
});

test("pack validation checks runtime, declaration, wildcard, and binary entries against the tarball", () => {
	const manifest = {
		name: "@amazme/test",
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		bin: { test: "dist/cli.js" },
		exports: {
			"./items/*": { import: "./dist/items/*.js" },
			".": { source: "./src/index.ts", import: "./dist/index.js" },
		},
	};
	const files = ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "dist/items/foo.js"].map((path) => ({ path }));
	assert.doesNotThrow(() => verifyPackedFiles(manifest, files));
	assert.throws(
		() =>
			verifyPackedFiles(
				manifest,
				files.filter((file) => !file.path.endsWith("cli.js")),
			),
		/missing packed entry/,
	);
	assert.throws(
		() =>
			verifyPackedFiles(
				manifest,
				files.filter((file) => !file.path.includes("items/")),
			),
		/no packed files/,
	);
});

test("real npm pack and offline install use the complete local closure without running lifecycle scripts", () => {
	const root = fixture("amazme artifacts # ");
	packageFixture(root, "base");
	packageFixture(root, "product", { "@amazme/base": "^1.0.0" });
	const directory = join(root, "consumer");
	const artifacts = createPackageArtifacts({
		repoRoot: root,
		directory: join(root, "artifact files #"),
		packageNames: ["@amazme/product"],
	});
	installPackageArtifacts({
		artifacts,
		directory,
		packageNames: ["@amazme/product"],
		offline: true,
	});
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'import assert from "node:assert/strict"; import { result } from "@amazme/product"; assert.equal(result, 42);',
		],
		{ cwd: directory },
	);
	const lockPath = join(directory, "package-lock.json");
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	lock.packages["node_modules/unrelated"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/unrelated.tgz" };
	lock.packages["node_modules/@amazme/product"].peerDependencies = { "missing-optional-peer": "*" };
	lock.packages["node_modules/@amazme/product"].peerDependenciesMeta = { "missing-optional-peer": { optional: true } };
	const lockedDirectory = join(root, "locked-consumer");
	installPackageArtifacts({
		artifacts,
		directory: lockedDirectory,
		packageNames: ["@amazme/product"],
		dependencyLock: lock,
		offline: true,
	});
	const installedLock = JSON.parse(readFileSync(join(lockedDirectory, "package-lock.json"), "utf8"));
	assert.equal(installedLock.packages["node_modules/unrelated"], undefined);
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'import assert from "node:assert/strict"; import { result } from "@amazme/product"; assert.equal(result, 42);',
		],
		{ cwd: lockedDirectory },
	);
	lock.packages["node_modules/@amazme/base"].resolved = "https://registry.npmjs.org/registry-copy.tgz";
	writeFileSync(lockPath, JSON.stringify(lock));
	assert.throws(
		() =>
			verifyInstalledArtifacts({
				artifacts,
				directory,
				packageNames: ["@amazme/product"],
			}),
		/does not match/,
	);
});

test("locked consumers refuse absent required dependencies instead of resolving an untested version", () => {
	assert.throws(
		() => consumerLock({ lockfileVersion: 3, packages: {} }, new Map(), { dependencies: { missing: "1.0.0" } }),
		/missing dependency/,
	);
});

test("locked consumers skip optional foreign-platform subtrees with absent transitive dependencies", () => {
	const source = {
		lockfileVersion: 3,
		packages: {
			"node_modules/owner": { version: "1.0.0", optionalDependencies: { foreign: "1.0.0" } },
			"node_modules/foreign": {
				version: "1.0.0",
				os: [process.platform === "win32" ? "darwin" : "win32"],
				dependencies: { unavailable: "1.0.0" },
			},
		},
	};
	const lock = consumerLock(source, new Map(), { dependencies: { owner: "1.0.0" } });
	assert.deepEqual(Object.keys(lock.packages), ["", "node_modules/owner"]);
});

test("workspace-local dependency versions retain their package scope after installation from tarballs", () => {
	const source = {
		lockfileVersion: 3,
		packages: {
			"node_modules/@amazme/base": { link: true, resolved: "packages/base" },
			"packages/base": { version: "1.0.0", dependencies: { shared: "2.0.0" } },
			"packages/base/node_modules/shared": { version: "2.0.0" },
			"node_modules/shared": { version: "1.0.0" },
		},
	};
	const artifacts = new Map([["@amazme/base", { version: "1.0.0", integrity: "sha512-fixture" }]]);
	const lock = consumerLock(source, artifacts, {
		dependencies: { "@amazme/base": "file:../base.tgz", shared: "1.0.0" },
		overrides: { "@amazme/base": "file:../base.tgz" },
	});
	assert.equal(lock.packages["node_modules/@amazme/base/node_modules/shared"].version, "2.0.0");
	assert.equal(lock.packages["node_modules/shared"].version, "1.0.0");
	assert.equal(lock.packages["packages/base/node_modules/shared"], undefined);
});

test("artifact verification rejects modified tarballs and occupied output directories", () => {
	const root = fixture();
	packageFixture(root, "base");
	const directory = join(root, "artifacts");
	const artifacts = createPackageArtifacts({
		repoRoot: root,
		directory,
		packageNames: ["@amazme/base"],
	});
	assert.throws(
		() =>
			createPackageArtifacts({
				repoRoot: root,
				directory,
				packageNames: ["@amazme/base"],
			}),
		/not empty/,
	);
	assert.throws(
		() =>
			createPackageArtifacts({
				repoRoot: root,
				directory: root,
				packageNames: ["@amazme/base"],
			}),
		/contain the repository/,
	);
	writeFileSync(artifacts.get("@amazme/base").tarball, "replaced");
	assert.throws(() => readPackageArtifacts(join(directory, "manifest.json")), /integrity mismatch/);
});
