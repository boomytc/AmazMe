import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";

let previousDir = "";

describe("createTempDir", () => {
	it("creates a directory under tmpdir", () => {
		const dir = createTempDir("pi-temp-dir-helper-");
		previousDir = dir;
		expect(existsSync(dir)).toBe(true);
		expect(dir.startsWith(tmpdir())).toBe(true);
	});

	it("removes the directory from the previous test", () => {
		expect(previousDir.length).toBeGreaterThan(0);
		expect(existsSync(previousDir)).toBe(false);
	});
});
