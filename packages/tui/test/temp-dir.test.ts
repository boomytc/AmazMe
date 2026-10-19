import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { createTempDir } from "./temp-dir.ts";

let previousDir = "";
let suiteDir = "";

describe("createTempDir", () => {
	it("creates a directory under tmpdir", (t) => {
		const dir = createTempDir(t, "pi-temp-dir-helper-");
		previousDir = dir;
		assert.equal(existsSync(dir), true);
		assert.ok(dir.startsWith(tmpdir()));
	});

	it("removes the directory from the previous test", () => {
		assert.ok(previousDir.length > 0);
		assert.equal(existsSync(previousDir), false);
	});
});

describe("createTempDir suite scope", () => {
	describe("holds the directory for the suite", () => {
		suiteDir = createTempDir("suite", "pi-temp-dir-suite-");
		it("keeps the directory while the suite runs", () => {
			assert.equal(existsSync(suiteDir), true);
		});
	});

	it("removes the suite directory after the suite finishes", () => {
		assert.ok(suiteDir.length > 0);
		assert.equal(existsSync(suiteDir), false);
	});
});
