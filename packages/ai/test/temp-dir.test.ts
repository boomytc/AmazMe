import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";

describe("createTempDir", () => {
	it("creates a directory under tmpdir and removes it after the test", () => {
		const before = new Set(
			readdirSync(tmpdir()).filter((name) => name.startsWith("pi-temp-dir-helper-")),
		);
		const dir = createTempDir("pi-temp-dir-helper-");
		expect(existsSync(dir)).toBe(true);
		expect(dir.startsWith(tmpdir())).toBe(true);
		// onTestFinished runs after this test body; assert creation side only here.
		const during = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-temp-dir-helper-"));
		expect(during.some((name) => !before.has(name))).toBe(true);
	});

	it("does not leave pi-temp-dir-helper-* from the previous test", () => {
		const leftover = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-temp-dir-helper-"));
		expect(leftover).toEqual([]);
	});
});
