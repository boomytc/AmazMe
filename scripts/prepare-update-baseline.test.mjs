import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumerLock } from "./package-artifacts.mjs";

for (const version of ["8.6.0", "8.6.0-rc.1"]) test("synthetic baseline for " + version + " keeps locks aligned and restores exact original files", t => {
	const root = mkdtempSync(join(tmpdir(), "amazme-baseline-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "scripts")); mkdirSync(join(root, "packages/gui"), { recursive: true });
	const script = join(root, "scripts/prepare-update-baseline.mjs");
	copyFileSync(new URL("./prepare-update-baseline.mjs", import.meta.url), script);
	const manifest = JSON.stringify({ name: "@amazme/gui", version }, null, 2) + "\n";
	const source = { lockfileVersion: 3, packages: { "node_modules/@amazme/gui": { link: true, resolved: "packages/gui" }, "packages/gui": { name: "@amazme/gui", version } } };
	const originalLock = JSON.stringify(source, null, 2) + "\n";
	writeFileSync(join(root, "packages/gui/package.json"), manifest); writeFileSync(join(root, "package-lock.json"), originalLock);
	execFileSync(process.execPath, [script]);
	const baseline = JSON.parse(readFileSync(join(root, "packages/gui/package.json"), "utf8"));
	const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	const artifacts = new Map([["@amazme/gui", { version: baseline.version, integrity: "sha512-fixture" }]]);
	assert.equal(baseline.version, "8.5.9");
	assert.equal(consumerLock(locked, artifacts, { dependencies: { "@amazme/gui": "file:gui.tgz" }, overrides: { "@amazme/gui": "file:gui.tgz" } }).packages["node_modules/@amazme/gui"].version, baseline.version);
	execFileSync(process.execPath, [script, "--restore"]);
	assert.equal(readFileSync(join(root, "packages/gui/package.json"), "utf8"), manifest);
	assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), originalLock);
});
